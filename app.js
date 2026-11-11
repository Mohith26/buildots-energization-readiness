import {
  topoOrder, paceModel, forecastHall, probBy, quantile, expectedLateMW, planRecovery, applyAlloc,
  activityPaths, activityFinishes, recentPace, effectiveCrews, buildPaceModels,
} from './src/core.js';

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view'), layer = $('#layer');
const LS = 'buildots-energization-readiness:v1';
const icons = () => window.lucide && window.lucide.createIcons({ attrs: { 'aria-hidden': 'true' } });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (x, d = 1) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (x) => '$' + (x >= 1e6 ? fmt(x / 1e6, 2) + 'M' : x >= 1e3 ? fmt(x / 1e3, 0) + 'k' : fmt(x, 0));
const SIMS = 800, PLAN_SIMS = 800;

const S = { d: null, res: null, models: null, acts: null, order: null, applied: null, pool: null, plan: null, tab: 'halls', hall: null, act: null, cache: {} };

function load() { try { const s = JSON.parse(localStorage.getItem(LS) || '{}'); S.applied = s.applied || null; S.pool = s.pool || null; } catch { /* ignore */ } }
function save() { localStorage.setItem(LS, JSON.stringify({ applied: S.applied, pool: S.pool })); }

// ---------------------------------------------------------------- model
function buildModels(d) { return buildPaceModels(d.activities, d.halls); }
const NOW = () => S.d.now_week;
function hallsView(alloc) {
  const base = S.d.halls.map((h) => ({ id: h.id, mw: h.mw, dueWeek: h.dueWeek - NOW(), crews: h.crews, state: { remaining: h.remaining } }));
  return alloc ? applyAlloc(base, alloc) : base;
}
function project(alloc) { return { acts: S.acts, order: S.order, halls: hallsView(alloc) }; }
function forecasts(alloc) {
  const key = JSON.stringify(alloc || null);
  if (!S.cache[key]) {
    const p = project(alloc);
    S.cache[key] = p.halls.map((h, hi) => {
      const f = forecastHall(S.acts, S.order, h.state, h.crews, S.models[hi], { sims: SIMS, seed: 11 + hi });
      const fin = activityFinishes(S.acts, S.order, h.state, h.crews, S.models[hi], { sims: 250, seed: 5 + hi });
      const gates = ['PDU', 'CRH', 'FSP', 'BMS'].filter((id) => h.state.remaining[id] > 1e-9);
      let driver = gates.length ? gates.reduce((a, b) => (fin[b] > fin[a] ? b : a)) : S.order.filter((id) => h.state.remaining[id] > 1e-9)[0];
      // walk upstream while the gate has not started: blame the unfinished predecessor that finishes last
      const hobs = S.d.halls[hi].obs;
      for (let guard = 0; driver && guard < 10; guard++) {
        const preds = S.acts[driver].preds.filter((q) => h.state.remaining[q] > 1e-9);
        if (hobs[driver].length || !preds.length) break;
        driver = preds.reduce((a, b) => (fin[b] > fin[a] ? b : a));
      }
      return { f, p: probBy(f, h.dueWeek), p10: quantile(f, 0.1), p50: quantile(f, 0.5), p90: quantile(f, 0.9), late: expectedLateMW(f, h.dueWeek, h.mw), fin, driver };
    });
  }
  return S.cache[key];
}
const perMWWeek = () => (S.d.usd_per_kw_month * 1000 * 12) / 52;
function weekDate(w) {
  const d = new Date(S.d.start_date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 7 * w);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
const absW = (rel) => NOW() + rel;
function status(p) { return p >= 0.8 ? ['green', 'On track'] : p >= 0.4 ? ['amber', 'At risk'] : ['red', 'Behind']; }

// ---------------------------------------------------------------- boot/routing
async function boot() {
  load();
  view.innerHTML = `<div class="page">${Array.from({ length: 8 }, () => '<div class="skel" style="margin:18px 0"></div>').join('')}</div>`;
  try {
    const [d, res] = await Promise.all(['data/project.json', 'data/results.json'].map((u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); })));
    S.d = d; S.res = res; S.acts = Object.fromEntries(d.activities.map((a) => [a.id, a])); S.order = topoOrder(d.activities);
    S.models = buildModels(d); S.pool = S.pool || { ...d.pool };
    $('#capture').textContent = `Latest capture ${weekDate(NOW())}, 2026 · week ${NOW()}`;
  } catch (e) {
    view.innerHTML = `<div class="page"><div class="card empty"><i data-lucide="cloud-off"></i><p>Couldn't load project data (${esc(e.message)}).</p><button class="btn" onclick="location.reload()">Retry</button></div></div>`; icons(); return;
  }
  window.addEventListener('hashchange', route);
  route();
}
function parse() {
  const h = location.hash.replace(/^#/, '') || '/readiness';
  const [path, qs] = h.split('?');
  return { page: path.split('/').filter(Boolean)[0] || 'readiness', q: new URLSearchParams(qs || '') };
}
function go(page, params = {}, replace = false) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  const h = '#/' + page + (qs ? '?' + qs : '');
  if (replace) { history.replaceState(null, '', h); route(); } else location.hash = h;
}
function route() {
  const { page, q } = parse();
  layer.innerHTML = '';
  if (page === 'backtest') { S.tab = 'backtest'; renderBacktest(); }
  else {
    S.tab = 'halls';
    renderReadiness();
    if (q.get('hall')) openHall(q.get('hall'), q.get('act'));
  }
  icons();
}

