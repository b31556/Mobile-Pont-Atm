'use strict';
/* Pont admin: plain JS client for the server's JSON API. */

const root = document.getElementById('root');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, r = document) => r.querySelector(s);

const state = { reportId: null, tl: { zoom: 70, days: null, scroll: null, atEnd: true }, page: 'cards', q: '', drawer: null, modal: null, toast: '', loginError: '', data: {}, suggestions: [], zones: [], zoneId: null, devices: [], progDraft: null, jsonImport: null };
/* In the Pont Admin app the sign-in is kept in the app's own storage (the server gives that token a week); in a browser it ends with the tab. */
const tokenStore = () => (window.PontNative ? localStorage : sessionStorage);
let token = null;
try { token = tokenStore().getItem('pont-token'); } catch {}
let liveState = 'off';   // off | connecting | live | waiting | offline
const LIVE_LABELS = { connecting: 'Connecting…', live: 'Live', waiting: 'Update waiting', offline: 'Offline, retrying…' };

/* ---------- api ---------- */
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (method === 'GET') opts.cache = 'no-store';   // /public/program is cached for 30 s; an admin must see what is really stored
  if (token) opts.headers.authorization = 'Bearer ' + token;
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, opts); } catch { throw new Error('No connection to the server.'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && token) { signOut(); throw new Error(data?.error || 'Sign in again.'); }
  if (!res.ok) throw new Error(data?.error || 'Something went wrong (' + res.status + ').');
  return data;
}
function signOut() {
  disconnectLive();
  token = null; try { sessionStorage.removeItem('pont-token'); localStorage.removeItem('pont-token'); } catch {}
  photoCache.clear(); render();
}

/* Photos need the Authorization header, so <img> tags are filled from blobs. */
const photoCache = new Map();
async function loadPhotos() {
  for (const img of document.querySelectorAll('img[data-photo]')) {
    const url = img.dataset.photo;
    if (!photoCache.has(url)) {
      photoCache.set(url, fetch(url, { headers: { authorization: 'Bearer ' + token } })
        .then(r => r.ok ? r.blob() : Promise.reject()).then(b => URL.createObjectURL(b)).catch(() => ''));
    }
    photoCache.get(url).then(src => { if (src && img.isConnected) img.src = src; });
  }
}
const avatar = (card, cls = '') => `<img class="av ${cls}" alt="${esc(card.name)}" data-photo="${esc(card.photoUrl)}${card.hasPhoto ? '?p=' + esc(card.lastPhoto || '') : ''}">`;
// Cache key must change when a photo is replaced; photoUrl carries a version suffix the server ignores.

/* ---------- copy ---------- */
async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;top:0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); return ok;
}

/* ---------- format ---------- */
function when(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso), today = new Date();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? 'Today ' + hm : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + hm;
}
const signed = n => (n > 0 ? '+' : '−') + Math.abs(n);
const statusPill = s => s === 'blocked' ? '<span class="pill bad">Blocked</span>' : '<span class="pill ok">Active</span>';
function toast(msg) { state.toast = msg; render(); setTimeout(() => { state.toast = ''; render(); }, 2600); }
async function guard(fn) { try { await fn(); } catch (e) { toast(e.message); } }

/* ---------- data ---------- */
async function load() {
  const p = state.page;
  state.suggestions = await api('GET', '/card-suggestions');
  state.zones = await api('GET', '/zones');
  state.devices = await api('GET', '/devices');
  if (!state.zones.some(z => z.id === state.zoneId)) state.zoneId = state.zones[0]?.id ?? null;
  if (p === 'cards') {
    const [cards, tx] = await Promise.all([api('GET', '/cards?q=' + encodeURIComponent(state.q)), api('GET', '/transactions?limit=200')]);
    const all = state.q ? await api('GET', '/cards') : cards;
    state.data = { cards, all, tx };
  } else if (p === 'terminals' || p === 'readers') state.data = { terminals: await api('GET', '/terminals') };
  else if (p === 'txns') state.data = { tx: await api('GET', '/transactions?limit=100') };
  else if (p === 'report') state.data = { report: await api('GET', '/cards/' + state.reportId + '/report') };
  else if (p === 'presence') {
    state.data = { sessions: await api('GET', '/presence/sessions') };
  }
  else if (p === 'program') state.data = { program: await api('GET', '/public/program') };
  else state.data = { staff: await api('GET', '/staff') };
}
async function refresh() { try { await load(); } catch (e) { if (token) state.toast = e.message; } render(); }

/* ---------- views ---------- */
function loginView() {
  return `<div class="login-wrap"><form class="alogin" id="login">
    <div class="brand" style="color:var(--ink)"><img class="coin" src="/site-assets/img/logo-mark.svg" alt="" width="26" height="26">Pont admin</div>
    <h1>Sign in</h1>
    <label class="field">Email<input name="email" type="email" autocomplete="username" required></label>
    <label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label>
    ${state.loginError ? `<p class="err" role="alert">${esc(state.loginError)}</p>` : ''}
    <button class="btn green" style="justify-content:center">Sign in</button>
    ${inApp() ? `<div class="or"><span>or</span></div><button class="btn line" type="button" data-act="keylogin" style="justify-content:center">${NFC_ICON} Sign in with a key</button>` : ''}
  </form></div>`;
}

function shell(inner) {
  const item = (id, l) => `<button data-go="${id}" aria-current="${state.page === id || (id === 'cards' && state.page === 'report')}">${l}${id === 'cards' && state.suggestions.length ? `<span class="badge" title="Suggested cards">${state.suggestions.length}</span>` : ''}${id === 'readers' && state.devices.some(d => d.status === 'pending') ? `<span class="badge" title="Waiting for approval">${state.devices.filter(d => d.status === 'pending').length}</span>` : ''}</button>`;
  return `<div class="adm"><aside class="side"><div class="brand"><img class="coin" src="/site-assets/img/logo-mark.svg" alt="" width="26" height="26">Pont admin</div>
    ${item('cards', 'Cards')}${item('terminals', 'Terminals')}${item('readers', 'Readers')}${item('presence', 'Check-in')}${item('program', 'Program')}${item('txns', 'Transactions')}${item('staff', 'Staff')}
    <div class="me"><div class="live" id="live" data-state="${liveState}" title="Pages update by themselves when something changes">${LIVE_LABELS[liveState] || ''}</div><button data-act="signout">Sign out</button></div></aside>
    <div class="pane">${inner}</div></div>${state.drawer ? drawerView() : ''}${state.modal ? modalView() : ''}
    ${state.toast ? `<div class="atoast" role="status">${esc(state.toast)}</div>` : ''}`;
}

function cardsPane() {
  const { cards = [], all = [], tx = [] } = state.data;
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const given = tx.filter(t => t.type === 'give' && t.status === 'ok' && new Date(t.createdAt) >= midnight).reduce((s, t) => s + t.amount, 0);
  const active = all.filter(c => c.status === 'active').length;
  const rows = cards.length ? cards.map(c => `<tr data-act="edit" data-id="${c.id}">
      <td><div class="hold">${avatar(c)}${esc(c.name)}</div></td><td class="mono">${esc(c.uid)}</td>
      <td class="num">${c.balance}</td><td>${statusPill(c.status)}</td><td style="color:var(--ink-2)">${esc(when(c.lastUsed))}</td>
      <td><div class="rowbtns"><button class="btn line sm" data-act="report" data-id="${c.id}">Report</button><button class="btn line sm" data-act="toggle" data-id="${c.id}">${c.status === 'blocked' ? 'Unblock' : 'Block'}</button></div></td></tr>`).join('')
    : `<tr><td colspan="6" class="empty">${state.q ? 'No card matches “' + esc(state.q) + '”. Try a name or a UID.' : 'No cards yet. Add the first one.'}</td></tr>`;
  return `${suggestionsPanel()}<div class="ph"><div><h1>Cards</h1><p>${active} active, ${all.length - active} blocked</p></div><span class="sp"></span>
    <span class="withbtn searchbox"><input class="search" id="q" placeholder="Search name or UID" value="${esc(state.q)}" aria-label="Search cards">${nfcButton('q')}</span>
    <button class="btn line" data-act="importcards">Import cards</button>
    <button class="btn green" data-act="newcard">Add card</button></div>
    <div class="stats"><div class="stat"><b>${all.reduce((s, c) => s + c.balance, 0)}</b><span>Points on cards</span></div>
    <div class="stat"><b>${given}</b><span>Given today, after storno</span></div><div class="stat"><b>${active}</b><span>Active cards</span></div></div>
    <div class="tw"><table class="cardtable"><thead><tr><th>Holder</th><th>Card UID</th><th>Points</th><th>Status</th><th>Last used</th><th></th></tr></thead><tbody id="rows">${rows}</tbody></table></div>`;
}

function suggestionsPanel() {
  const list = state.suggestions || [];
  if (!list.length) return '';
  return `<section class="suggest" aria-label="Suggested cards"><h2>Suggested cards <span class="badge">${list.length}</span></h2>
    <p>Tapped at a terminal but not registered. Add one to give it a holder and a photo.</p>
    ${list.map(x => `<div class="srow"><code class="mono uid">${esc(x.uid)}</code>
      <span class="swhen">${x.count > 1 ? 'tapped ' + x.count + '× · ' : ''}${esc(x.terminal || 'a terminal')} · ${esc(when(x.lastSeen))}</span>
      <span class="rowbtns"><button class="btn line sm" data-act="copyuid" data-uid="${esc(x.uid)}">Copy UID</button>
      <button class="btn green sm" data-act="addsuggested" data-uid="${esc(x.uid)}">Add as card</button>
      <button class="btn line sm" data-act="dismiss" data-uid="${esc(x.uid)}" aria-label="Dismiss ${esc(x.uid)}">Dismiss</button></span></div>`).join('')}</section>`;
}

const PREVIEW_MINUTES = [5, 10, 12, 15, 20, 30, 45, 60, 90, 120, 240, 480];
const ROUNDING_LABELS = {
  down: 'Round down: only full blocks count',
  up: 'Round up: any started block counts',
  nearest: 'Round to nearest: half a block rounds up',
  prorata: 'Exact: pay per minute, rounded to whole points',
};

function presencePane() {
  const { sessions } = state.data;
  const zone = state.zones.find(z => z.id === state.zoneId);
  if (!zone || !sessions) return '';
  const c = zone.settings;
  const field = (id, label, value, hint, extra = '') => `<label class="field"><span>${label}</span><input id="${id}" type="number" min="0" step="1" value="${value ?? ''}" ${extra}>${hint ? `<small>${hint}</small>` : ''}</label>`;
  const chips = state.zones.map(z => `<button class="zonechip" data-act="pickzone" data-id="${z.id}" aria-pressed="${z.id === zone.id}"><b>${esc(z.name)}</b>
      <span>${z.terminals} point${z.terminals === 1 ? '' : 's'} · ${z.inside} inside</span></button>`).join('');
  const inside = sessions.inside.length ? sessions.inside.map(x => `<tr><td><div class="hold">${avatar({ ...x.card, hasPhoto: false })}<a href="#" class="holdlink" data-act="report" data-id="${esc(x.card.id)}">${esc(x.card.name)}</a></div></td>
      <td>${esc(x.zone)}</td><td>${esc(when(x.inAt))}<div class="subnote">${esc(x.terminal)}</div></td><td class="num">${x.minutes} min${x.overdue ? ' <span class="pill bad">Overdue</span>' : ''}</td>
      <td class="num">${x.overdue ? '—' : '+' + x.wouldEarn}</td>
      <td><div class="rowbtns"><button class="btn line sm" data-act="presenceclose" data-id="${x.id}" data-award="1"${x.overdue ? ' title="Too long to count, so no points are paid"' : ''}>${x.overdue ? 'Close, no points' : 'Sign out'}</button><button class="btn line sm" data-act="presenceclose" data-id="${x.id}" data-award="0">Discard</button></div></td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">Nobody is signed in right now.</td></tr>';
  const recent = sessions.recent.length ? sessions.recent.map(x => `<tr><td><div class="hold">${avatar({ ...x.card, hasPhoto: false })}<a href="#" class="holdlink" data-act="report" data-id="${esc(x.card.id)}">${esc(x.card.name)}</a></div></td>
      <td>${esc(x.zone)}</td><td>${esc(when(x.inAt))}</td><td>${x.outAt ? esc(when(x.outAt)) : '—'}<div class="subnote">${esc(x.terminal)}</div></td>
      <td class="num">${x.minutes ?? '—'}${x.minutes != null ? ' min' : ''}</td><td class="num">${x.points ? '+' + x.points : '0'}</td>
      <td>${x.status === 'closed' ? '<span class="pill ok">Signed out</span>' : x.status === 'expired' ? '<span class="pill bad">Forgotten</span>' : '<span class="pill mute">Discarded</span>'}</td>
      <td>${x.status === 'closed' ? `<button class="btn line sm" data-act="undovisit" data-id="${x.id}">Cancel check-out</button>` : ''}</td></tr>`).join('')
    : '<tr><td colspan="8" class="empty">No visits yet.</td></tr>';
  return `<div class="ph"><div><h1>Check-in</h1><p>Points for time spent inside. Each zone has its own rules; each check-in terminal belongs to one zone (set that under Terminals).</p></div><span class="sp"></span>
      <button class="btn line" data-act="refresh">Refresh</button><button class="btn line" data-act="zonesimport">Import JSON</button><button class="btn line" data-act="zonesexport">Export JSON</button><button class="btn green" data-act="newzone">Add zone</button></div>
    <div class="zonechips" role="group" aria-label="Zones">${chips}</div>
    <div class="twocol">
      <form class="panel" id="rules" autocomplete="off"><h2>Rules for ${esc(zone.name)}</h2>
        <label class="field"><span>Zone name</span><input id="r-name" value="${esc(zone.name)}" maxlength="60" required></label>
        <div class="grid2">
          ${field('r-points', 'Points per block', c.pointsPerBlock, '', 'min="1"')}
          ${field('r-block', 'Block length (minutes)', c.blockMinutes, '', 'min="1"')}
        </div>
        <label class="field"><span>Partial blocks</span><select id="r-round">${Object.entries(ROUNDING_LABELS).map(([v, l]) => `<option value="${v}"${c.rounding === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <div class="grid2">
          ${field('r-min', 'Minimum stay (minutes)', c.minMinutes, 'Shorter visits earn nothing')}
          ${field('r-stay', 'Longest stay (hours)', c.maxStayHours, 'A visit longer than this earns nothing', 'min="1"')}
          ${field('r-visit', 'Max points per visit', c.maxPointsVisit, 'Leave empty for no limit', 'min="1" placeholder="No limit"')}
          ${field('r-day', 'Max points per 24 hours', c.maxPoints24h, 'Per card, in this zone. Empty for no limit', 'min="1" placeholder="No limit"')}
          ${field('r-lock', 'Re-tap lock-out (seconds)', c.cooldownSeconds, 'A tap this soon after checking in changes nothing')}
        </div>
        <p class="err" id="r-err" role="alert"></p>
        <div class="formbtns"><button class="btn green" type="submit">Save zone</button>
          <button class="btn line" type="button" data-act="delzone" data-id="${zone.id}" data-name="${esc(zone.name)}">Delete zone</button></div>
      </form>
      <section class="panel"><h2>What a visit earns</h2><p class="hint">Calculated by the server from the rules as you type. The 24-hour limit isn’t included.</p>
        <table class="mini-table"><thead><tr><th>Stay</th><th>Points</th></tr></thead><tbody id="preview"></tbody></table></section>
    </div>
    <div class="secthead"><h2 class="sect">Inside now</h2><span class="sp"></span>${zone.inside ? `<button class="btn line sm" data-act="closeall" data-id="${zone.id}" data-award="1">Sign out everyone in ${esc(zone.name)}</button><button class="btn line sm" data-act="closeall" data-id="${zone.id}" data-award="0">Discard everyone in ${esc(zone.name)}</button>` : ''}</div>
    <div class="tw"><table><thead><tr><th>Holder</th><th>Zone</th><th>Since</th><th>Time inside</th><th>Would earn</th><th></th></tr></thead><tbody>${inside}</tbody></table></div>
    <h2 class="sect">Recent visits</h2>
    <div class="tw"><table><thead><tr><th>Holder</th><th>Zone</th><th>In</th><th>Out</th><th>Time</th><th>Points</th><th></th><th></th></tr></thead><tbody>${recent}</tbody></table></div>`;
}

/** The rules as currently typed in the form (not yet saved). Empty caps mean no limit. */
function draftRules() {
  const n = id => { const v = document.getElementById(id).value.trim(); return v === '' ? null : Number(v); };
  return { pointsPerBlock: n('r-points'), blockMinutes: n('r-block'), rounding: document.getElementById('r-round').value, minMinutes: n('r-min'),
    maxPointsVisit: n('r-visit'), maxPoints24h: n('r-day'), maxStayHours: n('r-stay'), cooldownSeconds: n('r-lock') };
}

let previewTimer = null, previewSeq = 0;
function refreshPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const body = document.getElementById('preview'); if (!body || state.page !== 'presence') return;
    const seq = ++previewSeq;
    try {
      const rows = await api('POST', '/presence/preview', { settings: draftRules(), minutes: PREVIEW_MINUTES });
      if (seq !== previewSeq || !document.getElementById('preview')) return;
      body.innerHTML = rows.map(r => `<tr><td>${r.minutes < 60 ? r.minutes + ' min' : (r.minutes / 60) + ' h'}</td><td class="num">${r.awarded}${r.cappedBy === 'visit' ? ' <span class="pill amber">visit limit</span>' : ''}</td></tr>`).join('');
    } catch (e) {
      if (seq === previewSeq && document.getElementById('preview')) document.getElementById('preview').innerHTML = `<tr><td colspan="2" class="err">${esc(e.message)}</td></tr>`;
    }
  }, 150);
}

