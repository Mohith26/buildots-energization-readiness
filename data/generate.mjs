// Seeded generator for the Energization Readiness demo.
// Writes data/project.json (one data-center project at week 24) and
// data/results.json (backtest of forecasts and recovery plans).
// Run: node data/generate.mjs
import { writeFileSync } from 'node:fs';
import {
  rng, effectiveCrews, topoOrder, paceModel, forecastHall, probBy, quantile, expectedLateMW,
  planRecovery, mostBehindFirst, applyAlloc, brier, reliability, recentPace, buildPaceModels,
} from '../src/core.js';

// Data-hall fit-out network. Quantities and crew rates are illustrative,
// sized for a ~4 MW hall; `rate` is the typical achieved output per crew-week.
// `bench` = achieved / planned pace, seeded from Buildots' published Data
// Center MEP Benchmarks (2026): HVAC 76.9%, electrical containment 59.4%,
// domestic water 44.9% of required pace; planned-vs-actual gap 20-50%.
// Activities without a published figure use 0.75 (assumption).
export const ACTIVITIES = [
  ['FLR', 'Raised floor & slab sealing', 'Interiors', 1200, 'm²', 260, [], 0.75],
  ['CON', 'Hot-aisle containment', 'Interiors', 40, 'pods', 8, ['FLR'], 0.75],
  ['PIP', 'Chilled-water piping', 'Mechanical', 900, 'm', 110, ['FLR'], 0.769],
  ['CRH', 'CRAH / fan-wall units', 'Mechanical', 16, 'pcs', 3, ['PIP'], 0.769],
  ['FSP', 'Fire suppression heads', 'Fire Protection', 420, 'pcs', 90, ['FLR'], 0.75],
  ['BUS', 'Overhead busway', 'Electrical', 600, 'm', 70, ['CON'], 0.594],
  ['TRY', 'Cable tray', 'Electrical', 1500, 'm', 180, ['CON'], 0.594],
  ['PDU', 'PDUs & RPPs', 'Electrical', 24, 'pcs', 4, ['BUS'], 0.75],
  ['BMS', 'BMS & EPMS points', 'Controls', 1800, 'pts', 400, ['TRY'], 0.75],
  ['L3', 'Commissioning L3 (pre-functional)', 'Commissioning', 160, 'checklists', 45, ['PDU', 'CRH', 'FSP', 'BMS'], 0.75],
  ['L4', 'Commissioning L4 (functional)', 'Commissioning', 60, 'tests', 18, ['L3'], 0.75],
  ['L5', 'L5 integrated systems test', 'Commissioning', 1, 'IST', 0.45, ['L4'], 0.75],
].map(([id, name, trade, qty, unit, rate, preds, bench]) => ({ id, name, trade, qty, unit, rate, preds, bench, planRate: Math.round((rate / bench) * 100) / 100 }));

export const TRADES = ['Interiors', 'Mechanical', 'Electrical', 'Fire Protection', 'Controls', 'Commissioning'];
export const BASE_CREWS = { Interiors: 2, Mechanical: 2, Electrical: 3, 'Fire Protection': 1, Controls: 1, Commissioning: 1 };
export const NOW = 24;
export const POOL = { Electrical: 3, Mechanical: 2, Commissioning: 1 };

const acts = Object.fromEntries(ACTIVITIES.map((a) => [a.id, a]));
const order = topoOrder(ACTIVITIES);