// ---------------------------------------------------------------- readiness page
function tabs() {
  return `<div class="tabs" role="tablist"><button role="tab" class="${S.tab === 'halls' ? 'on' : ''}" data-tab="readiness">Data halls</button><button role="tab" class="${S.tab === 'backtest' ? 'on' : ''}" data-tab="backtest">Forecast accuracy</button></div>`;
}
function bindTabs() { view.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab))); }

function rangeSvg(fc, due) {
  const W = 300, H = 34, lo = Math.min(fc.p10, due) - 2, hi = Math.max(Number.isFinite(fc.p90) ? fc.p90 : due + 12, due) + 2;
  const X = (w) => 6 + ((w - lo) / (hi - lo)) * (W - 12);
  const p90 = Number.isFinite(fc.p90) ? fc.p90 : hi;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Energization P10 to P90 ${weekDate(absW(fc.p10))} to ${weekDate(absW(p90))}, due ${weekDate(absW(due))}">
    <line x1="6" x2="${W - 6}" y1="15" y2="15" stroke="#eeeeee" stroke-width="6" stroke-linecap="round"/>
    <rect x="${X(fc.p10)}" y="12" width="${Math.max(3, X(p90) - X(fc.p10))}" height="6" rx="3" fill="#d0cbfa"/>
    <circle cx="${X(fc.p50)}" cy="15" r="4.5" fill="#7b6cf6"/>
    <line x1="${X(due)}" x2="${X(due)}" y1="5" y2="25" stroke="#161616" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="${X(due)}" y="33" text-anchor="middle" font-size="10" fill="#6b6b6b">due ${weekDate(absW(due))}</text>
  </svg>`;
}

function renderReadiness() {
  const fc = forecasts(S.applied);
  const halls = hallsView(S.applied);
  const totalLate = fc.reduce((a, x) => a + x.late, 0);
  const atRisk = fc.filter((x) => x.p < 0.8).length;
  const mwOnTime = fc.reduce((a, x, i) => a + x.p * halls[i].mw, 0), mwTotal = halls.reduce((a, h) => a + h.mw, 0);
  view.innerHTML = `<div class="page">${tabs()}
  <div class="kpis">
    <div class="card kpi accent"><div class="label">Expected MW on time</div><div class="v">${fmt(mwOnTime)} <span class="muted" style="font-size:15px">/ ${fmt(mwTotal)} MW</span></div><div class="s">Sum over halls of MW × P(ready for energization by due date)</div></div>
    <div class="card kpi"><div class="label">Halls at risk</div><div class="v">${atRisk} <span class="muted" style="font-size:15px">of ${halls.length}</span></div><div class="s">P(on time) below 80%</div></div>
    <div class="card kpi"><div class="label">Expected late MW-weeks</div><div class="v">${fmt(totalLate)}</div><div class="s">MW × weeks past each hall's due date, averaged over ${SIMS} simulations</div></div>
    <div class="card kpi"><div class="label">Revenue at risk</div><div class="v">${money(totalLate * perMWWeek())}</div><div class="s">at $${S.d.usd_per_kw_month}/kW-month (assumption)</div></div>
  </div>
  ${S.applied ? `<div class="banner" style="margin-bottom:14px"><i data-lucide="check-circle-2"></i><span>Recovery plan applied: ${planSummary(S.applied)}. Forecasts below include the added crews. <a href="#" id="undoPlan">Undo</a></span></div>` : ''}
  <div class="grid2">
    <section aria-label="Data halls"><div class="halls">${halls.map((h, i) => {
      const x = fc[i], [cls, txt] = status(x.p), a = S.acts[x.driver];
      return `<button class="hall" data-hall="${h.id}" aria-label="${h.id}, ${Math.round(100 * x.p)} percent chance on time">
        <div class="top"><span><span class="nm">${S.d.halls[i].name}</span> <span class="mw">· ${fmt(h.mw)} MW</span></span><span class="chip ${cls}">${txt}</span></div>
        <div class="p">${Math.round(100 * x.p)}%</div><div class="ps">chance ready for energization by ${weekDate(absW(h.dueWeek))}</div>
        <div class="range">${rangeSvg(x, h.dueWeek)}</div>
        <div class="drv"><i data-lucide="git-branch"></i>Gating: ${a ? esc(a.name) : 'Commissioning'}${a && a.trade !== 'Commissioning' ? ' → commissioning' : ''} · P50 ${weekDate(absW(x.p50))}</div>
      </button>`;
    }).join('')}</div>${timelineCard(halls, fc)}</section>
    ${plannerCard(fc)}
  </div></div>`;
  bindTabs();
  view.querySelectorAll('[data-hall]').forEach((b) => b.addEventListener('click', () => go('readiness', { hall: b.dataset.hall })));
  bindPlanner();
  const u = $('#undoPlan'); if (u) u.addEventListener('click', (e) => { e.preventDefault(); S.applied = null; S.plan = null; save(); renderReadiness(); icons(); toast('Plan removed'); });
}
function timelineCard(halls, fc) {
  const lo = NOW(), hi = Math.max(...halls.map((h, i) => Math.max(h.dueWeek + NOW(), Number.isFinite(fc[i].p90) ? fc[i].p90 + NOW() : h.dueWeek + NOW() + 10))) + 2;
  const W = 900, rowH = 30, P = { l: 120, r: 16, t: 26 }, H = P.t + rowH * halls.length + 8;
  const X = (w) => P.l + ((w - lo) / (hi - lo)) * (W - P.l - P.r);
  const ticks = []; for (let w = lo; w <= hi; w += 4) ticks.push(`<line x1="${X(w)}" x2="${X(w)}" y1="${P.t - 6}" y2="${H}" stroke="#f0f0f0"/><text x="${X(w)}" y="${P.t - 10}" font-size="10" text-anchor="middle" fill="#8f8f8f">${weekDate(w)}</text>`);
  const rows = halls.map((h, i) => {
    const y = P.t + i * rowH + 8, x = fc[i], p90 = Number.isFinite(x.p90) ? x.p90 : hi - NOW();
    const due = X(h.dueWeek + NOW()), late = x.p50 > h.dueWeek;
    return `<text x="8" y="${y + 11}" font-size="12" fill="#161616">${S.d.halls[i].name}</text>
      <rect x="${X(NOW())}" y="${y}" width="${Math.max(2, X(x.p10 + NOW()) - X(NOW()))}" height="14" fill="#e5f100" opacity=".55"/>
      <rect x="${X(x.p10 + NOW())}" y="${y}" width="${Math.max(3, X(p90 + NOW()) - X(x.p10 + NOW()))}" height="14" fill="${late ? '#d0cbfa' : '#e7e4fd'}"/>
      <rect x="${X(x.p50 + NOW()) - 1.5}" y="${y - 2}" width="3" height="18" fill="#7b6cf6"/>
      <line x1="${due}" x2="${due}" y1="${y - 4}" y2="${y + 18}" stroke="#161616" stroke-width="2"/>`;
  }).join('');
  return `<div class="card" style="margin-top:12px"><div class="hd"><span class="label">Energization timeline</span><span class="legend"><span><i style="background:#e5f100;opacity:.55"></i>Remaining fit-out (to P10)</span><span><i style="background:#d0cbfa"></i>P10–P90</span><span><i style="background:#7b6cf6"></i>P50</span><span><i style="background:#161616"></i>Due</span></span></div>
    <div style="padding:6px 12px 10px"><svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img" aria-label="Energization timeline by hall">${ticks.join('')}${rows}</svg></div></div>`;
}