const FIXED_FIELDS = [
  ['amount', 'Points per tap', 'min="1"', ''],
  ['cooldownSeconds', 'Seconds between taps', 'min="0"', 'Per card. 0 = no wait'],
  ['maxUses24h', 'Max taps per 24 hours', 'min="1" placeholder="No limit"', 'Per card'],
  ['maxPoints24h', 'Max points per 24 hours', 'min="1" placeholder="No limit"', 'Per card'],
  ['maxUsesTotal', 'Max taps ever', 'min="1" placeholder="No limit"', 'Per card, for good'],
];

/** Someone used this reader's id with a different secret: either the reader was reset, or something is imitating it. */
function warnDenied(d) {
  return d && d.denied ? `<br><span class="warnline">⚠ ${d.denied.count} attempt${d.denied.count === 1 ? '' : 's'} to use this id with a different secret, last from ${esc(d.denied.ip || '?')}. If the reader was reset, forget it and let it register again; otherwise something is imitating it.</span>` : '';
}

function readersPane() {
  const devices = state.devices || [];
  const terminals = (state.data.terminals || []).filter(t => t.kind === 'device');
  const pending = devices.filter(d => d.status === 'pending');
  const revoked = devices.filter(d => d.status === 'revoked');
  const deviceOf = t => devices.find(d => d.terminal && d.terminal.id === t.id);
  const waiting = pending.length ? `<section class="suggest" aria-label="Waiting for approval"><h2>Waiting for approval <span class="badge">${pending.length}</span></h2>
    <p>These readers found the server by themselves. Each one shows a 4-digit code on its display: approve the one whose code matches. A reader that is still switched on registers again within seconds if you reject it, and waiting readers that go quiet are dropped after 15 minutes.${pending.length >= 20 ? ' <b>The limit of 20 waiting readers is reached, so new ones can’t register until you approve or reject some.</b>' : ''}</p>
    ${pending.map(d => `<form class="srow" data-approve="${esc(d.id)}"><span class="paircode" title="This code is on the reader's display">${esc(d.code || '----')}</span><code class="mono uid">${esc(d.id)}</code>
      <span class="swhen">${esc(d.ip || '?')} · firmware ${esc(d.firmware || '?')} · ${d.online ? 'online' : 'last seen ' + esc(when(d.lastSeen))}${warnDenied(d)}</span>
      <input name="name" class="search" placeholder="Name, e.g. Entrance" required maxlength="60" aria-label="Name for ${esc(d.id)}" style="min-width:150px">
      <select name="mode" class="modesel" aria-label="Mode"><option value="fixed">Fixed amount</option><option value="presence">Check-in</option><option value="info">Info kiosk</option></select>
      <span class="rowbtns"><button class="btn green sm">Approve</button><button class="btn line sm" type="button" data-act="rejectdevice" data-id="${esc(d.id)}">Reject</button></span></form>`).join('')}</section>` : '';
  const cards = terminals.length ? terminals.map(t => {
    const d = deviceOf(t);
    const online = d?.online;
    const f = t.fixed;
    const config = t.mode === 'info'
      ? '<p class="hint">Info kiosk: tapping a card shows its points on the digit display, and everything (photo, points, recent history) on a display page if one is open. Nothing is given or changed.</p>'
      : t.mode === 'fixed'
      ? `<form class="fixedform" data-reader="${t.id}"><div class="grid3">${FIXED_FIELDS.map(([k, label, attrs, hint]) => `<label class="field"><span>${label}</span><input name="${k}" type="number" step="1" value="${f[k] ?? ''}" ${attrs}>${hint ? `<small>${hint}</small>` : ''}</label>`).join('')}</div>
          <p class="err" role="alert"></p><button class="btn green sm">Save rules</button></form>`
      : `<div class="pointsel inline-sel"><label class="field"><span>Zone</span><select class="modesel" data-zone-for="${t.id}">${state.zones.map(z => `<option value="${z.id}"${z.id === t.zoneId ? ' selected' : ''}>${esc(z.name)}</option>`).join('')}</select></label>
          <label class="field"><span>Point type</span><select class="modesel" data-dir-for="${t.id}"><option value="toggle"${t.direction === 'toggle' ? ' selected' : ''}>Toggle (in / out)</option><option value="in"${t.direction === 'in' ? ' selected' : ''}>Sign in only</option><option value="out"${t.direction === 'out' ? ' selected' : ''}>Sign out only</option></select></label></div>
          <p class="hint">The rules of the zone are edited under Check-in.</p>`;
    return `<section class="panel reader"><div class="rhead"><div><h2>${esc(t.name)}</h2><p class="hint">${esc(t.ip || d?.ip || 'no address yet')}${warnDenied(d)} · firmware ${esc(t.firmware || d?.firmware || '?')} · ${online ? '<span class="pill ok">Online</span>' : '<span class="pill mute">Offline' + (d ? ', seen ' + esc(when(d.lastSeen)) : '') + '</span>'}</p></div>
        <span class="sp"></span><div class="rowbtns"><label class="field modefield"><span>Mode</span><select class="modesel" data-rmode-for="${t.id}"><option value="fixed"${t.mode === 'fixed' ? ' selected' : ''}>Fixed amount</option><option value="presence"${t.mode === 'presence' ? ' selected' : ''}>Check-in</option><option value="info"${t.mode === 'info' ? ' selected' : ''}>Info kiosk</option></select></label>
        <button class="btn line sm" data-act="revokedevice" data-id="${esc(d?.id || '')}" data-name="${esc(t.name)}">Revoke</button></div></div>
      ${config}<p class="hint">Given today: <b>${t.givenToday}</b> points</p>
      <div class="displaylink"><span class="lbl">Display page</span>
        <span class="codebox" title="Type this code at the address below">${esc(t.displayCode)}</span>
        <button class="btn line sm" data-act="copycode" data-code="${esc(t.displayCode)}">Copy code</button>
        <button class="btn line sm" data-act="newcode2" data-id="${t.id}" data-name="${esc(t.name)}">New code</button>
        <a class="btn line sm" href="/display" target="_blank" rel="noopener">Open the display page</a>
        <label class="cbox"><input type="checkbox" data-beep-for="${t.id}"${t.displayBeep ? ' checked' : ''}> Beep on the display</label>
        <label class="cbox"><input type="checkbox" data-cancel-for="${t.id}"${t.displayCancel ? ' checked' : ''}> Allow Cancel on the display page</label>
        <p class="hint">On the screen next to the reader, go to <b>${esc(location.origin)}/display</b> and type the code. The screen then stays signed in until you press New code or revoke the reader. Anyone who knows the code can watch who taps (photo, name, points), so don’t post it publicly. With Cancel on, a button on the screen undoes the last tap (a grant, check-in or check-out), so switch it on only for a screen that is staffed or out of reach. On another device use this computer’s network address instead of “${esc(location.hostname)}”.</p></div></section>`;
  }).join('') : '<p class="empty">No readers yet. Power one on with the firmware set to this server and it will show up above.</p>';
  const gone = revoked.length ? `<h2 class="sect">Revoked</h2><div class="tw"><table><tbody>${revoked.map(d => `<tr><td class="mono">${esc(d.id)}</td><td>${esc(d.ip || '')}</td><td><button class="btn line sm" data-act="rejectdevice" data-id="${esc(d.id)}">Forget</button></td></tr>`).join('')}</tbody></table></div>` : '';
  return `<div class="ph"><div><h1>Readers</h1><p>ESP32 card readers on your network. Each one gives a fixed number of points per tap, or signs people in and out.</p></div><span class="sp"></span><button class="btn line" data-act="refresh">Refresh</button></div>
    ${waiting}<div class="readers">${cards}</div>${gone}`;
}

function terminalsPane() {
  const list = (state.data.terminals || []).filter(t => t.kind !== 'device');
  return `<div class="ph"><div><h1>Terminals</h1><p>A paired phone is a terminal. In ATM mode it gives points for an amount. In Info kiosk mode it shows a card's points and history when tapped and changes nothing. In Check-in mode it signs people in and out: pick its zone (which decides the rules) and whether it signs in, signs out, or toggles. A phone follows a mode change within about 30 seconds.</p></div><span class="sp"></span>
    <button class="btn line" data-act="newbatch">Pair many phones</button><button class="btn green" data-act="newterm">Pair a phone</button></div>
    <div class="tw"><table><thead><tr><th>Terminal</th><th>Status</th><th>Mode</th><th>Check-in point</th><th>Phone</th><th>App</th><th>Given today</th><th title="Most points this phone can give in any hour. Empty means no limit.">Hourly limit</th><th></th></tr></thead><tbody>
    ${list.length ? list.map(t => `<tr><td><b>${esc(t.name)}</b><div style="font-size:12px;color:var(--ink-3)">${esc(t.place)}</div></td>
      <td>${t.online ? '<span class="pill ok">Online</span>' : '<span class="pill mute">Offline</span>'}<div style="font-size:12px;color:var(--ink-3)">${t.lastSeen ? esc(when(t.lastSeen)) : 'Never seen'}</div></td>
      <td><select class="modesel" data-mode-for="${t.id}" aria-label="Mode of ${esc(t.name)}"><option value="atm"${t.mode === 'atm' ? ' selected' : ''}>ATM</option><option value="presence"${t.mode === 'presence' ? ' selected' : ''}>Check-in</option><option value="info"${t.mode === 'info' ? ' selected' : ''}>Info kiosk</option></select></td>
      <td>${t.mode === 'presence' ? `<div class="pointsel"><select class="modesel" data-zone-for="${t.id}" aria-label="Zone of ${esc(t.name)}">${state.zones.map(z => `<option value="${z.id}"${z.id === t.zoneId ? ' selected' : ''}>${esc(z.name)}</option>`).join('')}</select>
        <select class="modesel" data-dir-for="${t.id}" aria-label="Point type of ${esc(t.name)}"><option value="toggle"${t.direction === 'toggle' ? ' selected' : ''}>Toggle (in / out)</option><option value="in"${t.direction === 'in' ? ' selected' : ''}>Sign in only</option><option value="out"${t.direction === 'out' ? ' selected' : ''}>Sign out only</option></select></div>` : '<span style="color:var(--ink-3)">—</span>'}</td>
      <td style="color:var(--ink-2)">${esc(t.device || '—')}</td>
      <td class="mono">${esc(t.appVersion || '—')}</td><td class="num">${t.givenToday}</td>
      <td><input class="search" type="number" min="1" step="1" style="width:90px;min-width:0" placeholder="No limit" value="${t.chargeLimitHour ?? ''}" data-limit-for="${t.id}" aria-label="Hourly points limit of ${esc(t.name)}"></td>
      <td><div class="rowbtns"><button class="btn line sm" data-act="newcode" data-id="${t.id}">New code</button><button class="btn line sm" data-act="revoke" data-id="${t.id}" data-name="${esc(t.name)}">Revoke</button></div></td></tr>`).join('')
      : '<tr><td colspan="9" class="empty">No terminals yet. Pair the first phone.</td></tr>'}
    </tbody></table></div>`;
}

