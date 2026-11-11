// Energization Readiness core: Bayesian trade-pace posteriors from weekly
// capture data, Monte Carlo of each data hall's remaining activity network,
// and a greedy crew-allocation planner with common random numbers.
// Pure functions, no DOM. Shared by the app, the data script and the tests.

export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.normal = () => {
    const u = Math.max(next(), 1e-12), v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return next;
}

// Effective crews when several crews of one trade share a hall: productivity
// per crew falls with stacking (diminishing returns, exponent < 1).
export const STACKING_EXP = 0.85;
export const effectiveCrews = (n) => (n <= 0 ? 0 : Math.pow(n, STACKING_EXP));

// Topological order of an activity network; throws on cycles.
export function topoOrder(activities) {
  const ids = activities.map((a) => a.id);
  const indeg = Object.fromEntries(ids.map((i) => [i, 0]));
  for (const a of activities) for (const p of a.preds) { if (!(p in indeg)) throw new Error('unknown pred ' + p); indeg[a.id]++; }
  const q = ids.filter((i) => indeg[i] === 0), out = [];
  const succ = Object.fromEntries(ids.map((i) => [i, []]));
  for (const a of activities) for (const p of a.preds) succ[p].push(a.id);
  while (q.length) { const i = q.shift(); out.push(i); for (const s of succ[i]) if (--indeg[s] === 0) q.push(s); }
  if (out.length !== ids.length) throw new Error('cycle in activity network');
  return out;
}

// Conjugate normal model on log weekly output per effective crew-week, from
// the capture history: each observation is (units installed in a week,
// effective crew-weeks spent). The prior is the pooled estimate for the same
// activity across halls (partial pooling), or the planned rate if no hall has
// started it. Returns posterior mean/sd of mu and the week-to-week sigma.
export function paceModel(obs, prior = { mu: 0, tau: 3 }) {
  const ys = obs.filter((o) => o.units > 0 && o.eff > 0).map((o) => Math.log(o.units / o.eff));
  const n = ys.length;
  if (!n) return { mu: prior.mu, sdMu: prior.tau, sigma: prior.sigma || 0.3, n: 0 };
  const mean = ys.reduce((a, b) => a + b, 0) / n;
  const s2 = n > 2 ? ys.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : (prior.sigma || 0.3) ** 2;
  const sigma = Math.max(0.08, Math.sqrt(s2));
  const prec = 1 / prior.tau ** 2 + n / sigma ** 2;
  const mu = (prior.mu / prior.tau ** 2 + (n * mean) / sigma ** 2) / prec;
  return { mu, sdMu: Math.sqrt(1 / prec), sigma, n };
}

// Recent-pace point forecast (what a linear pace extrapolation would say):
// weeks to finish = remaining / mean of last k weeks' output.
export function recentPace(obs, k = 4) {
  const last = obs.slice(-k).map((o) => o.units);
  return last.length ? last.reduce((a, b) => a + b, 0) / last.length : 0;
}

// Simulate one hall's remaining network once. state: {remaining:{act:units}},
// crews:{trade:n}, models:{act:{mu,sdMu,sigma}}. Draws come from r (CRN
// friendly: the same seed gives the same epistemic and weekly draws).
// Returns completion week offset (Infinity if beyond horizon).
export function simulateHall(acts, order, state, crews, models, r, horizon = 120, trace = null, finishOut = null) {
  const rem = { ...state.remaining };
  const rate = {};
  for (const id of order) { const m = models[id]; rate[id] = Math.exp(m.mu + m.sdMu * r.normal()); }
  const byTrade = {};
  for (const id of order) { const a = acts[id]; (byTrade[a.trade] ||= []).push(id); }
  const done = (id) => rem[id] <= 1e-9;
  for (let w = 1; w <= horizon; w++) {
    const startDone = {};
    for (const id of order) startDone[id] = done(id);
    for (const trade of Object.keys(byTrade)) {
      let cap = effectiveCrews(crews[trade] || 0);
      if (cap <= 0) continue;
      for (const id of byTrade[trade]) {
        if (cap <= 1e-9) break;
        if (done(id)) continue;
        if (!acts[id].preds.every((p) => startDone[p])) continue;
        const m = models[id];
        const perCrew = rate[id] * Math.exp(m.sigma * r.normal()); // mu is the log-median, so no -sigma^2/2 here
        const need = rem[id] / perCrew;
        const use = Math.min(cap, need);
        rem[id] = Math.max(0, rem[id] - use * perCrew);
        cap -= use;
      }
    }
    if (trace) trace.push(rem[trace.id]);
    if (finishOut) for (const id of order) if (finishOut[id] === undefined && done(id)) finishOut[id] = startDone[id] && state.remaining[id] <= 1e-9 ? 0 : w;
    if (order.every(done)) return w;
  }
  return Infinity;
}