// Run the true process for a hall from its start week to `until`, recording
// weekly capture observations (units installed, effective crew-weeks).
function runTrue(hall, trueRates, sigma, r, until) {
  const rem = Object.fromEntries(ACTIVITIES.map((a) => [a.id, a.qty]));
  const obs = Object.fromEntries(ACTIVITIES.map((a) => [a.id, []]));
  const byTrade = {};
  for (const id of order) (byTrade[acts[id].trade] ||= []).push(id);
  let finish = Infinity;
  for (let w = hall.start + 1; w <= until; w++) {
    const startDone = Object.fromEntries(order.map((id) => [id, rem[id] <= 1e-9]));
    for (const t of Object.keys(byTrade)) {
      let cap = effectiveCrews(hall.crews[t] || 0);
      for (const id of byTrade[t]) {
        if (cap <= 1e-9) break;
        if (rem[id] <= 1e-9 || !acts[id].preds.every((p) => startDone[p])) continue;
        const per = trueRates[id] * Math.exp(sigma * r.normal() - sigma * sigma / 2);
        const use = Math.min(cap, rem[id] / per);
        const units = use * per;
        rem[id] = Math.max(0, rem[id] - units);
        cap -= use;
        obs[id].push({ week: w, units: Math.round(units * 100) / 100, eff: Math.round(use * 1000) / 1000 });
      }
    }
    if (finish === Infinity && order.every((id) => rem[id] <= 1e-9)) finish = w;
  }
  return { rem, obs, finish };
}

export function buildProject(seed) {
  const r = rng(seed);
  const projFactor = Math.exp(0.1 * r.normal());
  const halls = [];
  for (let h = 0; h < 6; h++) {
    const hallFactor = projFactor * Math.exp(0.12 * r.normal());
    const trueRates = Object.fromEntries(ACTIVITIES.map((a) => [a.id, a.rate * hallFactor * Math.exp(0.16 * r.normal())]));
    const crews = { ...BASE_CREWS };
    if (r() < 0.25) crews.Electrical = 2;
    if (r() < 0.2) crews.Mechanical = 1;
    halls.push({
      id: 'DH' + (h + 1), name: 'Data Hall ' + (h + 1), mw: [4.0, 4.0, 4.8, 4.8, 3.6, 3.6][h],
      start: 2 + h * 2 + Math.floor(r() * 2), dueWeek: 30 + h * 2, crews, trueRates, sigma: 0.3 + 0.15 * r(),
    });
  }
  // history to NOW (true process); also the realized future from NOW onward
  for (const h of halls) {
    const hr = rng(Math.floor(r() * 2 ** 31));
    const past = runTrue(h, h.trueRates, h.sigma, hr, NOW);
    h.remaining = past.rem; h.obs = past.obs;
  }
  return { seed, halls };
}

// Posterior pace models with partial pooling across halls (see core).
export function buildModels(project) { return buildPaceModels(ACTIVITIES, project.halls); }

export function projectView(project) {
  return {
    acts, order,
    halls: project.halls.map((h) => ({ id: h.id, mw: h.mw, dueWeek: h.dueWeek - NOW, crews: h.crews, state: { remaining: h.remaining } })),
  };
}

// Truth models: the hall's real rates with no epistemic uncertainty.
function truthModels(project) {
  return project.halls.map((h) => Object.fromEntries(ACTIVITIES.map((a) => [a.id, { mu: Math.log(h.trueRates[a.id]) - (h.sigma * h.sigma) / 2, sdMu: 0, sigma: h.sigma }])));
}

// Recent-pace point forecast: each activity runs at its last-4-week pace
// (planned pace if not started), no uncertainty. Returns finish week offset.
function recentPaceFinish(pv, hi, project) {
  const h = project.halls[hi];
  const models = Object.fromEntries(ACTIVITIES.map((a) => {
    const o = h.obs[a.id];
    const eff = o.slice(-4).reduce((s, x) => s + x.eff, 0), units = o.slice(-4).reduce((s, x) => s + x.units, 0);
    const per = eff > 0 && units > 0 ? units / eff : a.planRate;
    return [a.id, { mu: Math.log(per), sdMu: 0, sigma: 0 }];
  }));
  const f = forecastHall(acts, order, pv.halls[hi].state, pv.halls[hi].crews, models, { sims: 1, seed: 1 });
  return f[0];
}