function txnsPane() {
  const tx = state.data.tx || [];
  return `<div class="ph"><div><h1>Transactions</h1><p>Newest first. Includes points admins granted or took away by hand. Storno adds a reversing row and keeps the original.</p></div></div>
    <div class="tw"><table><thead><tr><th>Time</th><th>ID</th><th>Holder</th><th>Points</th><th>Terminal</th><th>Operator</th><th>Status</th><th></th></tr></thead><tbody>
    ${tx.length ? tx.map(t => `<tr><td>${esc(when(t.createdAt))}</td><td class="mono">${t.type === 'adjust' ? 'Adjustment' : 'T-' + t.id}</td>
      <td><div class="hold">${avatar({ ...t.card, hasPhoto: false })}<a href="#" class="holdlink" data-act="report" data-id="${esc(t.card.id)}">${esc(t.card.name)}</a></div></td>
      <td class="num ${t.amount < 0 ? 'neg' : ''}">${signed(t.amount)}${t.kind === 'presence' ? `<div class="subnote">Check-out · ${esc(t.note || '')}${t.zone ? ' · ' + esc(t.zone) : ''}</div>` : ''}${t.type === 'adjust' ? `<div class="subnote">${esc(t.note || 'No reason given')}</div>` : ''}</td><td>${esc(t.terminal || '—')}</td><td>${esc(t.operator || '—')}</td>
      <td>${t.type === 'adjust' ? `<span class="pill amber">${t.amount > 0 ? 'Admin grant' : 'Admin deduction'}</span>` : t.type === 'storno' ? `<span class="pill amber">Storno of T-${t.ref}</span>` : t.status === 'stornoed' ? '<span class="pill mute">Stornoed</span>' : '<span class="pill ok">Completed</span>'}</td>
      <td>${t.type === 'give' && t.status === 'ok' ? `<button class="btn line sm" data-act="storno" data-id="${t.id}">Storno</button>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="8" class="empty">No transactions yet.</td></tr>'}
    </tbody></table></div>`;
}

function staffPane() {
  const list = state.data.staff || [];
  return `<div class="ph"><div><h1>Staff</h1><p>People who can sign in to this admin site. Phones don’t need a person to sign in. An admin can also have a sign-in key: a card or tag that signs them in on the Pont Admin app.</p></div><span class="sp"></span><button class="btn green" data-act="newstaff">Add admin</button></div>
    <div class="tw"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Sign-in key</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(s => `<tr><td><b>${esc(s.name)}</b></td><td class="mono">${esc(s.email)}</td><td>${s.role === 'admin' ? 'Admin' : 'Operator (old sign-in)'}</td>
      <td>${s.role !== 'admin' ? '<span class="mute">—</span>' : s.hasKey ? `<span class="pill ok">Key set ${esc(s.keyHint || '')}</span>` : '<span class="mute">None</span>'}</td>
      <td>${s.active ? '<span class="pill ok">Active</span>' : '<span class="pill mute">Switched off</span>'}</td>
      <td><div class="rowbtns"><button class="btn line sm" data-act="resetpw" data-id="${s.id}">Reset password</button>${s.role === 'admin' ? `<button class="btn line sm" data-act="staffkey" data-id="${s.id}">${s.hasKey ? 'Change key' : 'Set key'}</button>` : ''}<button class="btn line sm" data-act="staffactive" data-id="${s.id}" data-on="${s.active ? 1 : 0}">${s.active ? 'Switch off' : 'Switch on'}</button></div></td></tr>`).join('')}
    </tbody></table></div>`;
}

/* ---------- program ---------- */
const PROGRAM_MODELS = { rate: 'Points per time (rate)', tasks: 'A list of tasks', flat: 'Fixed award for staying to the end' };
const KIND_LABELS = { time: 'Time', task: 'Task', mix: 'Mix' };

function programPane() {
  const doc = state.data.program;
  if (!doc) return '';
  const P = PontProgram, draft = state.progDraft || P.settingsForm(doc);
  const dayRows = draft.days.map((d, i) => `<div class="dayrow2" data-dayrow data-new="${d.isNew ? 1 : 0}">
      <label class="field"><span>Key</span><input data-k="key" value="${esc(d.key)}" maxlength="12" autocapitalize="off" placeholder="day3"${d.isNew ? '' : ' readonly title="The key of a day can’t change, because events refer to it"'}></label>
      <label class="field"><span>Label</span><input data-k="label" value="${esc(d.label)}" maxlength="30" placeholder="Day 3"></label>
      <label class="field"><span>Date</span><input data-k="date" type="date" value="${esc(d.date)}"></label>
      <button class="btn line sm" type="button" data-act="rmday" data-i="${i}" aria-label="Remove day ${esc(d.label || d.key)}"${draft.days.length < 2 ? ' disabled' : ''}>Remove</button></div>`).join('');
  const groups = P.groups(doc).map(g => `<tr class="dayhead"><td colspan="5"><b>${g.day ? esc(g.day.label) : 'Other'}</b>${g.day ? ' · ' + esc(g.day.date) : ' · events on a day that is not in the program'} · ${plural(g.events.length, 'event')}</td></tr>`
    + (g.events.length ? g.events.map(e => `<tr data-act="editevent" data-id="${esc(e.id)}">
      <td><b>${esc(e.title)}</b>${e.kind ? ` <span class="pill mute">${esc(KIND_LABELS[e.kind] || e.kind)}</span>` : ''}<div class="subnote mono">${esc(e.id)}</div></td>
      <td class="nowrap">${esc(P.timeRange(e))}</td><td>${esc(e.room)}</td><td>${esc(P.summary(e))}</td>
      <td><div class="rowbtns"><button class="btn line sm" data-act="editevent" data-id="${esc(e.id)}">Edit</button><button class="btn line sm" data-act="delevent" data-id="${esc(e.id)}" data-title="${esc(e.title)}">Delete</button></div></td></tr>`).join('')
      : '<tr class="none"><td colspan="5" class="empty">No events on this day yet.</td></tr>')).join('');
  return `<div class="ph"><div><h1>Program</h1><p>The event program that the website and the Pont Card app show: the days, the points goal and every event with how it scores. Every save replaces the whole program on the server.</p></div><span class="sp"></span>
      <button class="btn line" data-act="refresh">Refresh</button><button class="btn line" data-act="progimport">Import JSON</button><button class="btn line" data-act="progexport">Export JSON</button><button class="btn green" data-act="newevent">Add event</button></div>
    <form class="panel" id="progsettings" autocomplete="off"><h2>Settings</h2>
      <label class="field"><span>Program title</span><input id="p-title" value="${esc(draft.title)}" maxlength="80" required></label>
      <div class="grid3">
        <label class="field"><span>Points needed in all</span><input id="p-total" type="number" min="0" step="1" inputmode="numeric" value="${esc(draft.total)}"></label>
        <label class="field"><span>Day with its own minimum</span><select id="p-day">${goalDayOptions(draft)}</select></label>
        <label class="field"><span>Points needed on that day</span><input id="p-daymin" type="number" min="0" step="1" inputmode="numeric" value="${esc(draft.dayMin)}"></label>
      </div>
      <h3 class="sub">Days</h3>
      <div id="p-days">${dayRows}</div>
      <p class="err" id="p-err" role="alert"></p>
      <div class="formbtns"><button class="btn green" type="submit">Save settings</button><button class="btn line" type="button" data-act="addday"${draft.days.length >= 4 ? ' disabled title="A program has up to 4 days"' : ''}>Add a day</button></div>
    </form>
    <div class="secthead"><h2 class="sect">Events (${doc.events.length})</h2><span class="sp"></span>${doc.events.length ? '<button class="btn line sm" data-act="clearevents">Clear all events</button>' : ''}</div>
    <div class="tw"><table class="progtable"><thead><tr><th>Event</th><th>Time</th><th>Room</th><th>Scoring</th><th></th></tr></thead><tbody>${groups}</tbody></table></div>`;
}

const goalDayOptions = draft => draft.days.filter(d => d.key.trim()).map(d => { const k = d.key.trim().toLowerCase(); return `<option value="${esc(k)}"${k === draft.dayKey ? ' selected' : ''}>${esc(d.label || k)}</option>`; }).join('');

/** Copies what is typed in the settings form into the draft, so a redraw (a toast, an added day) never loses it. */
function readSettingsForm() {
  if (!$('#progsettings')) return;
  state.progDraft = { title: $('#p-title').value, total: $('#p-total').value, dayKey: $('#p-day').value, dayMin: $('#p-daymin').value,
    days: [...document.querySelectorAll('[data-dayrow]')].map(r => ({ key: r.querySelector('[data-k=key]').value, label: r.querySelector('[data-k=label]').value, date: r.querySelector('[data-k=date]').value, isNew: r.dataset.new === '1' })) };
}
/** The goal's day list follows the keys of the days as they are typed. */
function refreshGoalDays() {
  const sel = $('#p-day'); if (!sel || !state.progDraft) return;
  state.progDraft.dayKey = sel.value;
  sel.innerHTML = goalDayOptions(state.progDraft);
  state.progDraft.dayKey = sel.value;
}

/** Saves a change to the program: takes the program as the server has it now, lets [change] alter it (returns { doc } or { error }) and replaces it. */
async function saveProgram(change) {
  const r = change(PontProgram.clean(await api('GET', '/public/program')));
  if (r.error) throw new Error(r.error);
  state.data.program = await api('PUT', '/program', r.doc);
  return r;
}

function openEventDrawer(id) {
  const doc = state.data.program, e = id && doc.events.find(x => x.id === id);
  if (id && !e) return toast('That event is no longer in the program.');
  state.drawer = { kind: 'event', id: e ? e.id : null, form: e ? PontProgram.formFromEvent(e) : PontProgram.blankForm(doc), error: '' };
  render();
}

function eventDrawer() {
  const d = state.drawer, f = d.form, doc = state.data.program, isNew = !d.id;
  const input = (id, label, value, extra = '', hint = '') => `<label class="field"><span>${label}</span><input id="ev-${id}" value="${esc(value)}" ${extra}>${hint ? `<small>${hint}</small>` : ''}</label>`;
  const nums = (id, label, value, hint = '', extra = '') => input(id, label, value, `type="number" min="0" step="1" inputmode="numeric" ${extra}`, hint);
  const text = (id, label, value) => `<label class="field"><span>${label}</span><textarea id="ev-${id}" rows="2" maxlength="300">${esc(value)}</textarea></label>`;
  const sel = (id, label, options, value, hint = '') => `<label class="field"><span>${label}</span><select id="ev-${id}">${options.map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>${hint ? `<small>${hint}</small>` : ''}</label>`;
  let scoring = '';
  if (f.model === 'rate') {
    scoring = `<div class="grid2">${nums('rate', 'Points per block', f.rate, '', 'min="1"')}${nums('block', 'Block length (minutes)', f.block, '', 'min="1"')}</div>
      <div class="grid2">${nums('cap', 'Most points (optional)', f.cap, 'Empty for no limit', 'min="1"')}${nums('maxMin', 'Longest stay that counts (min, optional)', f.maxMin, '', 'min="1"')}</div>`;
  } else if (f.model === 'tasks') {
    scoring = `<div id="ev-items"><div class="itemrow head"><span>Task</span><span>Points</span><span>Min</span><span></span></div>
      ${f.items.map((r, i) => `<div class="itemrow" data-item><input data-k="name" value="${esc(r.name)}" maxlength="60" placeholder="Round 1" aria-label="Task ${i + 1} name"><input data-k="pts" type="number" min="0" step="1" inputmode="numeric" value="${esc(r.pts)}" aria-label="Task ${i + 1} points"><input data-k="min" type="number" min="1" step="1" inputmode="numeric" value="${esc(r.min)}" aria-label="Task ${i + 1} minutes"><button class="btn line sm" type="button" data-act="rmitem" data-i="${i}" aria-label="Remove task ${i + 1}">×</button></div>`).join('')}
      <button class="btn line sm" type="button" data-act="additem"${f.items.length >= 20 ? ' disabled' : ''}>Add a task</button></div>
      <div id="ev-home"><div class="itemrow home head"><span>Home task (optional)</span><span>Points</span><span></span></div>
      ${f.home.map((r, i) => `<div class="itemrow home" data-home><input data-k="name" value="${esc(r.name)}" maxlength="60" aria-label="Home task ${i + 1} name"><input data-k="pts" type="number" min="0" step="1" inputmode="numeric" value="${esc(r.pts)}" aria-label="Home task ${i + 1} points"><button class="btn line sm" type="button" data-act="rmhome" data-i="${i}" aria-label="Remove home task ${i + 1}">×</button></div>`).join('')}
      <button class="btn line sm" type="button" data-act="addhome"${f.home.length >= 10 ? ' disabled' : ''}>Add a home task</button></div>`;
  } else scoring = nums('cap', 'Points for staying to the end', f.cap, 'Paid only to people who stay for the whole event', 'min="1"');
  return `<div class="drawer-scrim" data-act="closedrawer"><form class="drawer" id="evform" data-stop autocomplete="off" novalidate>
    <h2>${isNew ? 'Add event' : 'Edit event'}</h2>
    ${isNew ? '' : `<p class="note mono">id: ${esc(d.id)} (stays the same)</p>`}
    ${input('title', 'Title', f.title, 'maxlength="100"')}
    ${sel('day', 'Day', doc.days.map(x => [x.key, `${x.label} (${x.date})`]), f.day)}${input('room', 'Room', f.room, 'maxlength="60"')}
    <div class="grid2">${input('from', 'From', f.from, 'type="time"')}${input('to', 'To', f.to, 'type="time"')}</div>
    ${sel('model', 'How it scores', Object.entries(PROGRAM_MODELS), f.model)}
    ${scoring}
    ${sel('kind', 'Kind (optional)', [['', 'Not set'], ['time', 'Time'], ['task', 'Task'], ['mix', 'Mix']], f.kind, 'A label the app can show')}
    <h3 class="sub">Text shown to visitors (optional)</h3>
    ${text('rule', 'Rule', f.rule)}${text('bonus', 'Bonus', f.bonus)}${text('bring', 'What to bring', f.bring)}${text('note', 'Note', f.note)}${text('check', 'Check', f.check)}
    <p class="err" id="ev-err" role="alert">${esc(d.error)}</p>
    <div class="inline"><button class="btn line" style="flex:1;justify-content:center" data-act="closedrawer" type="button">Cancel</button><button class="btn green" style="flex:1;justify-content:center" type="submit">${isNew ? 'Add event' : 'Save'}</button></div>
    ${isNew ? '' : `<button class="btn line" type="button" data-act="delevent" data-id="${esc(d.id)}" data-title="${esc(f.title)}" style="justify-content:center">Delete event</button>`}
  </form></div>`;
}

/** Copies what is typed in the event window into its draft (the draft is what is drawn again after any change). */
function readEventForm() {
  const d = state.drawer; if (!d || d.kind !== 'event' || !$('#evform')) return;
  for (const k of ['title', 'day', 'room', 'from', 'to', 'model', 'rate', 'block', 'cap', 'maxMin', 'kind', 'rule', 'bonus', 'bring', 'note', 'check']) {
    const el = document.getElementById('ev-' + k); if (el) d.form[k] = el.value;
  }
  const rows = (sel, keys) => [...document.querySelectorAll(sel)].map(r => Object.fromEntries(keys.map(k => [k, r.querySelector(`[data-k=${k}]`).value])));
  if ($('#ev-items')) { d.form.items = rows('[data-item]', ['name', 'pts', 'min']); d.form.home = rows('[data-home]', ['name', 'pts']); }
}
/** Draws the event window again (after a list or the model changed) without it jumping back to the top. */
function redrawDrawer(focusSel) {
  const top = $('.drawer') ? $('.drawer').scrollTop : 0;
  render();
  const dr = $('.drawer'); if (dr) { dr.style.animation = 'none'; dr.scrollTop = top; }
  const el = focusSel && $(focusSel); if (el) el.focus();
}

/* JSON in and out, for the program and for the zones */
const JSON_WHAT = {
  program: {
    exportTitle: 'Export program', file: () => `pont-program-${localStamp(new Date().toISOString()).slice(0, 10)}.json`,
    exportNote: 'The whole program as JSON. Copy it or download it; Import JSON takes the same text, here or on another server.',
    importTitle: 'Import program', example: () => JSON.stringify(PontProgram.EXAMPLE, null, 2),
    importNote: 'Paste the whole program as JSON: <code>title</code>, <code>days</code>, <code>goal</code> and <code>events</code>. It <b>replaces</b> the current program: title, days, goal and every event. If anything is wrong the server says what, and nothing changes.',
  },
  zones: {
    exportTitle: 'Export zones', file: () => `pont-zones-${localStamp(new Date().toISOString()).slice(0, 10)}.json`,
    exportNote: 'Every zone with its rules, as JSON. Copy it or download it; Import JSON takes the same text.',
    importTitle: 'Import zones', example: () => JSON.stringify(PontProgram.ZONES_EXAMPLE, null, 2),
    importNote: 'Paste zones as JSON: a list of <code>name</code> and <code>settings</code> (the rules of the zone, as in Export JSON). A zone whose name already exists (letter case does not matter) gets the new rules; any other name makes a new zone. Nothing is deleted. If any zone is wrong the server names it, and nothing changes.',
  },
};
function jsonExportModal(m) {
  const w = JSON_WHAT[m.what];
  return `<div class="modal-scrim" data-act="closemodal"><div class="modal wide import" data-stop>
    <h2>${w.exportTitle}</h2><p class="note">${w.exportNote}</p>
    <label class="field"><span class="sr">JSON</span><textarea id="json-out" readonly spellcheck="false" class="jsonbox">${esc(m.text)}</textarea></label>
    <div class="inline"><button class="btn line" style="flex:1;justify-content:center" data-act="jsoncopy">Copy</button><button class="btn green" style="flex:1;justify-content:center" data-act="jsondownload">Download</button><button class="btn" style="flex:1;justify-content:center" data-act="closemodal">Done</button></div></div></div>`;
}
function jsonImportModal(m) {
  const w = JSON_WHAT[m.what], im = state.jsonImport || { text: '', error: '' };
  return `<div class="modal-scrim"><form class="modal wide import" id="jsonimportform" data-stop autocomplete="off">
    <h2>${w.importTitle}</h2><p class="note">${w.importNote}</p>
    <label class="field"><span class="sr">JSON to import</span><textarea id="json-in" spellcheck="false" class="jsonbox" placeholder="Paste the JSON here">${esc(im.text)}</textarea></label>
    <details class="example"><summary>Example</summary><pre>${esc(w.example())}</pre><button class="btn line sm" type="button" data-act="jsonexample">Use this example</button></details>
    <p class="err" id="json-err" role="alert">${esc(im.error)}</p>
    <div class="inline"><button class="btn line" style="flex:1;justify-content:center" type="button" data-act="closemodal">Cancel</button><button class="btn green" style="flex:1;justify-content:center" type="submit">Import</button></div></form></div>`;
}

function drawerView() {
  const d = state.drawer;
  if (d.kind === 'event') return eventDrawer();
  const isNew = d.mode === 'new';
  const c = isNew ? { name: '', uid: d.uid || '', balance: 0, status: 'active', photoUrl: '', hasPhoto: false } : d.card;
  const hist = isNew ? [] : (state.data.tx || []).filter(t => t.card.id === c.id).slice(0, 4);
  return `<div class="drawer-scrim" data-act="closedrawer"><div class="drawer" data-stop>
    <h2>${isNew ? 'Add card' : esc(c.name)}</h2>
    <label class="drop" style="cursor:pointer"><span id="dprev">${isNew ? '<span class="av" style="width:64px;height:64px;display:grid;place-items:center;color:#7C8B96;font-weight:800;font-size:24px">?</span>' : avatar(c)}</span>
      <span><b>Photo</b>Click to choose a JPEG, PNG or WebP up to 2 MB. The terminal shows it after each tap.</span>
      <input id="d-photo" type="file" accept="image/jpeg,image/png,image/webp" class="hidden"></label>
    <label class="field">Holder name<input id="d-name" value="${esc(c.name)}" placeholder="Full name"></label>
    <label class="field">Card UID<span class="withbtn"><input id="d-uid" class="mono" value="${esc(d.uid ?? c.uid)}" placeholder="04:A2:3B:1C">${nfcButton('d-uid')}</span></label>
    <p class="nfcnote" id="d-nfc" hidden></p>
    <p style="font-size:12px;color:var(--ink-3);margin-top:-6px">On a terminal, tap the card and choose “Suggest for addition”. It then appears under Suggested cards, with its UID ready to copy.</p>
    ${isNew ? '<label class="field">Starting points<input id="d-pts" type="number" min="0" value="0"></label>'
      : `<div class="dsep"></div><div class="inline" style="align-items:center"><div style="flex:1"><b class="num" style="font-size:26px">${c.balance}</b> points</div>${statusPill(c.status)}</div>
         <button class="btn line" data-act="report" data-id="${c.id}" type="button" style="justify-content:center">Full report: every visit, point and a timeline</button>
         <div class="inline"><input class="search" id="d-adj" type="number" placeholder="Grant or take away, e.g. -5" style="min-width:0;flex:1" aria-label="Grant or take away points"><button class="btn line" data-act="adjust" type="button">Apply</button></div>
         <input class="search" id="d-reason" placeholder="Reason (optional, shown in Transactions)" maxlength="200" style="min-width:0;width:100%" aria-label="Reason">
         <div class="mini"><b style="color:var(--ink)">Recent</b>${hist.length ? hist.map(t => `<div><span>${esc(when(t.createdAt))} · ${t.type === 'adjust' ? (t.amount > 0 ? 'Admin grant' : 'Admin deduction') : 'T-' + t.id}</span><span class="${t.amount < 0 ? 'neg' : ''}">${signed(t.amount)}</span></div>`).join('') : '<div><span>No transactions yet</span></div>'}</div>`}
    <p class="err" id="d-err" role="alert"></p>
    <div style="margin-top:auto" class="inline"><button class="btn line" style="flex:1;justify-content:center" data-act="closedrawer" type="button">Cancel</button>
      <button class="btn green" style="flex:1;justify-content:center" data-act="savecard" type="button">${isNew ? 'Add card' : 'Save'}</button></div>
  </div></div>`;
}

function modalView() {
  const m = state.modal;
  if (m.kind === 'code') return `<div class="modal-scrim" data-act="closemodal"><div class="modal" data-stop>
    <h2>Pair ${esc(m.name)}</h2>
    <p style="color:var(--ink-2)">On the phone, open the app, choose “Pair this phone” and enter this code. It works once and expires in 10 minutes.</p>
    <div class="code">${esc(m.code.slice(0, 3) + ' ' + m.code.slice(3))}</div>
    <button class="btn green" style="justify-content:center" data-act="closemodal">Done</button></div></div>`;
  if (m.kind === 'newterm') return `<div class="modal-scrim" data-act="closemodal"><form class="modal" id="termform" data-stop>
    <h2>Pair a phone</h2>
    <label class="field" style="text-align:left">Terminal name<input name="name" required placeholder="Bar 2"></label>
    <label class="field" style="text-align:left">Place<input name="place" placeholder="Main hall"></label>
    <div class="inline"><button class="btn line" style="flex:1;justify-content:center" type="button" data-act="closemodal">Cancel</button><button class="btn green" style="flex:1;justify-content:center">Create and get code</button></div></form></div>`;
  if (m.kind === 'confirm') return `<div class="modal-scrim" data-act="closemodal"><div class="modal" data-stop>
    <h2>${esc(m.title)}</h2><p style="color:var(--ink-2)">${esc(m.text)}</p>
    <div class="inline"><button class="btn line" style="flex:1;justify-content:center" data-act="closemodal">Keep</button><button class="btn ${m.danger ? 'red' : 'green'}" style="flex:1;justify-content:center" data-act="confirmgo">${esc(m.button)}</button></div></div></div>`;
  if (m.kind === 'closeall') {
    const z = state.zones.find(x => x.id === m.zoneId);
    const here = ((state.data.sessions || {}).inside || []).filter(x => z && x.zone === z.name);
    const pay = here.filter(x => !x.overdue).reduce((n, x) => n + x.wouldEarn, 0), late = here.filter(x => x.overdue).length;
    return `<div class="modal-scrim" data-act="closemodal"><div class="modal" data-stop>
    <h2>${m.award ? 'Sign out' : 'Discard'} everyone in ${esc(z ? z.name : 'this zone')}?</h2>
    <p style="color:var(--ink-2)">${plural(here.length, 'person', 'people')} ${here.length === 1 ? 'is' : 'are'} inside. ${m.award
      ? `Each is signed out and paid by the zone’s rules: about ${pay} points in all${late ? `. ${plural(late, 'visit')} lasted longer than the longest stay and earn${late === 1 ? 's' : ''} nothing` : ''}.`
      : 'Their visits are cancelled and nobody gets any points. This cannot be undone.'}</p>
    <div class="inline"><button class="btn line" style="flex:1;justify-content:center" data-act="closemodal">Keep</button><button class="btn ${m.award ? 'green' : 'red'}" style="flex:1;justify-content:center" data-act="doclosall" data-id="${esc(m.zoneId)}" data-award="${m.award ? 1 : 0}">${m.award ? 'Sign out' : 'Discard'} ${plural(here.length, 'person', 'people')}</button></div></div></div>`;
  }
  if (m.kind === 'import') return importModal();
  if (m.kind === 'jsonexport') return jsonExportModal(m);
  if (m.kind === 'jsonimport') return jsonImportModal(m);
  if (m.kind === 'batch') {
    const mins = [[10, '10 minutes'], [60, '1 hour'], [480, '8 hours'], [1440, '24 hours'], [4320, '3 days'], [10080, '7 days']];
    return `<div class="modal-scrim"><form class="modal wide" id="batchform" data-stop>
    <h2>Pair many phones</h2>
    <p class="note">One phone per line: the <b>place</b> first, then the <b>terminal name</b>. The first word is the place. For a place of several words, put a <code>|</code> between the two, like <code>Main hall | Bar 2</code> (two spreadsheet columns pasted in work too).</p>
    <label class="field" style="text-align:left">Phones<textarea name="text" id="b-text" required spellcheck="false" placeholder="Floorball Terminal 1&#10;Floorball Terminal 2&#10;Checkin Anna's Terminal"></textarea></label>
    <div class="grid2" style="text-align:left">
      <label class="field">Mode<select name="mode" id="b-mode"><option value="atm">ATM (gives points)</option><option value="presence">Check-in / check-out</option><option value="info">Info kiosk (shows points)</option></select></label>
      <label class="field">Pairing codes work for<select name="minutes">${mins.map(([v, l]) => `<option value="${v}"${v === 60 ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div class="grid2" id="b-checkin" hidden style="text-align:left">
      <label class="field">Zone<select name="zoneId">${state.zones.map(z => `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join('')}</select></label>
      <label class="field">Point type<select name="direction"><option value="toggle">Toggle (in / out)</option><option value="in">Sign in only</option><option value="out">Sign out only</option></select></label>
    </div>
    <p class="err" id="b-err" role="alert"></p>
    <div class="inline"><button class="btn line" style="flex:1;justify-content:center" type="button" data-act="closemodal">Cancel</button><button class="btn green" style="flex:1;justify-content:center">Create and get codes</button></div></form></div>`;
  }
  if (m.kind === 'batchcodes') return `<div class="modal-scrim"><div class="modal wide" data-stop>
    <h2>${m.rows.length} phone${m.rows.length === 1 ? '' : 's'} ready to pair</h2>
    <p class="note">On each phone: open the app, choose “Pair this phone” and enter its code. Each code works once and stops working at <b>${esc(when(m.expiresAt))}</b>. The codes are shown only now, so download or copy them before you close this. Anyone who has a code can pair a phone as that terminal, so share the table privately.</p>
    <div class="tw"><table><thead><tr><th>Place</th><th>Terminal</th><th>Mode</th><th>Pairing code</th></tr></thead><tbody>
      ${m.rows.map(r => `<tr><td>${esc(r.place)}</td><td>${esc(r.name)}</td><td>${esc(m.modeLabel)}</td><td class="batchcode">${esc(r.pairingCode)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="inline"><button class="btn line" style="flex:1;justify-content:center" data-act="batchcopy">Copy table</button><button class="btn green" style="flex:1;justify-content:center" data-act="batchxlsx">Download Excel</button><button class="btn" style="flex:1;justify-content:center" data-act="closemodal">Done</button></div></div></div>`;
  if (m.kind === 'newzone') return `<div class="modal-scrim" data-act="closemodal"><form class="modal" id="zoneform" data-stop>
    <h2>Add a zone</h2><p style="color:var(--ink-2)">It starts with a copy of the rules of ${esc(m.from)}. Change them after.</p>
    <label class="field" style="text-align:left">Zone name<input name="name" required maxlength="60" placeholder="Workshop"></label>
    <p class="err" id="z-err" role="alert"></p>
    <div class="inline"><button class="btn line" style="flex:1;justify-content:center" type="button" data-act="closemodal">Cancel</button><button class="btn green" style="flex:1;justify-content:center">Add zone</button></div></form></div>`;
  if (m.kind === 'delzone') return `<div class="modal-scrim" data-act="closemodal"><div class="modal" data-stop>
    <h2>Delete ${esc(m.name)}?</h2><p style="color:var(--ink-2)">A zone that terminals use, or that has visit history, can’t be deleted.</p>
    <div class="inline"><button class="btn line" style="flex:1;justify-content:center" data-act="closemodal">Keep</button><button class="btn red" style="flex:1;justify-content:center" data-act="dodelzone" data-id="${m.id}">Delete</button></div></div></div>`;
  if (m.kind === 'newcode2') return `<div class="modal-scrim" data-act="closemodal"><div class="modal" data-stop>
    <h2>New display code for ${esc(m.name)}?</h2><p style="color:var(--ink-2)">The current code stops working at once and every screen signed in with it is signed out. You then type the new code on each screen.</p>
    <div class="inline"><button class="btn line" style="flex:1;justify-content:center" data-act="closemodal">Keep</button><button class="btn green" style="flex:1;justify-content:center" data-act="donewcode" data-id="${esc(m.id)}">Make a new code</button></div></div></div>`;
  if (m.kind === 'revokedev') return `<div class="modal-scrim" data-act="closemodal"><div class="modal" data-stop>
    <h2>Revoke ${esc(m.name)}?</h2><p style="color:var(--ink-2)">The reader is cut off at once. To use it again, forget it here and let it register again.</p>
    <div class="inline"><button class="btn line" style="flex:1;justify-content:center" data-act="closemodal">Keep</button><button class="btn red" style="flex:1;justify-content:center" data-act="dorevokedev" data-id="${esc(m.id)}">Revoke</button></div></div></div>`;
  if (m.kind === 'revoke') return `<div class="modal-scrim" data-act="closemodal"><div class="modal" data-stop>
    <h2>Revoke ${esc(m.name)}?</h2><p style="color:var(--ink-2)">The phone is signed out and can’t sign in again until it is paired with a new code.</p>
    <div class="inline"><button class="btn line" style="flex:1;justify-content:center" data-act="closemodal">Keep</button><button class="btn red" style="flex:1;justify-content:center" data-act="dorevoke" data-id="${m.id}">Revoke</button></div></div></div>`;
  if (m.kind === 'newstaff') return `<div class="modal-scrim" data-act="closemodal"><form class="modal" id="staffform" data-stop>
    <h2>Add admin</h2>
    <label class="field" style="text-align:left">Name<input name="name" required></label>
    <label class="field" style="text-align:left">Email<input name="email" type="email" required></label>
    <p class="err" id="s-err" role="alert"></p>
    <div class="inline"><button class="btn line" style="flex:1;justify-content:center" type="button" data-act="closemodal">Cancel</button><button class="btn green" style="flex:1;justify-content:center">Add</button></div></form></div>`;
  if (m.kind === 'staffkey') return `<div class="modal-scrim" data-act="closemodal"><form class="modal" id="keyform" data-stop>
    <h2>${m.hasKey ? 'Change' : 'Set'} sign-in key</h2>
    <p style="color:var(--ink-2);text-align:left">${esc(m.name)} can sign in on the Pont Admin app by holding this card or tag to the phone, with no password.</p>
    <label class="field" style="text-align:left">Key UID<span class="withbtn"><input id="k-uid" class="mono" placeholder="04:A2:3B:1C" autocomplete="off" required>${nfcButton('k-uid')}</span></label>
    <p class="warnline" style="text-align:left">A card’s number can be copied by anyone who gets to read it. Keep this key with you. Use a card that is only a key, not one that holds points.</p>
    <p class="note" style="text-align:left">${m.hasKey ? 'Changing or removing the key signs out everyone who signed in with it' + (m.self ? ' (that includes you).' : '.') : ''}</p>
    <p class="err" id="k-err" role="alert"></p>
    <div class="inline"><button class="btn line" style="flex:1;justify-content:center" type="button" data-act="closemodal">Cancel</button>${m.hasKey ? `<button class="btn red" style="flex:1;justify-content:center" type="button" data-act="removekey" data-id="${m.id}">Remove</button>` : ''}<button class="btn green" style="flex:1;justify-content:center">Save</button></div></form></div>`;
  if (m.kind === 'secret') return `<div class="modal-scrim" data-act="closemodal"><div class="modal" data-stop>
    <h2>${esc(m.title)}</h2><p style="color:var(--ink-2)">Give ${esc(m.who)} this temporary password. It is shown only once.</p>
    <div class="secret">${esc(m.password)}</div><button class="btn green" style="justify-content:center" data-act="closemodal">Done</button></div></div>`;
  return '';
}

function render() {
  const focus = document.activeElement?.id, pos = document.activeElement?.selectionStart;
  if (!token) { root.innerHTML = loginView(); return; }
  const pane = { report: reportPane, cards: cardsPane, terminals: terminalsPane, readers: readersPane, presence: presencePane, program: programPane, txns: txnsPane, staff: staffPane }[state.page]();
  root.innerHTML = shell(pane);
  if (focus === 'q') { const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos); }
  loadPhotos();
  if (state.page === 'presence') refreshPreview();
  if (state.page === 'report') positionTimeline();
  const here = $('.side [aria-current=true]'); if (here && here.scrollIntoView) here.scrollIntoView({ inline: 'center', block: 'nearest' });   // the menu is a row to scroll on a phone
}

/* ---------- group pairing export ---------- */
const localStamp = iso => { const d = new Date(iso), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const batchTable = m => [['Place', 'Terminal', 'Mode', 'Pairing code', 'Valid until'], ...m.rows.map(r => [r.place, r.name, m.modeLabel, r.pairingCode, localStamp(m.expiresAt)])];
function downloadFile(name, bytes, type) {
  if (window.PontNative && PontNative.saveFile) {   // inside the Pont Admin app a blob link does nothing: the app saves the file into Downloads
    let bin = ''; const u8 = new Uint8Array(bytes); for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    toast(PontNative.saveFile(name, type, btoa(bin)) ? 'Saved to Downloads: ' + name : 'Could not save the file.');
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** Pasted into a spreadsheet, a cell starting with = + - @ would run as a formula; a leading ' keeps it text. */
const tsvCell = v => (/^[=+\-@]/.test(v) ? "'" + v : v).replace(/[\t\r\n]+/g, ' ');

/* ---------- one card's report ---------- */
const ZOOMS = [24, 36, 50, 70, 100, 140, 200];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtMinutes = m => { m = Math.round(m || 0); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
const dt = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const sgn = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
const EVENT_LABEL = { checkin: 'Checked in', checkout: 'Checked out', discard: 'Visit cancelled', expired: 'Not signed out', grant: 'Points given', refund: 'Refund', adjust: 'Adjustment' };
const EVENT_PILL = { checkin: 'mute', checkout: 'ok', discard: 'bad', expired: 'bad', grant: 'ok', refund: 'amber', adjust: 'amber' };

function reportRows(r) {
  const visits = new Map(r.visits.map(v => [v.id, v]));
  return r.events.map(e => {
    const v = e.visitId != null ? visits.get(e.visitId) : null;
    let action = '';
    if (e.type === 'grant' && !e.stornoed && e.txId) action = `<button class="btn line sm" data-act="storno" data-id="${e.txId}">Storno</button>`;
    else if (e.type === 'checkout' && !e.stornoed && v && v.status === 'closed') action = `<button class="btn line sm" data-act="undovisit" data-id="${v.id}">Cancel check-out</button>`;
    else if (e.type === 'checkin' && v && v.status === 'open') action = `<button class="btn line sm" data-act="discardvisit" data-id="${v.id}">Cancel check-in</button>`;
    return `<tr class="${e.stornoed ? 'struck' : ''}"><td class="nowrap">${esc(dt(e.at))}</td>
      <td><span class="pill ${EVENT_PILL[e.type] || 'mute'}">${esc(EVENT_LABEL[e.type] || e.type)}${e.stornoed ? ' (reversed)' : ''}</span></td>
      <td>${esc(e.place || '—')}${e.zone ? `<div class="subnote">${esc(e.zone)}</div>` : ''}</td>
      <td class="num">${e.minutes != null ? esc(fmtMinutes(e.minutes)) : ''}</td>
      <td class="num ${e.points < 0 ? 'neg' : ''}">${e.points ? sgn(e.points) : ''}</td>
      <td>${esc(e.by || '')}${e.note ? `<div class="subnote">${esc(e.note)}</div>` : ''}</td><td>${action}</td></tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">Nothing has happened with this card yet.</td></tr>';
}

function reportPane() {
  const r = state.data.report;
  if (!r) return '<p class="empty">Loading the report…</p>';
  const c = r.card, s = r.summary;
  const tl = PontTimeline.render(r, { pxPerHour: state.tl.zoom, lastDays: state.tl.days });
  const tile = (value, label, sub = '') => `<div class="rtile"><b>${value}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const zones = r.byZone.length ? r.byZone.map(z => `<tr><td>${esc(z.zone)}</td><td class="num">${z.visits}</td><td class="num">${z.paid}</td><td class="num">${esc(fmtMinutes(z.minutes))}</td><td class="num">${z.points ? '+' + z.points : '0'}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">No visits yet.</td></tr>';
  const zoomIdx = ZOOMS.indexOf(state.tl.zoom);
  return `<div class="ph"><button class="btn line sm" data-act="backtocards">← Cards</button><span class="sp"></span>
      <button class="btn line" data-act="edit" data-id="${esc(c.id)}">Edit card</button><button class="btn green" data-act="reportxlsx">Download Excel</button></div>
    <div class="rhead2">${avatar({ id: c.id, name: c.name, photoUrl: c.photoUrl, hasPhoto: true }, 'big')}
      <div><h1>${esc(c.name)}</h1><p class="mono">${esc(c.uid)} ${statusPill(c.status)}</p></div></div>
    <div class="rstats">
      ${tile(s.balance, 'Points now')}
      ${tile(esc(fmtMinutes(s.minutesPaid)), 'Time inside, paid', s.minutesNotCounted ? `${esc(fmtMinutes(s.minutesNotCounted))} more was cancelled or not counted` : '')}
      ${tile(`${s.visitsPaid}`, 'Paid visits', `${s.visitsCancelled} cancelled · ${s.visitsExpired} not signed out${s.visitsOpen ? ` · ${s.visitsOpen} inside now` : ''}`)}
      ${tile(sgn(s.pointsFromVisits), 'From check-outs')}
      ${tile(sgn(s.pointsFromGrants), 'Given at terminals and readers')}
      ${tile(sgn(s.pointsRefunded), 'Refunded')}
      ${tile(sgn(s.pointsAdjusted), 'Adjusted by admins')}
      ${tile(s.opening, 'Started with', 'before the log began')}
    </div>
    ${r.truncated ? '<p class="warnline">This card has so much history that only the newest part is shown here.</p>' : ''}
    <div class="secthead"><h2 class="sect">Timeline</h2><span class="sp"></span>
      <label class="field inlinefield"><span>Show</span><select id="tl-days"><option value=""${state.tl.days ? '' : ' selected'}>All days with activity</option>${[3, 7, 14, 30].map(n => `<option value="${n}"${state.tl.days === n ? ' selected' : ''}>Last ${n} days with activity</option>`).join('')}</select></label>
      <button class="btn line sm" data-act="tlzoom" data-dir="-1" aria-label="Zoom out"${zoomIdx === 0 ? ' disabled' : ''}>−</button><button class="btn line sm" data-act="tlzoom" data-dir="1" aria-label="Zoom in"${zoomIdx === ZOOMS.length - 1 ? ' disabled' : ''}>+</button></div>
    <div class="tlbox">${tl.html}</div>
    <div class="tl-legend"><span><i class="sw closed"></i>Paid visit</span><span><i class="sw discarded"></i>Cancelled</span><span><i class="sw expired"></i>Not signed out</span><span><i class="sw open"></i>Inside now</span><span><i class="sw pos"></i>Points given</span><span><i class="sw neg"></i>Refund</span><span><i class="sw adjust"></i>Adjustment</span>${tl.hiddenDays ? `<span class="muted">${tl.hiddenDays} earlier ${tl.hiddenDays === 1 ? 'day is' : 'days are'} hidden</span>` : ''}</div>
    <h2 class="sect">By zone</h2>
    <div class="tw"><table><thead><tr><th>Zone</th><th>Visits</th><th>Paid</th><th>Time inside, paid</th><th>Points</th></tr></thead><tbody>${zones}</tbody></table></div>
    <h2 class="sect">Everything that happened</h2>
    <div class="tw"><table><thead><tr><th>When</th><th>What</th><th>Where</th><th>Time</th><th>Points</th><th>By</th><th></th></tr></thead><tbody>${reportRows(r)}</tbody></table></div>`;
}

/** Keeps the timeline where the person left it, or at its newest end, which is what they came to see. */
function positionTimeline() {
  const el = document.querySelector('.tl-scroll');
  if (!el) return;
  el.scrollLeft = state.tl.scroll == null || state.tl.atEnd ? el.scrollWidth : state.tl.scroll;
}
root.addEventListener('scroll', e => {
  const el = e.target;
  if (el && el.classList && el.classList.contains('tl-scroll')) { state.tl.scroll = el.scrollLeft; state.tl.atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 8; }
}, true);

/** The name and points of a visit, from whichever page the person is looking at. */
function visitInfo(id) {
  const recent = ((state.data.sessions || {}).recent || []).find(x => x.id === Number(id));
  if (recent) return { name: recent.card.name, points: recent.points };
  const r = state.data.report, v = r && r.visits.find(x => x.id === Number(id));
  return v ? { name: r.card.name, points: v.points } : { name: 'This card', points: 0 };
}

/** Who is signed in, read from the token (it is not secret: it is the part the server signed). */
const myId = () => { try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).id; } catch { return null; } };

/** After a sign-in, with a password or a key: keeps the token and opens the Cards page. */
async function finishLogin(r) {
  if (r.user.role !== 'admin') { state.loginError = 'This account is for the terminal app. Sign in with an admin account.'; return render(); }
  token = r.token; try { tokenStore().setItem('pont-token', token); } catch {}
  state.loginError = ''; state.page = 'cards'; await refresh(); connectLive();
}

/* ---------- events ---------- */
const tempPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

root.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'login') {
    const fd = new FormData(f);
    try {
      await finishLogin(await api('POST', '/auth/login', { email: fd.get('email'), password: fd.get('password'), remember: !!window.PontNative }));
    } catch (err) { state.loginError = err.message; render(); }
  } else if (f.id === 'rules') {
    const err = document.getElementById('r-err'); err.textContent = '';
    try { await api('PUT', '/zones/' + state.zoneId, { name: document.getElementById('r-name').value, settings: draftRules() }); await refresh(); toast('Zone saved.'); }
    catch (ex) { err.textContent = ex.message; }
  } else if (f.dataset.approve) {
    const fd = new FormData(f);
    await guard(async () => { await api('POST', `/devices/${encodeURIComponent(f.dataset.approve)}/approve`, { name: fd.get('name'), mode: fd.get('mode') }); await refresh(); toast('Reader approved.'); });
  } else if (f.dataset.reader) {
    const fd = new FormData(f), num = k => { const v = String(fd.get(k) ?? '').trim(); return v === '' ? null : Number(v); };
    const err = f.querySelector('.err'); err.textContent = '';
    try {
      await api('PATCH', '/terminals/' + f.dataset.reader, { fixed: { amount: num('amount'), cooldownSeconds: num('cooldownSeconds'), maxUses24h: num('maxUses24h'), maxPoints24h: num('maxPoints24h'), maxUsesTotal: num('maxUsesTotal') } });
      await refresh(); toast('Rules saved.');
    } catch (ex) { err.textContent = ex.message; }
  } else if (f.id === 'zoneform') {
    const fd = new FormData(f), from = state.zones.find(z => z.id === state.zoneId);
    try { const z = await api('POST', '/zones', { name: fd.get('name'), settings: from?.settings }); state.zoneId = z.id; state.modal = null; await refresh(); toast('Zone added.'); }
    catch (ex) { document.getElementById('z-err').textContent = ex.message; }
  } else if (f.id === 'termform') {
    await guard(async () => {
      const fd = new FormData(f);
      const r = await api('POST', '/terminals', { name: fd.get('name'), place: fd.get('place') });
      state.modal = { kind: 'code', name: r.terminal.name, code: r.pairingCode }; await refresh();
    });
  } else if (f.id === 'batchform') {
    const fd = new FormData(f), err = document.getElementById('b-err'); err.textContent = '';
    const mode = fd.get('mode');
    const body = { text: fd.get('text'), mode, expiresInMinutes: Number(fd.get('minutes')) };
    if (mode === 'presence') { body.zoneId = fd.get('zoneId'); body.direction = fd.get('direction'); }
    try {
      const r = await api('POST', '/terminals/batch', body);
      const zone = state.zones.find(z => z.id === body.zoneId)?.name;
      const dir = { toggle: 'sign in or out', in: 'sign in only', out: 'sign out only' }[body.direction];
      state.modal = { kind: 'batchcodes', rows: r.terminals, expiresAt: r.expiresAt, modeLabel: mode === 'atm' ? 'ATM' : mode === 'info' ? 'Info kiosk' : `Check-in (${dir}${zone ? ', ' + zone : ''})` };
      await refresh();
    } catch (ex) { err.textContent = ex.message; }
  } else if (f.id === 'keyform') {
    const err = document.getElementById('k-err'); err.textContent = '';
    try {
      const m = state.modal;
      await api('PUT', `/staff/${m.id}/key`, { uid: document.getElementById('k-uid').value });
      state.modal = null; await refresh(); toast('Key saved.');
    } catch (ex) { err.textContent = ex.message; }
  } else if (f.id === 'progsettings') {
    readSettingsForm();
    const err = document.getElementById('p-err'); err.textContent = '';
    try { await saveProgram(doc => PontProgram.applySettings(doc, state.progDraft)); state.progDraft = null; render(); toast('Settings saved.'); }
    catch (ex) { err.textContent = ex.message; }   // what was typed stays
  } else if (f.id === 'evform') {
    readEventForm();
    const d = state.drawer, err = document.getElementById('ev-err'); err.textContent = ''; d.error = '';
    try { await saveProgram(doc => PontProgram.applyEvent(doc, d.form, d.id)); state.drawer = null; render(); toast(d.id ? 'Event saved.' : 'Event added.'); }
    catch (ex) { d.error = ex.message; err.textContent = ex.message; }
  } else if (f.id === 'jsonimportform') {
    const im = state.jsonImport, err = document.getElementById('json-err'); im.text = document.getElementById('json-in').value; im.error = ''; err.textContent = '';
    try {
      if (im.what === 'program') {
        const r = PontProgram.parseImport(im.text);
        if (r.error) throw new Error(r.error);
        const saved = await api('PUT', '/program', r.doc);
        state.data.program = saved; state.progDraft = null; state.modal = null; state.jsonImport = null; render(); toast(`Program imported: ${plural(saved.events.length, 'event')}.`);
      } else {
        const r = PontProgram.parseZonesImport(im.text);
        if (r.error) throw new Error(r.error);
        const res = await api('POST', '/zones/import', r.body);
        state.modal = null; state.jsonImport = null; await refresh(); toast(`${res.created} added, ${res.updated} updated.`);
      }
    } catch (ex) { im.error = ex.message; err.textContent = ex.message; }   // the pasted text stays
  } else if (f.id === 'staffform') {
    const fd = new FormData(f), password = tempPassword();
    try {
      await api('POST', '/staff', { name: fd.get('name'), email: fd.get('email'), role: 'admin', password });
      state.modal = { kind: 'secret', title: 'Admin added', who: fd.get('name'), password }; await refresh();
    } catch (err) { $('#s-err').textContent = err.message; }
  }
});

