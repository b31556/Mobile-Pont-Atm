'use strict';
/* Pont admin: plain JS client for the server's JSON API. */

const root = document.getElementById('root');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, r = document) => r.querySelector(s);

const state = { page: 'cards', q: '', drawer: null, modal: null, toast: '', loginError: '', data: {} };
let token = null;
try { token = sessionStorage.getItem('pont-token'); } catch {}

/* ---------- api ---------- */
async function api(method, path, body) {
  const opts = { method, headers: {} };
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
  token = null; try { sessionStorage.removeItem('pont-token'); } catch {}
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
  if (p === 'cards') {
    const [cards, tx] = await Promise.all([api('GET', '/cards?q=' + encodeURIComponent(state.q)), api('GET', '/transactions?limit=200')]);
    const all = state.q ? await api('GET', '/cards') : cards;
    state.data = { cards, all, tx };
  } else if (p === 'terminals') state.data = { terminals: await api('GET', '/terminals') };
  else if (p === 'txns') state.data = { tx: await api('GET', '/transactions?limit=100') };
  else state.data = { staff: await api('GET', '/staff') };
}
async function refresh() { try { await load(); } catch (e) { if (token) state.toast = e.message; } render(); }

/* ---------- views ---------- */
function loginView() {
  return `<div class="login-wrap"><form class="alogin" id="login">
    <div class="brand" style="color:var(--ink)"><span class="coin">P</span>Pont admin</div>
    <h1>Sign in</h1>
    <label class="field">Email<input name="email" type="email" autocomplete="username" required></label>
    <label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label>
    ${state.loginError ? `<p class="err" role="alert">${esc(state.loginError)}</p>` : ''}
    <button class="btn green" style="justify-content:center">Sign in</button>
  </form></div>`;
}

function shell(inner) {
  const item = (id, l) => `<button data-go="${id}" aria-current="${state.page === id}">${l}</button>`;
  return `<div class="adm"><aside class="side"><div class="brand"><span class="coin">P</span>Pont admin</div>
    ${item('cards', 'Cards')}${item('terminals', 'Terminals')}${item('txns', 'Transactions')}${item('staff', 'Staff')}
    <div class="me"><button data-act="signout">Sign out</button></div></aside>
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
      <td><button class="btn line sm" data-act="toggle" data-id="${c.id}">${c.status === 'blocked' ? 'Unblock' : 'Block'}</button></td></tr>`).join('')
    : `<tr><td colspan="6" class="empty">${state.q ? 'No card matches “' + esc(state.q) + '”. Try a name or a UID.' : 'No cards yet. Add the first one.'}</td></tr>`;
  return `<div class="ph"><div><h1>Cards</h1><p>${active} active, ${all.length - active} blocked</p></div><span class="sp"></span>
    <input class="search" id="q" placeholder="Search name or UID" value="${esc(state.q)}" aria-label="Search cards">
    <button class="btn green" data-act="newcard">Add card</button></div>
    <div class="stats"><div class="stat"><b>${all.reduce((s, c) => s + c.balance, 0)}</b><span>Points on cards</span></div>
    <div class="stat"><b>${given}</b><span>Given today, after storno</span></div><div class="stat"><b>${active}</b><span>Active cards</span></div></div>
    <div class="tw"><table><thead><tr><th>Holder</th><th>Card UID</th><th>Points</th><th>Status</th><th>Last used</th><th></th></tr></thead><tbody id="rows">${rows}</tbody></table></div>`;
}

