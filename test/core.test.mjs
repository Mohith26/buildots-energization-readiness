import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  rng, effectiveCrews, topoOrder, paceModel, simulateHall, forecastHall, quantile, probBy, expectedLateMW,
  planRecovery, applyAlloc, brier, reliability, activityPaths, hallUsesTrade,
} from '../src/core.js';
import { ACTIVITIES, buildProject, buildModels, projectView, evaluateProject } from '../data/generate.mjs';

const acts = Object.fromEntries(ACTIVITIES.map((a) => [a.id, a]));
const order = topoOrder(ACTIVITIES);

test('topological order respects every predecessor and rejects cycles', () => {
  const pos = Object.fromEntries(order.map((id, i) => [id, i]));
  for (const a of ACTIVITIES) for (const p of a.preds) assert.ok(pos[p] < pos[a.id], `${p} before ${a.id}`);
  assert.throws(() => topoOrder([{ id: 'A', preds: ['B'] }, { id: 'B', preds: ['A'] }]), /cycle/);
});

test('stacking: effective crews are concave and 1 crew = 1', () => {
  assert.equal(effectiveCrews(1), 1);
  assert.equal(effectiveCrews(0), 0);
  assert.ok(effectiveCrews(4) < 4 && effectiveCrews(4) > effectiveCrews(3));
  assert.ok(effectiveCrews(2) - effectiveCrews(1) > effectiveCrews(5) - effectiveCrews(4));
});

test('pace model recovers a known log-rate and shrinks toward the prior with little data', () => {
  const r = rng(1);
  const obs = Array.from({ length: 60 }, () => ({ units: 50 * Math.exp(0.2 * r.normal()), eff: 1 }));
  const m = paceModel(obs, { mu: Math.log(80), tau: 0.3 });
  assert.ok(Math.abs(Math.exp(m.mu) - 50) < 4, `mu ${Math.exp(m.mu)}`);
  const few = paceModel(obs.slice(0, 2), { mu: Math.log(80), tau: 0.05, sigma: 0.2 });
  assert.ok(Math.exp(few.mu) > 70, 'strong prior dominates two observations');
  assert.equal(paceModel([], { mu: 1, tau: 0.5 }).mu, 1);
});

test('deterministic single-activity hall finishes in ceil(qty / rate) weeks', () => {
  const a = { X: { id: 'X', trade: 'T', preds: [] } };
  const models = { X: { mu: Math.log(10), sdMu: 0, sigma: 0 } };
  const w = simulateHall(a, ['X'], { remaining: { X: 95 } }, { T: 1 }, models, rng(1));
  assert.equal(w, 10);
  assert.equal(simulateHall(a, ['X'], { remaining: { X: 95 } }, { T: 0 }, models, rng(1), 50), Infinity);
});

test('predecessors block successors within the same week (finish-to-start)', () => {
  const a = { A: { id: 'A', trade: 'T', preds: [] }, B: { id: 'B', trade: 'U', preds: ['A'] } };
  const models = { A: { mu: Math.log(10), sdMu: 0, sigma: 0 }, B: { mu: Math.log(10), sdMu: 0, sigma: 0 } };
  // A takes 1 week, B cannot start until week 2, takes 1 week -> 2
  assert.equal(simulateHall(a, ['A', 'B'], { remaining: { A: 10, B: 10 } }, { T: 1, U: 1 }, models, rng(1)), 2);
});

test('more crews never slow a hall down (monotonicity, randomized with CRN)', () => {
  const p = projectView(buildProject(3));
  const models = buildModels(buildProject(3));
  for (let hi = 0; hi < 3; hi++) {
    const h = p.halls[hi];
    const base = forecastHall(acts, order, h.state, h.crews, models[hi], { sims: 200, seed: 9 });
    const more = forecastHall(acts, order, h.state, { ...h.crews, Electrical: h.crews.Electrical + 2 }, models[hi], { sims: 200, seed: 9 });
    assert.ok(quantile(more, 0.5) <= quantile(base, 0.5) + 1e-9);
  }
});

test('probBy and quantile agree on sorted samples', () => {
  const s = [1, 2, 2, 3, 5, 8, Infinity];
  assert.equal(probBy(s, 2), 3 / 7);
  assert.equal(probBy(s, 0), 0);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
});

test('expected late MW-weeks counts only lateness, weighted by MW', () => {
  assert.equal(expectedLateMW([8, 10, 12], 10, 4), (4 * (0 + 0 + 2)) / 3);
  assert.equal(expectedLateMW([5, 6], 10, 4), 0);
});