root.addEventListener('input', e => {
  if (e.target.id === 'q') { state.q = e.target.value; refresh(); }
  if (e.target.id === 'imp-text' && state.import) { state.import.text = e.target.value; scheduleImportCheck(); }
  if (e.target.closest && e.target.closest('#rules')) refreshPreview();
  if (e.target.id === 'json-in' && state.jsonImport) state.jsonImport.text = e.target.value;
  if (e.target.closest && e.target.closest('#evform')) readEventForm();
  if (e.target.closest && e.target.closest('#progsettings')) { readSettingsForm(); if (e.target.dataset.k === 'key' || e.target.dataset.k === 'label') refreshGoalDays(); }
});
root.addEventListener('change', async e => {
  if (e.target.closest && e.target.closest('#rules')) refreshPreview();
  if (e.target.dataset && (e.target.dataset.zoneFor || e.target.dataset.dirFor)) {
    const id = e.target.dataset.zoneFor || e.target.dataset.dirFor;
    await guard(async () => { await api('PATCH', '/terminals/' + id, e.target.dataset.zoneFor ? { zoneId: e.target.value } : { direction: e.target.value }); await refresh(); toast('Saved.'); });
  }
  if (e.target.dataset && e.target.dataset.limitFor) {
    const raw = e.target.value.trim(), limit = raw === '' ? null : Number(raw);
    await guard(async () => { await api('PATCH', '/terminals/' + e.target.dataset.limitFor, { chargeLimitHour: limit }); await refresh(); toast(limit === null ? 'No hourly limit.' : 'Hourly limit saved.'); });
  }
  if (e.target.dataset && e.target.dataset.beepFor) {
    await guard(async () => { await api('PATCH', '/terminals/' + e.target.dataset.beepFor, { displayBeep: e.target.checked }); await refresh(); toast(e.target.checked ? 'The display will beep.' : 'The display is silent.'); });
  }
  if (e.target.dataset && e.target.dataset.rmodeFor) {
    await guard(async () => { await api('PATCH', '/terminals/' + e.target.dataset.rmodeFor, { mode: e.target.value }); await refresh(); toast('Mode changed. The reader follows within 30 seconds.'); });
  }
  if (e.target.dataset && e.target.dataset.modeFor) {
    await guard(async () => { const t = await api('PATCH', '/terminals/' + e.target.dataset.modeFor, { mode: e.target.value }); await refresh(); toast(t.name + ' is now in ' + (t.mode === 'presence' ? 'Check-in' : t.mode === 'info' ? 'Info kiosk' : 'ATM') + ' mode.'); });
  }
  if ((e.target.id === 'imp-files' || e.target.id === 'imp-folder') && state.import) { addImportFiles([...e.target.files]); e.target.value = ''; }
  if (e.target.id === 'tl-days') { state.tl.days = e.target.value ? Number(e.target.value) : null; state.tl.scroll = null; state.tl.atEnd = true; render(); }
  if (e.target.dataset && e.target.dataset.cancelFor) {
    await guard(async () => { await api('PATCH', '/terminals/' + e.target.dataset.cancelFor, { displayCancel: e.target.checked }); await refresh(); toast(e.target.checked ? 'The display page can now cancel the last tap.' : 'The display page can no longer cancel.'); });
  }
  if (e.target.id === 'b-mode') document.getElementById('b-checkin').hidden = e.target.value !== 'presence';
  if (e.target.id === 'ev-model') { readEventForm(); redrawDrawer(); }
  if (e.target.closest && e.target.closest('#progsettings')) readSettingsForm();
  if (e.target.id === 'd-photo') {
    const file = e.target.files[0];
    if (file) { $('#dprev').innerHTML = `<img class="av" style="width:64px;height:64px;object-fit:cover" alt="Chosen photo" src="${URL.createObjectURL(file)}">`; }
  }
});