// Percentile paths of one activity's remaining quantity per future week.
export function activityPaths(acts, order, state, crews, models, actId, { sims = 400, seed = 3, horizon = 60 } = {}) {
  const r = rng(seed);
  const paths = [];
  for (let i = 0; i < sims; i++) {
    const tr = []; tr.id = actId;
    simulateHall(acts, order, state, crews, models, r, horizon, tr);
    while (tr.length < horizon) tr.push(tr.length ? tr[tr.length - 1] : state.remaining[actId]);
    paths.push(tr);
  }
  const q = (p) => Array.from({ length: horizon }, (_, w) => quantile(paths.map((x) => x[w]).sort((a, b) => a - b), p));
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9) };
}

export function forecastHall(acts, order, state, crews, models, { sims = 800, seed = 1, horizon = 120 } = {}) {
  const r = rng(seed);
  const weeks = new Array(sims);
  for (let i = 0; i < sims; i++) weeks[i] = simulateHall(acts, order, state, crews, models, r, horizon);
  return weeks.sort((a, b) => a - b);
}

export function quantile(sorted, p) {
  const x = (sorted.length - 1) * p, i = Math.floor(x), f = x - i;
  if (!Number.isFinite(sorted[i])) return sorted[i];
  return i + 1 < sorted.length && Number.isFinite(sorted[i + 1]) ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
}

export function probBy(sorted, week) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= week) lo = m + 1; else hi = m; }
  return lo / sorted.length;
}

// Expected late MW-weeks for a hall: MW * E[max(0, finish - due)].
export function expectedLateMW(sorted, dueWeek, mw, cap = 120) {
  let s = 0;
  for (const w of sorted) s += Math.max(0, Math.min(w, cap) - dueWeek);
  return (mw * s) / sorted.length;
}

// Greedy recovery planner. pool: {trade: extra crews available}. Each step
// adds one crew to the (hall, trade) with the largest drop in expected late
// MW-weeks, evaluated with common random numbers so differences are not
// noise. Returns the allocation and the before/after per hall.
export function planRecovery(project, models, pool, { sims = 400, seed = 7, horizon = 120 } = {}) {
  const { acts, order, halls } = project;
  const alloc = halls.map(() => ({}));
  const crewsOf = (hi) => {
    const c = { ...halls[hi].crews };
    for (const [t, n] of Object.entries(alloc[hi])) c[t] = (c[t] || 0) + n;
    return c;
  };
  const score = (hi, crews) => {
    const f = forecastHall(acts, order, halls[hi].state, crews, models[hi], { sims, seed: seed + hi, horizon });
    return expectedLateMW(f, halls[hi].dueWeek, halls[hi].mw, horizon);
  };
  const cur = halls.map((_, hi) => score(hi, crewsOf(hi)));
  const before = [...cur];
  const left = { ...pool };
  const steps = [];
  for (;;) {
    let best = null;
    for (const t of Object.keys(left)) {
      if (left[t] <= 0) continue;
      for (let hi = 0; hi < halls.length; hi++) {
        if (!hallUsesTrade(acts, halls[hi].state, t)) continue;
        const c = crewsOf(hi); c[t] = (c[t] || 0) + 1;
        const s = score(hi, c);
        const gain = cur[hi] - s;
        if (gain > 1e-9 && (!best || gain > best.gain)) best = { t, hi, s, gain };
      }
    }
    if (!best) break;
    alloc[best.hi][best.t] = (alloc[best.hi][best.t] || 0) + 1;
    cur[best.hi] = best.s; left[best.t]--;
    steps.push({ hall: halls[best.hi].id, trade: best.t, gain: best.gain });
  }
  return { alloc, before, after: cur, steps, unused: left };
}