function terminalsPane() {
  const list = state.data.terminals || [];
  return `<div class="ph"><div><h1>Terminals</h1><p>Phones paired to a terminal name. Operators sign in on them.</p></div><span class="sp"></span>
    <button class="btn green" data-act="newterm">Pair a phone</button></div>
    <div class="tw"><table><thead><tr><th>Terminal</th><th>Status</th><th>Operator</th><th>Phone</th><th>App</th><th>Given today</th><th></th></tr></thead><tbody>
    ${list.length ? list.map(t => `<tr><td><b>${esc(t.name)}</b><div style="font-size:12px;color:var(--ink-3)">${esc(t.place)}</div></td>
      <td>${t.online ? '<span class="pill ok">Online</span>' : '<span class="pill mute">Offline</span>'}<div style="font-size:12px;color:var(--ink-3)">${t.lastSeen ? esc(when(t.lastSeen)) : 'Never seen'}</div></td>
      <td>${t.operator ? esc(t.operator) : '<span style="color:var(--ink-3)">Nobody yet</span>'}</td><td style="color:var(--ink-2)">${esc(t.device || '—')}</td>
      <td class="mono">${esc(t.appVersion || '—')}</td><td class="num">${t.givenToday}</td>
      <td><div class="rowbtns"><button class="btn line sm" data-act="newcode" data-id="${t.id}">New code</button><button class="btn line sm" data-act="revoke" data-id="${t.id}" data-name="${esc(t.name)}">Revoke</button></div></td></tr>`).join('')
      : '<tr><td colspan="7" class="empty">No terminals yet. Pair the first phone.</td></tr>'}
    </tbody></table></div>`;
}