root.addEventListener('click', async e => {
  const nav = e.target.closest('[data-go]');
  if (nav) { state.page = nav.dataset.go; state.q = ''; state.data = {}; state.progDraft = null; render(); return refresh(); }
  const el = e.target.closest('[data-act]'); if (!el) return;
  if ((el.classList.contains('drawer-scrim') || el.classList.contains('modal-scrim')) && e.target.closest('[data-stop]')) return;
  if (el.tagName === 'A') e.preventDefault();
  const act = el.dataset.act, id = el.dataset.id;
  const card = id && (state.data.all || state.data.cards || []).find(c => c.id === id);
  switch (act) {
    case 'signout': signOut(); break;
    case 'report': state.page = 'report'; state.reportId = id; state.drawer = null; state.modal = null; state.data = {}; state.tl.scroll = null; state.tl.atEnd = true; render(); await refresh(); break;
    case 'backtocards': state.page = 'cards'; state.reportId = null; state.data = {}; render(); await refresh(); break;
    case 'tlzoom': { const at = ZOOMS.indexOf(state.tl.zoom); state.tl.zoom = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (at < 0 ? 3 : at) + Number(el.dataset.dir)))]; state.tl.scroll = null; state.tl.atEnd = true; render(); break; }
    case 'reportxlsx': {
      const r = state.data.report;
      const rows = [['When', 'What', 'Where', 'Zone', 'Minutes', 'Points', 'By', 'Note'], ...r.events.map(x => [localStamp(x.at), (EVENT_LABEL[x.type] || x.type) + (x.stornoed ? ' (reversed)' : ''), x.place || '', x.zone || '', x.minutes ?? '', x.points || '', x.by || '', x.note || ''].map(String))];
      downloadFile(`pont-report-${r.card.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'card'}-${localStamp(new Date().toISOString()).slice(0, 10)}.xlsx`, PontXlsx.build('Report', rows, [18, 18, 22, 16, 9, 8, 20, 36]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      break; }
    case 'undovisit': { const info = visitInfo(id);
      state.modal = { kind: 'confirm', title: 'Cancel this check-out?', text: `${info.name} ${info.points ? `will lose ${info.points} points and ` : ''}will be inside again, as if they had not signed out.`, button: 'Cancel the check-out', danger: true,
        run: async () => { const r = await api('POST', `/presence/sessions/${id}/cancel`, { expect: 'out' }); await refresh(); toast(`Check-out cancelled${r.points ? ': ' + r.points + ' points taken back' : ''}.`); } };
      render(); break; }
    case 'discardvisit': { const info = visitInfo(id);
      state.modal = { kind: 'confirm', title: 'Cancel this check-in?', text: `The visit is discarded and ${info.name} is no longer inside. No points are paid.`, button: 'Cancel the check-in', danger: true,
        run: async () => { await api('POST', `/presence/sessions/${id}/cancel`, { expect: 'in' }); await refresh(); toast('Check-in cancelled.'); } };
      render(); break; }
    case 'confirmgo': { const run = state.modal && state.modal.run; state.modal = null; render(); if (run) await guard(run); break; }
    case 'closeall': state.modal = { kind: 'closeall', zoneId: id, award: el.dataset.award === '1' }; render(); break;
    case 'doclosall': state.modal = null; render(); await guard(async () => {
      const r = await api('POST', `/zones/${id}/close-all`, { award: el.dataset.award === '1' });
      await refresh();
      toast(el.dataset.award === '1' ? `Signed out ${plural(r.closed, 'person', 'people')}${r.points ? ' · +' + r.points + ' points' : ''}${r.overdue ? ` · ${plural(r.overdue, 'visit')} too long, no points` : ''}.` : `Discarded ${plural(r.closed, 'visit')}.`);
    }); break;
    case 'scan': await scanInto(el.dataset.target); break;
    case 'newcard': state.drawer = { mode: 'new' }; render(); break;
    case 'addsuggested': state.drawer = { mode: 'new', uid: el.dataset.uid }; render(); break;
    case 'copyuid': e.stopPropagation(); toast((await copyText(el.dataset.uid)) ? 'Copied ' + el.dataset.uid : 'Could not copy. Select the UID and copy it by hand.'); break;
    case 'dismiss': await guard(async () => { await api('DELETE', '/card-suggestions/' + encodeURIComponent(el.dataset.uid)); await refresh(); toast('Suggestion dismissed.'); }); break;
    case 'edit': state.drawer = { mode: 'edit', card }; render(); break;
    case 'closedrawer': state.drawer = null; render(); break;
    case 'newevent': openEventDrawer(null); break;
    case 'editevent': openEventDrawer(id); break;
    case 'delevent': state.modal = { kind: 'confirm', title: `Delete “${el.dataset.title}”?`, text: 'The event is removed from the program. This cannot be undone.', button: 'Delete event', danger: true,
      run: async () => { await saveProgram(doc => PontProgram.removeEvent(doc, id)); state.drawer = null; render(); toast('Event deleted.'); } }; render(); break;
    case 'clearevents': state.modal = { kind: 'confirm', title: 'Remove all events?', text: `All ${state.data.program.events.length} events are removed from the program. The title, the days and the goal stay. This cannot be undone; use Export JSON first to keep a copy.`, button: 'Remove all events', danger: true,
      run: async () => { await saveProgram(doc => PontProgram.clearEvents(doc)); render(); toast('All events removed.'); } }; render(); break;
    case 'additem': readEventForm(); state.drawer.form.items.push({ name: '', pts: '', min: '' }); redrawDrawer('#ev-items [data-item]:last-of-type [data-k=name]'); break;
    case 'rmitem': readEventForm(); state.drawer.form.items.splice(Number(el.dataset.i), 1); if (!state.drawer.form.items.length) state.drawer.form.items.push({ name: '', pts: '', min: '' }); redrawDrawer(); break;
    case 'addhome': readEventForm(); state.drawer.form.home.push({ name: '', pts: '' }); redrawDrawer('#ev-home [data-home]:last-of-type [data-k=name]'); break;
    case 'rmhome': readEventForm(); state.drawer.form.home.splice(Number(el.dataset.i), 1); redrawDrawer(); break;
    case 'addday': readSettingsForm(); state.progDraft.days.push({ key: '', label: '', date: '', isNew: true }); render(); { const rows = document.querySelectorAll('[data-dayrow] [data-k=key]'); if (rows.length) rows[rows.length - 1].focus(); } break;
    case 'rmday': { readSettingsForm(); const d = state.progDraft; d.days.splice(Number(el.dataset.i), 1); if (!d.days.some(x => x.key.trim().toLowerCase() === d.dayKey)) d.dayKey = (d.days[0] || {}).key || ''; render(); break; }
    case 'progexport': state.modal = { kind: 'jsonexport', what: 'program', text: PontProgram.toJson(state.data.program) }; render(); break;
    case 'zonesexport': state.modal = { kind: 'jsonexport', what: 'zones', text: PontProgram.zonesToJson(state.zones) }; render(); break;
    case 'progimport': case 'zonesimport': state.jsonImport = { what: act === 'progimport' ? 'program' : 'zones', text: '', error: '' }; state.modal = { kind: 'jsonimport', what: state.jsonImport.what }; render(); { const t = document.getElementById('json-in'); if (t) t.focus(); } break;
    case 'jsoncopy': toast((await copyText($('#json-out').value)) ? 'Copied.' : 'Could not copy. Select the text and copy it by hand.'); break;
    case 'jsondownload': downloadFile(JSON_WHAT[state.modal.what].file(), new TextEncoder().encode(state.modal.text), 'application/json'); break;
    case 'jsonexample': { const t = document.getElementById('json-in'); state.jsonImport.text = JSON_WHAT[state.jsonImport.what].example(); if (t) { t.value = state.jsonImport.text; t.focus(); } break; }
    case 'closemodal': state.modal = null; render(); break;
    case 'toggle': e.stopPropagation(); await guard(async () => { const c = await api('PATCH', '/cards/' + id, { status: card.status === 'blocked' ? 'active' : 'blocked' }); await refresh(); toast(c.name + (c.status === 'blocked' ? ' is now blocked.' : ' is active again.')); }); break;
    case 'adjust': await guard(async () => {
      const delta = parseInt($('#d-adj').value, 10);
      if (!delta) throw new Error('Enter a whole number, not 0.');
      const c = await api('POST', `/cards/${state.drawer.card.id}/adjust`, { delta, reason: $('#d-reason').value });
      await refresh(); state.drawer = { mode: 'edit', card: c }; render(); toast('Balance is now ' + c.balance + '.');
    }); break;
    case 'savecard': {
      const err = $('#d-err'); err.textContent = '';
      try {
        const body = { name: $('#d-name').value, uid: $('#d-uid').value };
        let saved;
        if (state.drawer.mode === 'new') saved = await api('POST', '/cards', { ...body, points: parseInt($('#d-pts').value, 10) || 0 });
        else saved = await api('PATCH', '/cards/' + state.drawer.card.id, body);
        const file = $('#d-photo').files[0];
        if (file) { const fd = new FormData(); fd.append('photo', await compressPhoto(file), 'photo.jpg'); await api('PUT', `/cards/${saved.id}/photo`, fd); photoCache.clear(); }
        state.drawer = null; await refresh(); toast('Saved.');
      } catch (ex) { err.textContent = ex.message; }
      break; }
    case 'refresh': state.progDraft = null; await refresh(); break;
    case 'copycode': toast((await copyText(el.dataset.code)) ? 'Code copied.' : 'Could not copy. Select the code and copy it by hand.'); break;
    case 'newcode2': state.modal = { kind: 'newcode2', id, name: el.dataset.name }; render(); break;
    case 'donewcode': state.modal = null; render(); await guard(async () => { await api('POST', `/terminals/${id}/display-code`); await refresh(); toast('New code made. Screens with the old one are signed out.'); }); break;
    case 'rejectdevice': await guard(async () => { await api('DELETE', '/devices/' + encodeURIComponent(id)); await refresh(); toast('Removed.'); }); break;
    case 'revokedevice': state.modal = { kind: 'revokedev', id, name: el.dataset.name }; render(); break;
    case 'dorevokedev': state.modal = null; render(); await guard(async () => { await api('DELETE', '/devices/' + encodeURIComponent(id)); await refresh(); toast('Reader revoked.'); }); break;
    case 'pickzone': state.zoneId = id; render(); break;
    case 'newzone': state.modal = { kind: 'newzone', from: state.zones.find(z => z.id === state.zoneId)?.name || 'this zone' }; render(); break;
    case 'delzone': state.modal = { kind: 'delzone', id, name: el.dataset.name }; render(); break;
    case 'dodelzone': state.modal = null; render(); await guard(async () => { await api('DELETE', '/zones/' + id); state.zoneId = null; await refresh(); toast('Zone deleted.'); }); break;
    case 'presenceclose': await guard(async () => {
      const r = await api('POST', `/presence/sessions/${id}/close`, { award: el.dataset.award === '1' });
      await refresh(); toast(el.dataset.award === '1' ? 'Signed out' + (r.points ? ' · +' + r.points + ' points.' : ' · no points earned.') : 'Visit discarded.');
    }); break;
    case 'newterm': state.modal = { kind: 'newterm' }; render(); break;
    case 'newbatch': state.modal = { kind: 'batch' }; render(); break;
    case 'importcards': openImport(); break;
    case 'importgo': doImport(); break;
    case 'importclearphotos': state.import.files = []; state.import.jobs.clear(); state.import.info.clear(); updateImport(); break;
    case 'importretry': retryImportPhotos(); break;
    case 'importdone': state.modal = null; state.import = null; render(); await refresh(); break;
    case 'batchxlsx': {
      const bytes = PontXlsx.build('Pairing codes', batchTable(state.modal), [14, 26, 36, 14, 18]);
      downloadFile(`pont-pairing-codes-${localStamp(new Date().toISOString()).slice(0, 10)}.xlsx`, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      break; }
    case 'batchcopy': toast((await copyText(batchTable(state.modal).map(r => r.map(tsvCell).join('\t')).join('\n'))) ? 'Table copied. Paste it into Excel or Sheets.' : 'Could not copy. Use Download Excel instead.'); break;
    case 'newcode': await guard(async () => { const t = state.data.terminals.find(x => x.id === id); const r = await api('POST', `/terminals/${id}/pairing-code`); state.modal = { kind: 'code', name: t.name, code: r.pairingCode }; render(); }); break;
    case 'revoke': state.modal = { kind: 'revoke', id, name: el.dataset.name }; render(); break;
    case 'dorevoke': await guard(async () => { await api('DELETE', '/terminals/' + id); state.modal = null; await refresh(); toast('Terminal revoked.'); }); break;
    case 'storno': await guard(async () => { await api('POST', `/transactions/${id}/storno`); await refresh(); toast('Stornoed T-' + id + '.'); }); break;
    case 'newstaff': state.modal = { kind: 'newstaff' }; render(); break;
    case 'staffactive': await guard(async () => { await api('PATCH', '/staff/' + id, { active: el.dataset.on !== '1' }); await refresh(); }); break;
    case 'keylogin': { const uid = await scanCard(); if (!uid) break; try { await finishLogin(await api('POST', '/auth/key-login', { uid, remember: true })); } catch (err) { buzz('bad'); state.loginError = err.message; render(); } break; }
    case 'staffkey': { const s = state.data.staff.find(x => x.id === id); state.modal = { kind: 'staffkey', id, name: s.name, hasKey: s.hasKey, self: s.id === myId() }; render(); break; }
    case 'removekey': await guard(async () => { await api('DELETE', `/staff/${id}/key`); state.modal = null; await refresh(); toast('Key removed.'); }); break;
    case 'resetpw': await guard(async () => {
      const s = state.data.staff.find(x => x.id === id), password = tempPassword();
      await api('PATCH', '/staff/' + id, { password });
      state.modal = { kind: 'secret', title: 'Password reset', who: s.name, password }; render();
    }); break;
  }
});