test('greedy planner never makes the expected late MW-weeks worse and respects the crew pool', () => {
  const proj = buildProject(5);
  const p = projectView(proj), models = buildModels(proj);
  const pool = { Electrical: 2, Mechanical: 1 };
  const plan = planRecovery(p, models, pool, { sims: 120, seed: 3 });
  const used = {};
  plan.alloc.forEach((a) => Object.entries(a).forEach(([t, n]) => { used[t] = (used[t] || 0) + n; }));
  for (const [t, n] of Object.entries(used)) assert.ok(n <= pool[t], `${t} used ${n}`);
  const b = plan.before.reduce((x, y) => x + y, 0), a = plan.after.reduce((x, y) => x + y, 0);
  assert.ok(a <= b + 1e-9);
  plan.steps.forEach((s) => assert.ok(s.gain > 0));
});

test('applyAlloc adds crews without mutating the input', () => {
  const halls = [{ crews: { Electrical: 3 } }];
  const out = applyAlloc(halls, [{ Electrical: 2, Mechanical: 1 }]);
  assert.deepEqual(out[0].crews, { Electrical: 5, Mechanical: 1 });
  assert.deepEqual(halls[0].crews, { Electrical: 3 });
});

test('Brier score and reliability bins', () => {
  assert.equal(brier([1, 0, 0.5], [1, 0, 1]), 0.25 / 3);
  const rel = reliability([0.05, 0.15, 0.95, 0.9], [0, 0, 1, 1], 2);
  assert.equal(rel[0].n, 2); assert.equal(rel[1].y, 1);
  assert.throws(() => brier([0.1], []));
});

test('calibration property: forecasts from the true model are reliable (randomized)', () => {
  // When the model equals the truth, P(on time) should match the realized rate.
  const a = { X: { id: 'X', trade: 'T', preds: [] } };
  const r = rng(21);
  const ps = [], ys = [];
  for (let i = 0; i < 300; i++) {
    const models = { X: { mu: Math.log(10), sdMu: 0, sigma: 0.3 } };
    const rem = 60 + 60 * r();
    const f = forecastHall(a, ['X'], { remaining: { X: rem } }, { T: 1 }, models, { sims: 200, seed: 100 + i });
    ps.push(probBy(f, 9));
    const real = forecastHall(a, ['X'], { remaining: { X: rem } }, { T: 1 }, models, { sims: 1, seed: 99999 + i })[0];
    ys.push(real <= 9 ? 1 : 0);
  }
  const meanP = ps.reduce((x, y) => x + y, 0) / ps.length, meanY = ys.reduce((x, y) => x + y, 0) / ys.length;
  assert.ok(Math.abs(meanP - meanY) < 0.07, `${meanP} vs ${meanY}`);
});

test('activity paths are monotone non-increasing in remaining quantity', () => {
  const proj = buildProject(2), p = projectView(proj), models = buildModels(proj);
  const h = p.halls[1];
  const id = order.find((x) => h.state.remaining[x] > 0);
  const path = activityPaths(acts, order, h.state, h.crews, models[1], id, { sims: 80, horizon: 30 });
  for (let w = 1; w < 30; w++) assert.ok(path.p50[w] <= path.p50[w - 1] + 1e-9);
  assert.ok(hallUsesTrade(acts, h.state, acts[id].trade));
});

test('demo project file is reproducible from its seed', () => {
  const demo = JSON.parse(readFileSync(new URL('../data/project.json', import.meta.url)));
  const proj = buildProject(demo.seed);
  proj.halls.forEach((h, i) => {
    assert.equal(demo.halls[i].dueWeek, h.dueWeek);
    for (const [k, v] of Object.entries(h.remaining)) assert.ok(Math.abs(demo.halls[i].remaining[k] - v) < 1e-2);
  });
});

test('headline numbers in results.json reproduce: per-project rows recompute and aggregate', () => {
  const res = JSON.parse(readFileSync(new URL('../data/results.json', import.meta.url)));
  for (const s of [1, 2, 3]) {
    const e = evaluateProject(s);
    const row = res.per_project.find((x) => x.seed === s);
    assert.deepEqual(e.late, row.late);
    assert.deepEqual(e.halls.map((h) => h.onTime), row.y);
  }
  const ps = res.per_project.flatMap((x) => x.p), ys = res.per_project.flatMap((x) => x.y);
  assert.ok(Math.abs(brier(ps, ys) - res.forecast.brier_model) < 1e-3);
  const top = reliability(ps, ys, 5)[4];
  assert.ok(Math.abs(top.y - res.forecast.reliability[4].y) < 1e-3);
  const mean = (k) => res.per_project.reduce((a, x) => a + x.late[k], 0) / res.per_project.length;
  assert.ok(Math.abs(1 - mean('greedy') / mean('none') - res.recovery.reduction_greedy) < 1e-3);
  assert.ok(res.forecast.brier_model < res.forecast.brier_recent_pace);
});