function txnsPane() {
  const tx = state.data.tx || [];
  return `<div class="ph"><div><h1>Transactions</h1><p>Newest first. Storno adds a reversing row and keeps the original.</p></div></div>
    <div class="tw"><table><thead><tr><th>Time</th><th>ID</th><th>Holder</th><th>Points</th><th>Terminal</th><th>Operator</th><th>Status</th><th></th></tr></thead><tbody>
    ${tx.length ? tx.map(t => `<tr><td>${esc(when(t.createdAt))}</td><td class="mono">T-${t.id}</td>
      <td><div class="hold">${avatar({ ...t.card, hasPhoto: false })}${esc(t.card.name)}</div></td>
      <td class="num ${t.amount < 0 ? 'neg' : ''}">${signed(t.amount)}</td><td>${esc(t.terminal || '—')}</td><td>${esc(t.operator || '—')}</td>
      <td>${t.type === 'storno' ? `<span class="pill amber">Storno of T-${t.ref}</span>` : t.status === 'stornoed' ? '<span class="pill mute">Stornoed</span>' : '<span class="pill ok">Completed</span>'}</td>
      <td>${t.type === 'give' && t.status === 'ok' ? `<button class="btn line sm" data-act="storno" data-id="${t.id}">Storno</button>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="8" class="empty">No transactions yet.</td></tr>'}
    </tbody></table></div>`;
}

function staffPane() {
  const list = state.data.staff || [];
  return `<div class="ph"><div><h1>Staff</h1><p>Operators use the app. Admins use this site.</p></div><span class="sp"></span><button class="btn green" data-act="newstaff">Add staff</button></div>
    <div class="tw"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(s => `<tr><td><b>${esc(s.name)}</b></td><td class="mono">${esc(s.email)}</td><td>${s.role === 'admin' ? 'Admin' : 'Operator'}</td>
      <td>${s.active ? '<span class="pill ok">Active</span>' : '<span class="pill mute">Switched off</span>'}</td>
      <td><div class="rowbtns"><button class="btn line sm" data-act="resetpw" data-id="${s.id}">Reset password</button><button class="btn line sm" data-act="staffactive" data-id="${s.id}" data-on="${s.active ? 1 : 0}">${s.active ? 'Switch off' : 'Switch on'}</button></div></td></tr>`).join('')}
    </tbody></table></div>`;
}

function drawerView() {
  const d = state.drawer, isNew = d.mode === 'new';
  const c = isNew ? { name: '', uid: '', balance: 0, status: 'active', photoUrl: '', hasPhoto: false } : d.card;
  const hist = isNew ? [] : (state.data.tx || []).filter(t => t.card.id === c.id).slice(0, 4);
  return `<div class="drawer-scrim" data-act="closedrawer"><div class="drawer" data-stop>
    <h2>${isNew ? 'Add card' : esc(c.name)}</h2>
    <label class="drop" style="cursor:pointer"><span id="dprev">${isNew ? '<span class="av" style="width:64px;height:64px;display:grid;place-items:center;color:#7C8B96;font-weight:800;font-size:24px">?</span>' : avatar(c)}</span>
      <span><b>Photo</b>Click to choose a JPEG, PNG or WebP up to 2 MB. The terminal shows it after each tap.</span>
      <input id="d-photo" type="file" accept="image/jpeg,image/png,image/webp" class="hidden"></label>
    <label class="field">Holder name<input id="d-name" value="${esc(c.name)}" placeholder="Full name"></label>
    <label class="field">Card UID<input id="d-uid" class="mono" value="${esc(c.uid)}" placeholder="04:A2:3B:1C"></label>
    <p style="font-size:12px;color:var(--ink-3);margin-top:-6px">Tap the card on a terminal. An unregistered card shows its UID on the phone.</p>
    ${isNew ? '<label class="field">Starting points<input id="d-pts" type="number" min="0" value="0"></label>'
      : `<div class="dsep"></div><div class="inline" style="align-items:center"><div style="flex:1"><b class="num" style="font-size:26px">${c.balance}</b> points</div>${statusPill(c.status)}</div>
         <div class="inline"><input class="search" id="d-adj" type="number" placeholder="Adjust by, e.g. -5" style="min-width:0;flex:1" aria-label="Adjust balance by"><button class="btn line" data-act="adjust" type="button">Apply</button></div>
         <div class="mini"><b style="color:var(--ink)">Recent</b>${hist.length ? hist.map(t => `<div><span>${esc(when(t.createdAt))} · T-${t.id}</span><span class="${t.amount < 0 ? 'neg' : ''}">${signed(t.amount)}</span></div>`).join('') : '<div><span>No transactions yet</span></div>'}</div>`}
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
  if (m.kind === 'revoke') return `<div class="modal-scrim" data-act="closemodal"><div class="modal" data-stop>
    <h2>Revoke ${esc(m.name)}?</h2><p style="color:var(--ink-2)">The phone is signed out and can’t sign in again until it is paired with a new code.</p>
    <div class="inline"><button class="btn line" style="flex:1;justify-content:center" data-act="closemodal">Keep</button><button class="btn red" style="flex:1;justify-content:center" data-act="dorevoke" data-id="${m.id}">Revoke</button></div></div></div>`;
  if (m.kind === 'newstaff') return `<div class="modal-scrim" data-act="closemodal"><form class="modal" id="staffform" data-stop>
    <h2>Add staff</h2>
    <label class="field" style="text-align:left">Name<input name="name" required></label>
    <label class="field" style="text-align:left">Email<input name="email" type="email" required></label>
    <label class="field" style="text-align:left">Role<select name="role"><option value="operator">Operator (app)</option><option value="admin">Admin (this site)</option></select></label>
    <p class="err" id="s-err" role="alert"></p>
    <div class="inline"><button class="btn line" style="flex:1;justify-content:center" type="button" data-act="closemodal">Cancel</button><button class="btn green" style="flex:1;justify-content:center">Add</button></div></form></div>`;
  if (m.kind === 'secret') return `<div class="modal-scrim" data-act="closemodal"><div class="modal" data-stop>
    <h2>${esc(m.title)}</h2><p style="color:var(--ink-2)">Give ${esc(m.who)} this temporary password. It is shown only once.</p>
    <div class="secret">${esc(m.password)}</div><button class="btn green" style="justify-content:center" data-act="closemodal">Done</button></div></div>`;
  return '';
}

function render() {
  const focus = document.activeElement?.id, pos = document.activeElement?.selectionStart;
  if (!token) { root.innerHTML = loginView(); return; }
  const pane = { cards: cardsPane, terminals: terminalsPane, txns: txnsPane, staff: staffPane }[state.page]();
  root.innerHTML = shell(pane);
  if (focus === 'q') { const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos); }
  loadPhotos();
}

/* ---------- events ---------- */
const tempPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

root.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'login') {
    const fd = new FormData(f);
    try {
      const r = await api('POST', '/auth/login', { email: fd.get('email'), password: fd.get('password') });
      if (r.user.role !== 'admin') { state.loginError = 'This account is for the terminal app. Sign in with an admin account.'; return render(); }
      token = r.token; try { sessionStorage.setItem('pont-token', token); } catch {}
      state.loginError = ''; state.page = 'cards'; await refresh();
    } catch (err) { state.loginError = err.message; render(); }
  } else if (f.id === 'termform') {
    await guard(async () => {
      const fd = new FormData(f);
      const r = await api('POST', '/terminals', { name: fd.get('name'), place: fd.get('place') });
      state.modal = { kind: 'code', name: r.terminal.name, code: r.pairingCode }; await refresh();
    });
  } else if (f.id === 'staffform') {
    const fd = new FormData(f), password = tempPassword();
    try {
      await api('POST', '/staff', { name: fd.get('name'), email: fd.get('email'), role: fd.get('role'), password });
      state.modal = { kind: 'secret', title: 'Staff member added', who: fd.get('name'), password }; await refresh();
    } catch (err) { $('#s-err').textContent = err.message; }
  }
});

root.addEventListener('input', e => {
  if (e.target.id === 'q') { state.q = e.target.value; refresh(); }
});
root.addEventListener('change', e => {
  if (e.target.id === 'd-photo') {
    const file = e.target.files[0];
    if (file) { $('#dprev').innerHTML = `<img class="av" style="width:64px;height:64px;object-fit:cover" alt="Chosen photo" src="${URL.createObjectURL(file)}">`; }
  }
});

root.addEventListener('click', async e => {
  const nav = e.target.closest('[data-go]');
  if (nav) { state.page = nav.dataset.go; state.q = ''; state.data = {}; render(); return refresh(); }
  const el = e.target.closest('[data-act]'); if (!el) return;
  if ((el.classList.contains('drawer-scrim') || el.classList.contains('modal-scrim')) && e.target.closest('[data-stop]')) return;
  const act = el.dataset.act, id = el.dataset.id;
  const card = id && (state.data.all || state.data.cards || []).find(c => c.id === id);
  switch (act) {
    case 'signout': signOut(); break;
    case 'newcard': state.drawer = { mode: 'new' }; render(); break;
    case 'edit': state.drawer = { mode: 'edit', card }; render(); break;
    case 'closedrawer': state.drawer = null; render(); break;
    case 'closemodal': state.modal = null; render(); break;
    case 'toggle': e.stopPropagation(); await guard(async () => { const c = await api('PATCH', '/cards/' + id, { status: card.status === 'blocked' ? 'active' : 'blocked' }); await refresh(); toast(c.name + (c.status === 'blocked' ? ' is now blocked.' : ' is active again.')); }); break;
    case 'adjust': await guard(async () => {
      const delta = parseInt($('#d-adj').value, 10);
      if (!delta) throw new Error('Enter a whole number, not 0.');
      const c = await api('POST', `/cards/${state.drawer.card.id}/adjust`, { delta });
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
        if (file) { const fd = new FormData(); fd.append('photo', file); await api('PUT', `/cards/${saved.id}/photo`, fd); photoCache.clear(); }
        state.drawer = null; await refresh(); toast('Saved.');
      } catch (ex) { err.textContent = ex.message; }
      break; }
    case 'newterm': state.modal = { kind: 'newterm' }; render(); break;
    case 'newcode': await guard(async () => { const t = state.data.terminals.find(x => x.id === id); const r = await api('POST', `/terminals/${id}/pairing-code`); state.modal = { kind: 'code', name: t.name, code: r.pairingCode }; render(); }); break;
    case 'revoke': state.modal = { kind: 'revoke', id, name: el.dataset.name }; render(); break;
    case 'dorevoke': await guard(async () => { await api('DELETE', '/terminals/' + id); state.modal = null; await refresh(); toast('Terminal revoked.'); }); break;
    case 'storno': await guard(async () => { await api('POST', `/transactions/${id}/storno`); await refresh(); toast('Stornoed T-' + id + '.'); }); break;
    case 'newstaff': state.modal = { kind: 'newstaff' }; render(); break;
    case 'staffactive': await guard(async () => { await api('PATCH', '/staff/' + id, { active: el.dataset.on !== '1' }); await refresh(); }); break;
    case 'resetpw': await guard(async () => {
      const s = state.data.staff.find(x => x.id === id), password = tempPassword();
      await api('PATCH', '/staff/' + id, { password });
      state.modal = { kind: 'secret', title: 'Password reset', who: s.name, password }; render();
    }); break;
  }
});

if (token) refresh(); else render();