/* ---------- photos: made small before they are sent ---------- */
/* A photo from a phone is several megabytes; a reader shows it as a circle at most about 500 px wide. So each photo is cut to
   a centred square (a little above the middle for portraits, so heads stay in), made 400 px, and saved as a JPEG: about 30 KB.
   Doing it here also drops everything else in the file (such as where the photo was taken). */
const PHOTO_SIZE = 400, PHOTO_QUALITY = 0.8, PHOTO_MAX_BYTES = 40 * 1024 * 1024;
async function compressPhoto(file) {
  if (file.size > PHOTO_MAX_BYTES) throw new Error('This picture is too large (over 40 MB)');
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('This is not a picture this browser can read (use JPEG, PNG or WebP)'); }
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = bitmap.height > bitmap.width ? (bitmap.height - side) * 0.3 : (bitmap.height - side) / 2;
  const size = Math.min(PHOTO_SIZE, side);   // a small picture is not made bigger
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);   // a transparent PNG would turn black as a JPEG
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  if (bitmap.close) bitmap.close();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', PHOTO_QUALITY));
  if (!blob) throw new Error('Could not make this picture smaller');
  return blob;
}

/* ---------- import cards ---------- */
const kb = n => (n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const IMAGE_NAME = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i;
let importSeq = 0, importTimer = null, importPaint = null;

function openImport() {
  state.import = { text: '', files: [], parsed: null, check: null, checking: false, checkError: '', phase: 'edit', progress: '', pct: 0, result: null, jobs: new Map(), info: new Map(), chain: Promise.resolve() };
  state.modal = { kind: 'import' };
  render();
  const box = document.getElementById('imp-text'); if (box) box.focus();
}

function importModal() {
  const im = state.import;
  if (!im) return '';
  const form = im.phase !== 'edit' ? '' : `
    <p class="note"><b>1.</b> Paste the list, one card per line, with a first row naming the columns: <code>name, uid, points, photo</code>
      (<code>points</code> and <code>photo</code> are optional; the photo is the picture's file name, like <code>anna.jpg</code>). Commas, semicolons and tabs all work, so a copy from Excel or Sheets can be pasted as it is.</p>
    <label class="field" style="text-align:left"><span class="sr">The list of cards</span><textarea id="imp-text" spellcheck="false" placeholder="name,uid,points,photo&#10;Anna Kovács,04:A2:3B:1C,10,anna.jpg&#10;Béla Nagy,04BBCCDD,0,bela.jpg">${esc(im.text)}</textarea></label>
    <p class="note"><b>2.</b> Choose the pictures. They are matched by file name and made small (400 px) before they are sent, so readers load them quickly.</p>
    <div class="inline" style="justify-content:flex-start;align-items:center">
      <label class="btn line sm">Choose pictures<input id="imp-files" type="file" multiple accept="image/*" class="hidden"></label>
      <label class="btn line sm">Choose a folder<input id="imp-folder" type="file" webkitdirectory class="hidden"></label>
      <span class="note" id="imp-filesum"></span>
    </div>`;
  return `<div class="modal-scrim"><div class="modal wide import" data-stop><h2>Import cards</h2>${form}<div id="imp-dyn">${importDyn(im)}</div></div></div>`;
}

/** Redraws the checked list and the buttons only, so the pasted text and the cursor are never touched. */
function updateImport() {
  const im = state.import, dyn = document.getElementById('imp-dyn');
  if (!im || !dyn) return;
  dyn.innerHTML = importDyn(im);
  const sum = document.getElementById('imp-filesum');
  if (sum) sum.innerHTML = im.files.length ? `${plural(im.files.length, 'picture')} chosen · <button class="linklike" data-act="importclearphotos" type="button">clear</button>` : '';
}
const paintImportSoon = () => { clearTimeout(importPaint); importPaint = setTimeout(updateImport, 120); };

/** For each row of the list: which chosen picture it names, if any. */
function importMatches(im) {
  const names = im.files.map(f => f.name);
  return im.parsed && im.parsed.ok ? im.parsed.rows.map(r => PontCsv.matchPhoto(r.photo, names)) : [];
}

function importDyn(im) {
  if (im.phase === 'working') {
    return `<p class="note"><b>${esc(im.progress)}</b></p><div class="bar"><i style="width:${Math.max(4, im.pct)}%"></i></div><p class="note">Please keep this page open until it says it is done.</p>`;
  }
  if (im.phase === 'done') {
    const r = im.result;
    return `<p class="note"><b>${plural(r.created, 'card')} made</b>, ${plural(r.photosOk, 'photo')} added${r.noPhoto ? `, ${plural(r.noPhoto, 'card')} without a photo (they show the placeholder portrait)` : ''}.</p>
      ${r.failed.length ? `<p class="err">${plural(r.failed.length, 'photo')} could not be added:</p>
        <div class="imp-scroll"><table class="imp-table"><tbody>${r.failed.map(f => `<tr><td>${esc(f.holder)}</td><td>${esc(f.file)}</td><td class="bad">${esc(f.reason)}</td></tr>`).join('')}</tbody></table></div>
        <p class="note">The cards themselves exist. Try those photos again, or open the card and choose its photo.</p>` : ''}
      <div class="inline">${r.failed.length ? '<button class="btn line" style="flex:1;justify-content:center" data-act="importretry" type="button">Try the failed photos again</button>' : ''}<button class="btn green" style="flex:1;justify-content:center" data-act="importdone" type="button">Done</button></div>`;
  }
  const p = im.parsed;
  let body;
  if (!p) body = '<p class="note">The list is checked here as soon as you paste it.</p>';
  else if (!p.ok) body = `<p class="err">${esc(p.error)}</p>`;
  else if (im.checkError) body = `<p class="err">${esc(im.checkError)}</p>`;
  else if (im.checking || !im.check) body = '<p class="note">Checking…</p>';
  else body = importPreview(im);
  const ready = !!(p && p.ok && im.check && im.check.ok && !im.checking);
  const n = ready ? p.rows.length : 0;
  return `${body}<div class="inline"><button class="btn line" style="flex:1;justify-content:center" data-act="closemodal" type="button">Cancel</button>
    <button class="btn green" style="flex:1;justify-content:center" data-act="importgo" type="button"${ready ? '' : ' disabled'}>${ready ? `Import ${plural(n, 'card')}` : 'Import'}</button></div>`;
}

function importPreview(im) {
  const rows = im.parsed.rows, results = im.check.results, matches = importMatches(im);
  const bad = results.filter(r => !r.ok).length;
  const wanted = rows.filter(r => r.photo).length, found = matches.filter(m => m.index !== undefined).length;
  const used = new Set(matches.filter(m => m.index !== undefined).map(m => m.index));
  const unused = im.files.filter((_, i) => !used.has(i));
  const infos = [...used].map(i => im.info.get(im.files[i]));
  const allDone = infos.length && infos.every(Boolean) && infos.every(x => !x.error);
  const sizes = allDone ? ` Together ${kb(infos.reduce((s, x) => s + x.before, 0))} → ${kb(infos.reduce((s, x) => s + x.after, 0))} after making them small.` : '';
  const cell = (r, m, res) => `<tr class="${res.ok ? '' : 'err'}"><td class="mono">${r.line}</td><td>${esc(r.name)}</td><td class="mono">${esc(res.uid || r.uid)}</td><td class="num">${r.points === undefined ? 0 : esc(r.points)}</td><td>${photoCell(im, m)}</td><td>${res.ok ? '<span class="pill ok">OK</span>' : `<span class="bad">${esc(res.error)}</span>`}</td></tr>`;
  return `<p class="note"><b>${plural(rows.length, 'row')}</b>: ${rows.length - bad} ready${bad ? `, <span class="bad"><b>${bad} with a problem</b></span>: fix ${bad === 1 ? 'it' : 'them'} in the list above, nothing is imported until every row is fine` : ''}.</p>
    ${wanted ? `<p class="note">${found} of ${plural(wanted, 'photo name')} matched a chosen picture.${sizes}${found < wanted ? ' Rows with no picture get the placeholder portrait.' : ''}</p>` : (im.files.length ? '<p class="note">The list names no photos, so the chosen pictures are not used (add a <code>photo</code> column).</p>' : '')}
    ${unused.length && wanted ? `<p class="note">${plural(unused.length, 'chosen picture')} not used: ${esc(unused.slice(0, 4).map(f => f.name).join(', '))}${unused.length > 4 ? ', …' : ''}.</p>` : ''}
    <div class="imp-scroll"><table class="imp-table"><thead><tr><th>Line</th><th>Holder</th><th>Card UID</th><th>Points</th><th>Photo</th><th>Check</th></tr></thead><tbody>${rows.map((r, i) => cell(r, matches[i], results[i])).join('')}</tbody></table></div>`;
}

function photoCell(im, m) {
  if (m.none) return '<span class="mute">—</span>';
  if (m.error) return `<span class="warn">${esc(m.error)}</span>`;
  const f = im.files[m.index], info = im.info.get(f);
  const tail = !info ? 'making it small…' : info.error ? `<span class="bad">${esc(info.error)}</span>` : `${kb(info.before)} → ${kb(info.after)}`;
  return `${esc(f.name)} <span class="mute">${tail}</span>`;
}

function scheduleImportCheck() { clearTimeout(importTimer); importTimer = setTimeout(runImportCheck, 300); }

async function runImportCheck() {
  const im = state.import;
  if (!im || im.phase !== 'edit') return;
  const seq = ++importSeq;
  im.parsed = PontCsv.parse(im.text); im.check = null; im.checkError = '';
  if (!im.parsed.ok) { im.checking = false; updateImport(); return; }
  im.checking = true; updateImport();
  try {
    const r = await api('POST', '/cards/import/check', { rows: im.parsed.rows.map(({ name, uid, points, line }) => ({ name, uid, points, line })) });
    if (seq !== importSeq || state.import !== im) return;
    im.check = r;
  } catch (e) {
    if (seq !== importSeq || state.import !== im) return;
    im.checkError = e.message;
  }
  im.checking = false; updateImport();
  prepareImportPhotos();
}

/** Starts making the matched pictures small, one at a time (a phone photo is big in memory), while the person reads the list. */
function prepareImportPhotos() {
  const im = state.import;
  if (!im || !im.check) return;
  for (const m of importMatches(im)) {
    if (m.index === undefined) continue;
    const file = im.files[m.index];
    if (im.jobs.has(file)) continue;
    const job = im.chain.then(() => compressPhoto(file));
    im.jobs.set(file, job);
    im.chain = job.then(() => {}, () => {});
    job.then(blob => im.info.set(file, { before: file.size, after: blob.size }), e => im.info.set(file, { error: e.message })).then(paintImportSoon);
  }
}

function addImportFiles(list) {
  const im = state.import;
  if (!im) return;
  for (const f of list) {
    if (!(f.type.startsWith('image/') || IMAGE_NAME.test(f.name))) continue;
    if (!im.files.some(x => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified)) im.files.push(f);
  }
  updateImport();
  prepareImportPhotos();
}

async function uploadPhoto(cardId, blob) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const fd = new FormData(); fd.append('photo', blob, 'photo.jpg');
    try { await api('PUT', `/cards/${cardId}/photo`, fd); return; }
    catch (e) { lastError = e; if (!token) throw e; await new Promise(r => setTimeout(r, 400 * attempt)); }
  }
  throw lastError;
}