export function hallUsesTrade(acts, state, trade) {
  return Object.entries(state.remaining).some(([id, rem]) => rem > 1e-9 && acts[id].trade === trade);
}

// Baseline heuristic: give each extra crew to the hall with the largest P50
// slip (most behind first), in the trade with the most remaining work there.
export function mostBehindFirst(project, models, pool, { sims = 400, seed = 7, horizon = 120 } = {}) {
  const { acts, order, halls } = project;
  const alloc = halls.map(() => ({}));
  const slip = halls.map((h, hi) => quantile(forecastHall(acts, order, h.state, h.crews, models[hi], { sims, seed: seed + hi, horizon }), 0.5) - h.dueWeek);
  const left = { ...pool };
  for (const t of Object.keys(left)) {
    while (left[t] > 0) {
      const cands = halls.map((h, hi) => hi).filter((hi) => hallUsesTrade(acts, halls[hi].state, t));
      if (!cands.length) break;
      cands.sort((a, b) => slip[b] - slip[a]);
      const hi = cands[0];
      alloc[hi][t] = (alloc[hi][t] || 0) + 1; left[t]--;
      slip[hi] -= 0.5; // spread a little so one hall does not absorb everything
    }
  }
  return { alloc };
}

export function applyAlloc(halls, alloc) {
  return halls.map((h, hi) => {
    const c = { ...h.crews };
    for (const [t, n] of Object.entries(alloc[hi] || {})) c[t] = (c[t] || 0) + n;
    return { ...h, crews: c };
  });
}

// Brier score of probability forecasts against 0/1 outcomes.
export function brier(ps, ys) {
  if (ps.length !== ys.length || !ps.length) throw new Error('length mismatch');
  return ps.reduce((a, p, i) => a + (p - ys[i]) ** 2, 0) / ps.length;
}

// Reliability table: bin forecasts, report mean predicted vs observed rate.
export function reliability(ps, ys, bins = 5) {
  const out = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, p: 0, y: 0 }));
  ps.forEach((p, i) => { const b = Math.min(bins - 1, Math.floor(p * bins)); out[b].n++; out[b].p += p; out[b].y += ys[i]; });
  return out.map((b) => ({ ...b, p: b.n ? b.p / b.n : null, y: b.n ? b.y / b.n : null }));
}

// Median finish week of each remaining activity, and the driver: the input to
// commissioning (L3) that finishes last in the median, i.e. what gates the hall.
export function activityFinishes(acts, order, state, crews, models, { sims = 300, seed = 5, horizon = 120 } = {}) {
  const r = rng(seed);
  const all = Object.fromEntries(order.map((id) => [id, []]));
  for (let i = 0; i < sims; i++) {
    const fo = {};
    simulateHall(acts, order, state, crews, models, r, horizon, null, fo);
    for (const id of order) all[id].push(fo[id] === undefined ? Infinity : fo[id]);
  }
  const med = Object.fromEntries(order.map((id) => [id, quantile(all[id].sort((a, b) => a - b), 0.5)]));
  return med;
}

// Pace models for every hall: each activity's prior is the pooled estimate
// across halls that have started it (partial pooling), else the planned rate
// corrected by the published plan-vs-actual benchmark for that activity.
export function buildPaceModels(activities, halls) {
  const pooled = {};
  for (const a of activities) {
    const all = halls.flatMap((h) => h.obs[a.id]);
    const benchPrior = { mu: Math.log(a.planRate * a.bench) - 0.08, tau: 0.3, sigma: 0.4 }; // log-median of a mean rate with sigma 0.4
    const m = paceModel(all, benchPrior);
    pooled[a.id] = m.n ? { mu: m.mu, tau: 0.18, sigma: m.sigma } : benchPrior;
  }
  return halls.map((h) => Object.fromEntries(activities.map((a) => [a.id, paceModel(h.obs[a.id], pooled[a.id])])));
}