export function evaluateProject(seed, { sims = 300, planSims = 200 } = {}) {
  const project = buildProject(seed);
  const pv = projectView(project);
  const models = buildModels(project);
  const truth = truthModels(project);
  const out = { seed, halls: [] };
  for (let hi = 0; hi < pv.halls.length; hi++) {
    const h = pv.halls[hi];
    const f = forecastHall(acts, order, h.state, h.crews, models[hi], { sims, seed: 11 + hi });
    const real = forecastHall(acts, order, h.state, h.crews, truth[hi], { sims: 1, seed: 1000 + seed * 7 + hi })[0];
    const rp = recentPaceFinish(pv, hi, project);
    out.halls.push({ p: probBy(f, h.dueWeek), onTime: real <= h.dueWeek ? 1 : 0, paceSaysOnTime: rp <= h.dueWeek ? 1 : 0 });
  }
  // recovery plans, judged under the TRUE rates
  const greedy = planRecovery(pv, models, POOL, { sims: planSims, seed: 7 });
  const naive = mostBehindFirst(pv, models, POOL, { sims: planSims, seed: 7 });
  const lateUnder = (halls) => halls.reduce((s, h, hi) => s + expectedLateMW(forecastHall(acts, order, h.state, h.crews, truth[hi], { sims: 200, seed: 5000 + hi }), h.dueWeek, h.mw), 0);
  out.late = {
    none: round(lateUnder(pv.halls)),
    greedy: round(lateUnder(applyAlloc(pv.halls, greedy.alloc))),
    most_behind_first: round(lateUnder(applyAlloc(pv.halls, naive.alloc))),
  };
  return out;
}

const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

if (process.argv[1] && process.argv[1].endsWith('generate.mjs')) {
  const SEEDS = Number(process.env.SEEDS || 200);
  const per = [];
  for (let s = 1; s <= SEEDS; s++) per.push(evaluateProject(s));
  const ps = per.flatMap((x) => x.halls.map((h) => h.p));
  const ys = per.flatMap((x) => x.halls.map((h) => h.onTime));
  const pace = per.flatMap((x) => x.halls.map((h) => h.paceSaysOnTime));
  const none = mean(per.map((x) => x.late.none)), g = mean(per.map((x) => x.late.greedy)), n = mean(per.map((x) => x.late.most_behind_first));
  const results = {
    generated_by: 'data/generate.mjs', projects: SEEDS, halls: ps.length, now_week: NOW, pool: POOL,
    forecast: {
      brier_model: round(brier(ps, ys), 4), brier_recent_pace: round(brier(pace, ys), 4),
      recent_pace_accuracy: round(mean(pace.map((p, i) => (p === ys[i] ? 1 : 0))), 4),
      reliability: reliability(ps, ys, 5).map((b) => ({ ...b, p: b.p == null ? null : round(b.p, 3), y: b.y == null ? null : round(b.y, 3) })),
      share_on_time: round(mean(ys), 4),
    },
    recovery: {
      late_mw_weeks_no_extra: round(none, 2), late_mw_weeks_greedy: round(g, 2), late_mw_weeks_most_behind_first: round(n, 2),
      reduction_greedy: round(1 - g / none, 4), reduction_most_behind_first: round(1 - n / none, 4),
    },
    per_project: per.map((x) => ({ seed: x.seed, late: x.late, p: x.halls.map((h) => round(h.p, 4)), y: x.halls.map((h) => h.onTime) })),
  };
  writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(results, null, 1));

  const DEMO = 3;
  const proj = buildProject(DEMO);
  const demo = {
    seed: DEMO, project: 'FRA-2 Campus, Building B', client: 'Northgate Data Centers (fictional)', now_week: NOW, start_date: '2026-05-18',
    activities: ACTIVITIES, trades: TRADES, pool: POOL, usd_per_kw_month: 150,
    halls: proj.halls.map((h) => ({ id: h.id, name: h.name, mw: h.mw, start: h.start, dueWeek: h.dueWeek, crews: h.crews, remaining: Object.fromEntries(Object.entries(h.remaining).map(([k, v]) => [k, round(v, 3)])), obs: h.obs })),
  };
  writeFileSync(new URL('./project.json', import.meta.url), JSON.stringify(demo));
  console.log(JSON.stringify({ forecast: { ...results.forecast, reliability: undefined }, recovery: results.recovery }, null, 1));
}