function planSummary(alloc) {
  const parts = [];
  alloc.forEach((a, i) => Object.entries(a).forEach(([t, n]) => parts.push(`+${n} ${t.toLowerCase()} to ${S.d.halls[i].id}`)));
  return parts.join(', ') || 'no changes';
}

function plannerCard(fc) {
  const p = S.plan;
  return `<section class="card planner" aria-label="Recovery planner">
    <div class="hd"><span class="label">Recovery planner</span><span class="chip purple">New</span></div>
    <div class="body">
      <p style="margin:0 0 8px;font-size:13px;color:var(--muted)">Extra crews you can bring in for the rest of fit-out. The planner places them one at a time where they cut the most expected late MW-weeks, testing every hall × trade on the same ${PLAN_SIMS} simulated futures.</p>
      ${Object.keys(S.d.pool).map((t) => `<div class="stepper"><span>${t}</span><span class="ctrl"><button data-dec="${t}" aria-label="Fewer ${t} crews">−</button><span>${S.pool[t] || 0}</span><button data-inc="${t}" aria-label="More ${t} crews">+</button></span></div>`).join('')}
      <div style="display:flex;gap:8px;margin-top:12px"><button class="btn dark" id="runPlan" ${S.applied ? 'disabled' : ''}><i data-lucide="sparkles"></i>Plan recovery</button>${p ? `<button class="btn brand" id="applyPlan"><i data-lucide="check"></i>Apply plan</button><button class="btn" id="expPlan"><i data-lucide="download"></i>CSV</button>` : ''}</div>
      <div id="planOut" style="margin-top:12px">${p ? planTable(p) : `<div class="muted" style="font-size:12px">${S.applied ? 'A plan is applied. Undo it to plan again.' : 'No plan yet.'}</div>`}</div>
    </div></section>`;
}
function planTable(p) {
  const v = perMWWeek();
  const rows = p.steps.map((s, i) => `<tr><td>${i + 1}</td><td>+1 ${esc(s.trade)}</td><td>${s.hall}</td><td class="num">${fmt(s.gain)}</td><td class="num">${money(s.gain * v)}</td></tr>`).join('');
  const before = p.before.reduce((a, b) => a + b, 0), after = p.after.reduce((a, b) => a + b, 0);
  return `<table class="t"><thead><tr><th>#</th><th>Move</th><th>Hall</th><th class="num">MW-wk saved</th><th class="num">Value</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">No move lowers expected lateness.</td></tr>'}
    <tr class="total"><td></td><td colspan="2">Late MW-weeks ${fmt(before)} → ${fmt(after)}</td><td class="num">${fmt(before - after)}</td><td class="num">${money((before - after) * v)}</td></tr></tbody></table>
    ${Object.values(p.unused).some((n) => n > 0) ? `<div class="muted" style="font-size:12px;margin-top:6px">Unused: ${Object.entries(p.unused).filter(([, n]) => n > 0).map(([t, n]) => `${n} ${t.toLowerCase()}`).join(', ')} (no hall gains from them)</div>` : ''}`;
}
function bindPlanner() {
  view.querySelectorAll('[data-inc]').forEach((b) => b.addEventListener('click', () => { S.pool[b.dataset.inc] = Math.min(6, (S.pool[b.dataset.inc] || 0) + 1); S.plan = null; save(); renderReadiness(); icons(); }));
  view.querySelectorAll('[data-dec]').forEach((b) => b.addEventListener('click', () => { S.pool[b.dataset.dec] = Math.max(0, (S.pool[b.dataset.dec] || 0) - 1); S.plan = null; save(); renderReadiness(); icons(); }));
  const run = $('#runPlan');
  if (run) run.addEventListener('click', runPlan);
  const ap = $('#applyPlan');
  if (ap) ap.addEventListener('click', () => { S.applied = S.plan.alloc; S.plan = null; save(); renderReadiness(); icons(); toast('Plan applied: crews added to the forecast'); });
  const ex = $('#expPlan');
  if (ex) ex.addEventListener('click', () => {
    const csv = ['step,move,hall,late_mw_weeks_saved,value_usd', ...S.plan.steps.map((s, i) => [i + 1, '+1 ' + s.trade, s.hall, s.gain.toFixed(2), Math.round(s.gain * perMWWeek())].join(','))].join('\n');
    download('recovery-plan.csv', csv, 'text/csv');
  });
}
function runPlan() {
  const out = $('#planOut'); out.innerHTML = '<div class="skel" style="margin:8px 0"></div><div class="skel" style="margin:8px 0;width:70%"></div><div class="muted" style="font-size:12px">Simulating every hall × trade…</div>';
  $('#runPlan').disabled = true;
  setTimeout(() => {
    S.plan = planRecovery(project(null), S.models, S.pool, { sims: PLAN_SIMS, seed: 11 });
    renderReadiness(); icons();
  }, 30);
}