/** Sends the photos, four at a time. [tasks] is a list of { id, holder, file (a File), job (its small version) }. Returns the ones that failed. */
async function sendImportPhotos(im, tasks) {
  const failed = [], queue = tasks.slice();
  let done = 0, ok = 0;
  const total = tasks.length;
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      try { await uploadPhoto(t.id, await t.job); ok++; }
      catch (e) { failed.push({ ...t, holder: t.holder, file: t.file.name, reason: e.message }); }
      done++;
      im.progress = `Adding photos: ${done} of ${total}`; im.pct = 50 + (done / total) * 50;
      updateImport();
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, total) }, worker));
  photoCache.clear();
  return { ok, failed };
}

async function doImport() {
  const im = state.import;
  if (!im || im.phase !== 'edit' || !im.parsed || !im.parsed.ok || !im.check || !im.check.ok) return;
  const rows = im.parsed.rows, matches = importMatches(im);
  im.phase = 'working'; im.progress = `Making ${plural(rows.length, 'card')}…`; im.pct = 20;
  render();
  let created;
  try { created = (await api('POST', '/cards/import', { rows: rows.map(({ name, uid, points, line }) => ({ name, uid, points, line })) })).created; }
  catch (e) {   // something changed since the check (for example another admin added one of the cards): show the list again
    im.phase = 'edit'; render(); await runImportCheck();
    if (!im.checkError) im.checkError = e.message;
    updateImport();
    return;
  }
  const tasks = created.flatMap(c => {
    const m = matches[c.index];
    return m && m.index !== undefined ? [{ id: c.id, holder: rows[c.index].name, file: im.files[m.index], job: im.jobs.get(im.files[m.index]) || compressPhoto(im.files[m.index]) }] : [];
  });
  im.progress = tasks.length ? 'Adding photos…' : 'Done'; im.pct = 50; updateImport();
  const { ok, failed } = tasks.length ? await sendImportPhotos(im, tasks) : { ok: 0, failed: [] };
  im.result = { created: created.length, photosOk: ok, noPhoto: created.length - tasks.length, failed };
  im.phase = 'done';
  render();
}

async function retryImportPhotos() {
  const im = state.import;
  if (!im || !im.result || !im.result.failed.length) return;
  const tasks = im.result.failed.map(f => ({ id: f.id, holder: f.holder, file: f.file instanceof File ? f.file : im.files.find(x => x.name === f.file), job: im.jobs.get(im.files.find(x => x.name === f.file)) }));
  im.phase = 'working'; im.progress = 'Trying the failed photos again…'; im.pct = 50; render();
  const { ok, failed } = await sendImportPhotos(im, tasks.map(t => ({ ...t, job: t.job ? t.job.catch(() => compressPhoto(t.file)) : compressPhoto(t.file) })));
  im.result = { ...im.result, photosOk: im.result.photosOk + ok, failed };
  im.phase = 'done';
  render();
}

/* ---------- live updates (WebSocket) ---------- */
/* The server only says what changed ("cards", "transactions" ...). The page then asks for its own data again, but never
   while that would wipe something being typed: it waits until the person is done, then updates at once. */
const PAGE_TOPICS = { report: ['cards', 'transactions', 'presence'], cards: ['cards', 'transactions', 'suggestions'], terminals: ['terminals', 'zones'], readers: ['terminals', 'devices', 'zones'], presence: ['presence', 'zones', 'cards'], program: [], txns: ['transactions'], staff: ['staff'] };
const ALWAYS_TOPICS = ['suggestions', 'devices'];   // their badges are in the side bar of every page
const TIME_DEPENDENT = ['terminals', 'readers', 'presence'];   // "online", "minutes inside": they change as time passes, with no event
let socket = null, reconnectTimer = null, reconnectDelay = 1000, hadConnection = false;
let livePending = false, liveTimer = null, liveRefreshing = false;

function setLiveState(next) {
  liveState = next;
  const el = document.getElementById('live');
  if (el) { el.dataset.state = next; el.textContent = LIVE_LABELS[next] || ''; }
}

function connectLive() {
  if (!token || socket) return;
  clearTimeout(reconnectTimer);
  setLiveState(hadConnection ? 'offline' : 'connecting');
  let ws;
  try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); }
  catch { return scheduleReconnect(); }
  socket = ws;
  // A browser cannot send an Authorization header on a WebSocket, and a token in the address would end up in logs: sign in with the first message.
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'hello') {
      reconnectDelay = 1000; setLiveState('live');
      if (hadConnection) requestLiveRefresh();   // changes may have been missed while it was down
      hadConnection = true;
    } else if (m.type === 'changed' && Array.isArray(m.topics)) {
      const mine = PAGE_TOPICS[state.page] || [];
      if (m.topics.some(t => mine.includes(t) || ALWAYS_TOPICS.includes(t))) requestLiveRefresh();
    }
  });
  ws.addEventListener('close', ev => {
    if (socket === ws) socket = null; else return;
    if (ev.code === 4401) { setLiveState('off'); if (token) signOut(); return; }   // the sign-in ended or was revoked
    scheduleReconnect();
  });
  ws.addEventListener('error', () => { /* 'close' follows */ });
}

function scheduleReconnect() {
  if (!token) return;
  setLiveState('offline');
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectLive, reconnectDelay + Math.random() * 500);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

function disconnectLive() {
  clearTimeout(reconnectTimer); clearTimeout(liveTimer);
  livePending = false; hadConnection = false; reconnectDelay = 1000;
  const ws = socket; socket = null;
  if (ws) { try { ws.close(1000); } catch {} }
  setLiveState('off');
}

/** True while an update would disturb the person: a drawer or dialog is open, or a field has been changed and not saved yet. */
function userIsBusy() {
  if (state.drawer || state.modal) return true;
  for (const el of root.querySelectorAll('input, select, textarea')) {
    if (el.id === 'q') continue;   // the search box drives the list itself
    if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked !== el.defaultChecked) return true; }
    else if (el.tagName === 'SELECT') {
      const def = [...el.options].findIndex(o => o.defaultSelected);
      if (el.selectedIndex !== (def === -1 ? 0 : def)) return true;
    }
    else if (el.type === 'file') { if (el.files && el.files.length) return true; }
    else if (el.value !== el.defaultValue) return true;
  }
  const a = document.activeElement;   // a field that has the cursor is about to be typed in, even if still empty
  return !!(a && a.id !== 'q' && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
}

const saveView = () => ({ y: window.scrollY, pane: $('.pane')?.scrollTop ?? 0, tw: [...document.querySelectorAll('.tw')].map(e => e.scrollLeft) });
function restoreView(v) {
  window.scrollTo(0, v.y);
  const pane = $('.pane'); if (pane) pane.scrollTop = v.pane;
  document.querySelectorAll('.tw').forEach((e, i) => { if (v.tw[i] != null) e.scrollLeft = v.tw[i]; });
}

function requestLiveRefresh() {
  livePending = true;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(tryLiveRefresh, 200);   // changes that come in a burst are fetched once
}

async function tryLiveRefresh() {
  if (!livePending || !token) return;
  if (liveRefreshing) { liveTimer = setTimeout(tryLiveRefresh, 300); return; }
  if (userIsBusy()) { setLiveState('waiting'); liveTimer = setTimeout(tryLiveRefresh, 1000); return; }
  livePending = false; liveRefreshing = true;
  try { await load(); } catch { /* the next change, or the periodic refresh, tries again */ }
  liveRefreshing = false;
  if (!token) return;
  if (userIsBusy()) {   // the person opened something while the data was on its way: keep what they are typing; the new data shows when they are done
    livePending = true; liveTimer = setTimeout(tryLiveRefresh, 1000); return;
  }
  const view = saveView();
  render();
  restoreView(view);
  if (socket && socket.readyState === WebSocket.OPEN) setLiveState('live');
}

// Things like "online" and "minutes inside" change as time passes, without any event.
setInterval(() => { if (token && TIME_DEPENDENT.includes(state.page) && !document.hidden) requestLiveRefresh(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && token) { requestLiveRefresh(); if (!socket) connectLive(); } });

/* ---------- scanning a card (only inside the Pont Admin app, which reads the card when asked) ---------- */
const inApp = () => !!(window.PontNative && PontNative.startScan);
const buzz = kind => { try { window.PontNative && PontNative.feedback && PontNative.feedback(kind); } catch {} };
const NFC_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 8.5a6.5 6.5 0 0 1 0 7"/><path d="M10 6a10 10 0 0 1 0 12"/><path d="M14 3.5a13.5 13.5 0 0 1 0 17"/></svg>';
/** The button that goes next to a field a card's UID can be put into. Only the app has it. */
const nfcButton = target => inApp() ? `<button type="button" class="nfcbtn" data-act="scan" data-target="${target}" aria-label="Scan a card">${NFC_ICON}</button>` : '';

let scanCancel = null;
/** Asks the app to read one card. Shows a sheet while waiting. Resolves with the UID ("04:A2:3B:1C"), or null if cancelled or NFC is not usable. */
function scanCard() {
  return new Promise(resolve => {
    if (scanCancel) return resolve(null);
    const status = PontNative.nfcStatus ? PontNative.nfcStatus() : 'ready';
    if (status !== 'ready') {
      toast(status === 'disabled' ? 'NFC is switched off. Turn it on in the phone’s settings.' : 'This phone cannot read cards.');
      if (status === 'disabled' && PontNative.openNfcSettings) PontNative.openNfcSettings();
      return resolve(null);
    }
    const el = document.createElement('div');
    el.id = 'scan'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Scan a card');
    el.innerHTML = `<div class="scan-card"><div class="scan-rings" aria-hidden="true"><i></i><i></i><i></i></div><h2>Hold a card to the phone</h2>
      <p id="scan-msg">Touch the card to the back of the phone, near the top.</p><button type="button" class="btn line" data-scan="cancel">Cancel</button></div>`;
    document.body.appendChild(el);
    let timer;
    const finish = uid => { clearTimeout(timer); scanCancel = null; window.pontScanned = null; try { PontNative.stopScan(); } catch {} el.remove(); resolve(uid); };
    scanCancel = () => finish(null);
    window.pontScanned = raw => {
      const uid = PontNfc.normalizeUid(raw);
      if (!uid) { buzz('bad'); const m = $('#scan-msg'); if (m) m.textContent = 'That tag is not a card the system can use. Try another card.'; return; }
      buzz('ok'); finish(uid);
    };
    el.addEventListener('click', e => { if (e.target.closest('[data-scan=cancel]') || e.target === el) finish(null); });
    timer = setTimeout(() => finish(null), 30000);
    try { PontNative.startScan(); } catch { finish(null); }
  });
}

/** The scan button of the search box or of the UID field of the card window. */
async function scanInto(target) {
  const uid = await scanCard();
  if (!uid) return;
  if (target === 'q') { state.q = uid; const q = $('#q'); if (q) q.value = uid; await refresh(); return; }
  if (target === 'k-uid') { const k = $('#k-uid'); if (k) { k.value = uid; const e = $('#k-err'); if (e) e.textContent = ''; } return; }
  const field = $('#d-uid'), note = $('#d-nfc');
  if (!field || !state.drawer) return;
  field.value = uid; state.drawer.uid = uid;
  let other = null;
  try { other = PontNfc.findByUid(await api('GET', '/cards?q=' + encodeURIComponent(uid)), uid); } catch { /* the server says so when it is saved */ }
  const own = !!other && state.drawer.mode === 'edit' && other.id === state.drawer.card.id;
  if (other && !own) buzz('bad');
  if (note) {
    note.hidden = false; note.className = 'nfcnote ' + (other && !own ? 'bad' : 'good');
    note.textContent = own ? 'This is already this card’s UID.' : other ? `That card already belongs to ${other.name}.` : 'Card read. The UID is filled in.';
  }
}

/** The app's Back button: close what is open first. Returns true when it did something. */
window.pontBack = function () {
  if (scanCancel) { scanCancel(); return true; }
  if (!token) return false;
  if (state.modal) { state.modal = null; render(); return true; }
  if (state.drawer) { state.drawer = null; render(); return true; }
  if (state.page === 'report') { state.page = 'cards'; state.reportId = null; state.data = {}; render(); refresh(); return true; }
  return false;
};

if (token) { refresh(); connectLive(); } else render();