// ---------------------------------------------------------------- hall drawer
function openHall(id, actId) {
  const hi = S.d.halls.findIndex((h) => h.id === id);
  if (hi < 0) { toast('Hall ' + id + ' not found'); return; }
  const H = S.d.halls[hi], hv = hallsView(S.applied)[hi], fc = forecasts(S.applied)[hi];
  const act = S.acts[actId] && H.remaining[actId] !== undefined ? actId : fc.driver;
  const a = S.acts[act];
  const m = S.models[hi][act];
  const obs = H.obs[act];
  const done = a.qty - H.remaining[act];
  const avg = obs.length ? obs.reduce((s, o) => s + o.units, 0) / obs.length : 0;
  const recent = recentPace(obs, 4);
  // leave the model's median commissioning duration (L3+L4+L5 at current crews) after this activity
  const cxIds = ['L3', 'L4', 'L5'].filter((x) => x !== act && !S.acts[act].preds.includes(x) && H.remaining[x] > 1e-9 && !isUpstream(x, act));
  const cxWeeks = cxIds.reduce((s2, x) => { const mm = S.models[hi][x]; return s2 + H.remaining[x] / (Math.exp(mm.mu + mm.sigma * mm.sigma / 2) * effectiveCrews(hv.crews[S.acts[x].trade] || 1)); }, 0);
  const reqWeeks = Math.max(0.5, hv.dueWeek - cxWeeks);
  const required = H.remaining[act] / reqWeeks;
  const fcPace = Math.exp(m.mu) * effectiveCrews(hv.crews[a.trade] || 0);
  const [cls, txt] = status(fc.p);
  const rows = S.order.map((x) => {
    const A = S.acts[x], rem = H.remaining[x], pct = 1 - rem / A.qty, fin = fc.fin[x];
    return `<tr class="actrow ${x === act ? 'sel' : ''}" data-act="${x}" tabindex="0"><td>${esc(A.name)}</td><td class="muted">${A.trade}</td><td><span class="bar"><i style="width:${Math.round(100 * pct)}%"></i></span> ${Math.round(100 * pct)}%</td><td class="num">${hv.crews[A.trade] || 0}</td><td class="num">${rem <= 1e-9 ? '<span class="muted">Done</span>' : fin === Infinity ? '—' : weekDate(absW(fin))}</td></tr>`;
  }).join('');
  layer.innerHTML = `<div class="scrim" id="scrim"></div><section class="drawer" role="dialog" aria-modal="true" aria-label="${H.name}">
    <div class="dh"><div><h2>${H.name} · ${fmt(H.mw)} MW</h2><div class="muted" style="font-size:12px">FRA-2 Campus · Building B · due ${weekDate(H.dueWeek)}</div></div>
      <div style="display:flex;gap:6px;align-items:center"><span class="chip ${cls}">${txt}</span><button class="icon-btn" id="closeD" aria-label="Close"><i data-lucide="x"></i></button></div></div>
    <div class="db">
      <div class="banner"><i data-lucide="zap"></i><span><b>${Math.round(100 * fc.p)}% chance</b> this hall is ready for energization by ${weekDate(H.dueWeek)}. Likely ${weekDate(absW(fc.p10))} to ${Number.isFinite(fc.p90) ? weekDate(absW(fc.p90)) : 'after week 120'} (P10 to P90); expected ${fmt(fc.late)} late MW-weeks (${money(fc.late * perMWWeek())}).</span></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px"><div><div class="label">${esc(a.name)}</div><div class="muted" style="font-size:12px">${a.trade} · ${fmt(done, 0)} / ${fmt(a.qty, 0)} ${a.unit} installed · ${obs.length} weekly captures</div></div>${act === fc.driver ? '<span class="chip purple">Gating activity</span>' : ''}</div>
      ${H.remaining[act] <= 1e-9 ? `<div class="banner" style="margin:14px 0;background:#f3f9f5;border-color:#cfe9d9"><i data-lucide="check"></i><span>${esc(a.name)} is complete (${obs.length} weekly captures, average ${fmt(avg)} ${a.unit} / week). Pick an unfinished activity below to see its forecast.</span></div>` : `<div class="paces">
        ${paceCard('Average pace', obs.length ? avg : null, a, H.remaining[act], reqWeeks, obs.length ? 'all captures' : 'no captures yet', false)}
        ${paceCard('Recent pace', obs.length ? recent : null, a, H.remaining[act], reqWeeks, obs.length ? 'last 4 weeks' : "forecast uses other halls' pace", false)}
        ${paceCard('Required pace', required, a, H.remaining[act], reqWeeks, cxIds.length ? `leaves ${fmt(cxWeeks)} weeks for commissioning` : 'to finish by the hall due date', false, true)}
        ${paceCard('Forecast pace', fcPace, a, H.remaining[act], reqWeeks, `posterior median, ${hv.crews[a.trade] || 0} crews`, true)}
      </div>`}
      <div class="card chart" style="padding:12px 14px"><div style="display:flex;justify-content:space-between;align-items:center"><span class="label" style="font-size:11px">${esc(a.name)} over time (%)</span>
        <span class="legend"><span><i style="background:#eaf25a"></i>Actual</span><span><i style="background:#bdbdbd"></i>Schedule</span><span><i style="background:#d0cbfa"></i>Forecast (P50, P10–P90 band)</span><span><i style="background:repeating-linear-gradient(45deg,#f2b8c6 0 2px,#fff 2px 4px)"></i>Delay vs hall due</span></span></div>
        ${actChart(H, hv, hi, act)}</div>
      <div class="card" style="margin-top:14px"><div class="hd"><span class="label">Activities</span><span class="muted" style="font-size:12px">Click a row to chart it</span></div>
        <table class="t"><thead><tr><th>Activity</th><th>Trade</th><th>Complete</th><th class="num">Crews</th><th class="num">P50 finish</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div></section>`;
  icons();
  $('#scrim').addEventListener('click', closeHall);
  $('#closeD').addEventListener('click', closeHall);
  layer.querySelectorAll('[data-act]').forEach((tr) => { tr.addEventListener('click', () => go('readiness', { hall: id, act: tr.dataset.act }, true)); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') tr.click(); }); });
}
function paceCard(label, v, a, rem, reqWeeks, note, on, isReq) {
  let sub = note, bad = false;
  if (v != null && !isReq && v > 0) {
    const late = Math.ceil(rem / v - reqWeeks);
    if (late > 0) { sub = `${late} week${late > 1 ? 's' : ''} delay`; bad = true; } else sub = 'On time';
  } else if (isReq) sub = 'To finish on time';
  return `<div class="pace ${on ? 'on' : ''}"><div class="l">${label}</div><div class="v">${v == null ? 'Not started' : fmt(v) + ' ' + a.unit + ' / week'}</div><div class="s ${bad ? 'bad' : ''}">${sub}</div>${sub !== note ? `<div class="s" style="color:#b0b0b0">${note}</div>` : ''}</div>`;
}
function isUpstream(x, target) {
  // is x a (transitive) predecessor of target?
  const seen = new Set(), stack = [...S.acts[target].preds];
  while (stack.length) { const q = stack.pop(); if (q === x) return true; if (!seen.has(q)) { seen.add(q); stack.push(...S.acts[q].preds); } }
  return false;
}
function closeHall() { layer.innerHTML = ''; history.replaceState(null, '', '#/readiness'); }

function actChart(H, hv, hi, act) {
  const a = S.acts[act];
  const W = 760, Hh = 230, P = { l: 36, r: 14, t: 14, b: 26 };
  const horizon = 30;
  const paths = activityPaths(S.acts, S.order, hv.state, hv.crews, S.models[hi], act, { sims: 300, seed: 3, horizon });
  const obs = H.obs[act];
  let cum = 0; const actual = [[H.start, 0]];
  const firstW = obs.length ? obs[0].week - 1 : NOW();
  if (obs.length) { actual.length = 0; actual.push([firstW, 0]); for (const o of obs) { cum += o.units; actual.push([o.week, cum / a.qty]); } }
  else actual.push([NOW(), 0]);
  // schedule: planned linear from planned start to planned finish at the planned pace
  const plannedStart = firstW, plannedWeeks = a.qty / (a.planRate * effectiveCrews(H.crews[a.trade] || 1));
  const x0 = Math.min(plannedStart, NOW() - 6), x1 = NOW() + horizon;
  const X = (w) => P.l + ((w - x0) / (x1 - x0)) * (W - P.l - P.r);
  const Y = (f) => P.t + (1 - f) * (Hh - P.t - P.b);
  const pathD = (pts) => pts.map(([w, f], i) => `${i ? 'L' : 'M'}${X(w).toFixed(1)},${Y(f).toFixed(1)}`).join('');
  const toF = (rem) => 1 - rem / a.qty;
  const fut = (arr) => [[NOW(), toF(H.remaining[act])], ...arr.map((r, i) => [NOW() + i + 1, toF(r)])];
  const p10 = fut(paths.p90), p90 = fut(paths.p10), p50 = fut(paths.p50);
  const band = pathD(p90) + p10.slice().reverse().map(([w, f]) => `L${X(w).toFixed(1)},${Y(f).toFixed(1)}`).join('') + 'Z';
  const sched = [[plannedStart, 0], [plannedStart + plannedWeeks, 1], [x1, 1]];
  const areaActual = pathD(actual) + `L${X(actual[actual.length - 1][0])},${Y(0)}L${X(actual[0][0])},${Y(0)}Z`;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(f)}" y2="${Y(f)}" stroke="#efefef"/><text x="${P.l - 6}" y="${Y(f) + 4}" text-anchor="end" font-size="10" fill="#8f8f8f">${f * 100}%</text>`).join('');
  const ticks = []; for (let w = Math.ceil(x0 / 4) * 4; w <= x1; w += 4) ticks.push(`<text x="${X(w)}" y="${Hh - 6}" text-anchor="middle" font-size="10" fill="#8f8f8f">${weekDate(w)}</text>`);
  const due = H.dueWeek;
  const fcH = forecasts(S.applied)[hi];
  const p50Done = fcH.fin[act] === Infinity ? x1 : NOW() + fcH.fin[act];
  return `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${esc(a.name)} percent complete: actual, schedule and forecast">
    ${grid}${ticks.join('')}
    <defs><linearGradient id="gs" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#bdbdbd" stop-opacity=".55"/><stop offset="1" stop-color="#e9e9e9" stop-opacity=".2"/></linearGradient>
      <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#f2b8c6" stroke-width="2"/></pattern></defs>
    ${obs.length ? `<path d="${pathD(sched)}L${X(x1)},${Y(0)}L${X(sched[0][0])},${Y(0)}Z" fill="url(#gs)"/><path d="${pathD(sched)}" fill="none" stroke="#a9a9a9" stroke-width="1.5"/>` : ''}
    ${H.remaining[act] > 1e-9 && p50Done > due ? `<rect x="${X(due)}" y="${P.t}" width="${Math.max(0, X(Math.min(p50Done, x1)) - X(due))}" height="${Hh - P.t - P.b}" fill="url(#hatch)" opacity=".7"/>` : ''}
    ${H.remaining[act] > 1e-9 ? `<path d="${pathD(p50)}L${X(x1)},${Y(0)}L${X(NOW())},${Y(0)}Z" fill="#d0cbfa" opacity=".55"/><path d="${band}" fill="#b9b1f7" opacity=".45"/>` : ''}
    <path d="${areaActual}" fill="#eaf25a" opacity=".85"/>
    <path d="${pathD(actual)}" fill="none" stroke="#c9d400" stroke-width="2"/>
    ${H.remaining[act] > 1e-9 ? `<path d="${pathD(p50)}" fill="none" stroke="#7b6cf6" stroke-width="2"/>` : ''}
    <line x1="${X(NOW())}" x2="${X(NOW())}" y1="${P.t}" y2="${Hh - P.b}" stroke="#8f8f8f" stroke-dasharray="3 3"/><text x="${X(NOW()) + 4}" y="${P.t + 10}" font-size="10" fill="#6b6b6b">Today</text>
    ${due <= x1 ? `<line x1="${X(due)}" x2="${X(due)}" y1="${P.t}" y2="${Hh - P.b}" stroke="#161616" stroke-dasharray="4 3"/><text x="${X(due) + 4}" y="${P.t + 10}" font-size="10" fill="#161616">Hall due</text>` : ''}
  </svg>`;
}

// ---------------------------------------------------------------- backtest
function renderBacktest() {
  const R = S.res, F = R.forecast, Rc = R.recovery;
  const W = 360, H = 260, P = 36;
  const X = (p) => P + p * (W - 2 * P), Y = (p) => H - P - p * (H - 2 * P);
  const pts = F.reliability.filter((b) => b.n);
  const rel = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Reliability diagram">
    <line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" stroke="#d9d9d9" stroke-dasharray="4 3"/>
    ${[0, 0.5, 1].map((t) => `<text x="${X(t)}" y="${H - 12}" font-size="10" text-anchor="middle" fill="#8f8f8f">${t * 100}%</text><text x="${P - 6}" y="${Y(t) + 3}" font-size="10" text-anchor="end" fill="#8f8f8f">${t * 100}%</text>`).join('')}
    <path d="${pts.map((b, i) => `${i ? 'L' : 'M'}${X(b.p)},${Y(b.y)}`).join('')}" fill="none" stroke="#7b6cf6" stroke-width="2"/>
    ${pts.map((b) => `<circle cx="${X(b.p)}" cy="${Y(b.y)}" r="${3 + Math.sqrt(b.n) / 3}" fill="#7b6cf6" opacity=".85"><title>${b.n} halls: predicted ${Math.round(b.p * 100)}%, actual ${Math.round(b.y * 100)}%</title></circle>`).join('')}
    <text x="${W / 2}" y="${H - 1}" font-size="10" text-anchor="middle" fill="#6b6b6b">Predicted P(on time)</text>
  </svg>`;
  view.innerHTML = `<div class="page">${tabs()}
  <p style="max-width:860px;color:var(--ink-2);font-size:13px;margin-top:0">Backtest on ${R.projects} simulated data-center projects (${R.halls} halls). Each project's true trade paces are hidden; the model only sees weekly capture data up to week ${R.now_week}, like the platform does. The realized energization date then comes from the true process. Numbers come from <code>data/generate.mjs</code> and are re-checked by the test suite.</p>
  <div class="kpis">
    <div class="card kpi accent"><div class="label">Brier score</div><div class="v">${fmt(F.brier_model, 3)}</div><div class="s">vs ${fmt(F.brier_recent_pace, 3)} extrapolating recent pace (lower is better)</div></div>
    <div class="card kpi"><div class="label">Top-bin reliability</div><div class="v">${Math.round(100 * F.reliability[4].p)}% → ${Math.round(100 * F.reliability[4].y)}%</div><div class="s">predicted vs realized on-time, ${F.reliability[4].n} halls</div></div>
    <div class="card kpi"><div class="label">Planner: late MW-weeks</div><div class="v">−${Math.round(100 * Rc.reduction_greedy)}%</div><div class="s">vs −${Math.round(100 * Rc.reduction_most_behind_first)}% for “most-behind hall first”</div></div>
    <div class="card kpi"><div class="label">Crew pool tested</div><div class="v" style="font-size:15px;line-height:24px">${Object.entries(R.pool).map(([t, n]) => `+${n} ${t}`).join(', ')}</div><div class="s">judged under the true paces</div></div>
  </div>
  <div class="grid2" style="grid-template-columns: 420px minmax(0,1fr)">
    <div class="card"><div class="hd"><span class="label">Reliability</span></div><div style="padding:8px 12px">${rel}</div></div>
    <div class="card"><div class="hd"><span class="label">Reliability table</span></div><table class="t"><thead><tr><th>Predicted bin</th><th class="num">Halls</th><th class="num">Mean predicted</th><th class="num">Realized on time</th></tr></thead><tbody>${F.reliability.map((b) => `<tr><td>${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%</td><td class="num">${b.n}</td><td class="num">${b.p == null ? '—' : Math.round(100 * b.p) + '%'}</td><td class="num">${b.y == null ? '—' : Math.round(100 * b.y) + '%'}</td></tr>`).join('')}</tbody></table>
      <div class="hd" style="border-top:1px solid var(--line-2)"><span class="label">Recovery plans (mean per project)</span></div>
      <table class="t"><thead><tr><th>Plan</th><th class="num">Late MW-weeks</th><th class="num">Reduction</th></tr></thead><tbody>
        <tr><td>No extra crews</td><td class="num">${fmt(Rc.late_mw_weeks_no_extra)}</td><td class="num">—</td></tr>
        <tr><td>Most-behind hall first</td><td class="num">${fmt(Rc.late_mw_weeks_most_behind_first)}</td><td class="num">${Math.round(100 * Rc.reduction_most_behind_first)}%</td></tr>
        <tr style="background:#fbfde6"><td><b>Greedy planner (this feature)</b></td><td class="num"><b>${fmt(Rc.late_mw_weeks_greedy)}</b></td><td class="num"><b>${Math.round(100 * Rc.reduction_greedy)}%</b></td></tr></tbody></table></div>
  </div></div>`;
  bindTabs();
}

// ---------------------------------------------------------------- misc
let tT;
function toast(m) { let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); } t.textContent = m; clearTimeout(tT); tT = setTimeout(() => t.remove(), 2400); }
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); toast('Downloaded ' + name); }
function toggleKeys() {
  const k = $('.keys'); if (k) { k.remove(); return; }
  const d = document.createElement('div'); d.className = 'keys'; d.setAttribute('role', 'dialog');
  d.innerHTML = '<b style="display:block;margin-bottom:6px">Keyboard shortcuts</b>' + [['1–6', 'Open data hall'], ['P', 'Plan recovery'], ['A', 'Apply plan'], ['B', 'Forecast accuracy'], ['Esc', 'Close'], ['?', 'This list']].map(([a, b]) => `<div><span>${b}</span><kbd>${a}</kbd></div>`).join('');
  document.body.appendChild(d);
}
document.addEventListener('keydown', (e) => {
  if (!S.d || e.metaKey || e.ctrlKey || e.altKey || e.target.matches('input, textarea, select')) return;
  if (e.key === 'Escape') { if ($('.keys')) $('.keys').remove(); else if (layer.innerHTML) closeHall(); return; }
  if (e.key === '?') return toggleKeys();
  if (/^[1-6]$/.test(e.key)) return go('readiness', { hall: 'DH' + e.key });
  if (e.key === 'b') return go('backtest');
  if (e.key === 'p') { const b = $('#runPlan'); if (b && !b.disabled) b.click(); }
  if (e.key === 'a') { const b = $('#applyPlan'); if (b) b.click(); }
});
$('#dot').addEventListener('click', () => {
  if (!S.d) return;
  const fc = forecasts(S.applied); let w = 0; fc.forEach((x, i) => { if (x.p < fc[w].p) w = i; });
  toast(`Dot: ${S.d.halls[w].name} has the lowest on-time chance (${Math.round(100 * fc[w].p)}%); it is gated by ${S.acts[fc[w].driver].name.toLowerCase()}.`);
});
$('#bldg').addEventListener('click', () => toast('Only Building B is in this demo'));
boot();
