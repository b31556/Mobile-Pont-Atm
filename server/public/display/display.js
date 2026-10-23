'use strict';
/* A reader's display page: shows each tap live, and can beep. All text goes in with textContent (names come from the database). */
(() => {
  const key = location.pathname.split('/')[2] || '';
  const params = new URLSearchParams(location.search);
  const HOLD_MS = Math.max(1, Math.min(60, Number(params.get('hold')) || 6)) * 1000;
  const $ = id => document.getElementById(id);
  const stage = $('stage'), idle = $('idle'), result = $('result'), gone = $('gone');

  let state = { name: '', beep: false };
  let soundWanted = true;          // this screen's own switch; the admin's setting decides whether the button exists
  let audio = null;
  let holdTimer = null;
  try { soundWanted = localStorage.getItem('pont-display-sound') !== 'off'; } catch { /* storage may be blocked: sound stays on */ }

  /* ---------- sound ---------- */
  function ctx() {
    if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; } }
    if (audio && audio.state === 'suspended') audio.resume().catch(() => {});
    return audio;
  }
  function tone(c, freq, at, ms, gain, type) {
    const o = c.createOscillator(), g = c.createGain(), t0 = c.currentTime + at, d = ms / 1000;
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);          // short fades: no clicks
    g.gain.setValueAtTime(gain, t0 + Math.max(0.01, d - 0.02));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + d + 0.02);
  }
  const SOUNDS = {
    success: c => { tone(c, 1568, 0, 70, 0.25, 'sine'); tone(c, 2093, 0.095, 130, 0.25, 'sine'); },
    out: c => { tone(c, 1568, 0, 70, 0.25, 'sine'); tone(c, 2093, 0.095, 130, 0.25, 'sine'); },
    in: c => tone(c, 1760, 0, 110, 0.25, 'sine'),
    refused: c => { for (let i = 0; i < 3; i++) tone(c, 1200, i * 0.23, 140, 0.16, 'square'); },
  };
  function beep(name) {
    if (!state.beep || !soundWanted || !name || !SOUNDS[name]) return;
    const c = ctx();
    if (c && c.state === 'running') SOUNDS[name](c);
  }
  function updateSoundButton() {
    const b = $('sound');
    if (!state.beep) { b.hidden = true; return; }
    b.hidden = false;
    const running = audio && audio.state === 'running';
    b.textContent = !soundWanted ? 'Sound off. Click to turn on' : running ? 'Sound on. Click to turn off' : 'Click here once to allow sound';
  }
  $('sound').addEventListener('click', () => {
    const running = audio && audio.state === 'running';
    if (!soundWanted) soundWanted = true;
    else if (running) soundWanted = false;
    try { localStorage.setItem('pont-display-sound', soundWanted ? 'on' : 'off'); } catch { /* ignore */ }
    const c = ctx();
    if (c && soundWanted) { c.resume().then(() => { updateSoundButton(); SOUNDS.in(c); }); }
    updateSoundButton();
  });
  // Any first click or key press on the page also unlocks audio, so the button is only a fallback.
  // A press on the button itself is left to the button, or one press would unlock and switch off in one go.
  for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, e => {
    if (e.target && e.target.closest && e.target.closest('#sound')) return;
    if (state.beep && soundWanted) { ctx(); setTimeout(updateSoundButton, 50); }
  }, { passive: true });

  /* ---------- what is on screen ---------- */
  function showIdle() {
    stage.dataset.state = 'idle';
    result.hidden = true; gone.hidden = true; idle.hidden = false;
    document.title = state.name ? `${state.name} · Tap your card` : 'Tap your card';
  }

  function show(e) {
    clearTimeout(holdTimer);
    stage.dataset.state = e.tone;
    idle.hidden = true; gone.hidden = true; result.hidden = false;

    const photo = $('photo');
    photo.replaceChildren();
    if (e.card) {
      const img = new Image();
      img.alt = '';
      img.onerror = () => { photo.replaceChildren(initial(e.card.name)); };
      img.src = `/display/${encodeURIComponent(key)}/photo/${encodeURIComponent(e.card.id)}?v=${e.seq}`;
      photo.appendChild(img);
    } else photo.appendChild(initial('?'));
    $('name').textContent = e.card ? e.card.name : '';
    $('name').hidden = !e.card;
    $('headline').textContent = e.headline;
    const list = $('details');
    list.replaceChildren(...e.details.map(d => { const li = document.createElement('li'); li.textContent = d; return li; }));
    const bal = $('balance');
    bal.hidden = e.balance == null;
    if (e.balance != null) {
      bal.replaceChildren(document.createTextNode('Balance'), Object.assign(document.createElement('b'), { textContent: String(e.balance) }), document.createTextNode(e.balance === 1 ? 'point' : 'points'));
    }
    document.title = e.headline;
    beep(e.sound);
    holdTimer = setTimeout(showIdle, HOLD_MS);
  }
  function initial(text) { const s = document.createElement('span'); s.textContent = (text || '?').trim().slice(0, 1).toUpperCase(); return s; }

  function setReader(s) {
    state = s;
    $('reader').textContent = s.name || '';
    $('idle-sub').textContent = s.mode === 'presence'
      ? [s.direction === 'in' ? 'Sign in' : s.direction === 'out' ? 'Sign out' : 'Sign in or out', s.zoneName].filter(Boolean).join(' · ')
      : '';
    if (stage.dataset.state === 'idle') showIdle();
    updateSoundButton();
  }

  /* ---------- the live connection ---------- */
  const live = $('live');
  const setLive = ok => { live.dataset.ok = String(ok); live.textContent = ok ? 'Live' : 'Reconnecting…'; };
  let es = null, retryTimer = null;

  // The server answers 404 to a link that was replaced or a reader that was removed: stop trying then.
  function linkGone() {
    if (es) es.close();
    clearTimeout(retryTimer); clearTimeout(holdTimer);
    stage.dataset.state = 'idle';
    idle.hidden = true; result.hidden = true; gone.hidden = false; live.hidden = true; $('sound').hidden = true;
    document.title = 'This link is no longer valid';
  }

  function connect() {
    clearTimeout(retryTimer);
    es = new EventSource(`/display/${encodeURIComponent(key)}/events`);
    es.addEventListener('hello', ev => { setLive(true); setReader(JSON.parse(ev.data)); });
    es.addEventListener('tap', ev => show(JSON.parse(ev.data)));
    es.onerror = () => {
      setLive(false);
      const source = es;
      const giveUpOrRetry = () => {
        // After a network blip the browser retries by itself. After an error answer (a 429 or a proxy's 503) it
        // gives up for good, so a wall screen must start a new connection itself.
        if (source === es && source.readyState === EventSource.CLOSED) { clearTimeout(retryTimer); retryTimer = setTimeout(connect, 5000); }
      };
      fetch(`/display/${encodeURIComponent(key)}/state`, { cache: 'no-store' })
        .then(r => { if (r.status === 404) linkGone(); else giveUpOrRetry(); })
        .catch(giveUpOrRetry);
    };
  }

  // The admin may switch the beep on or off, or rename the reader, while the page is open; a dead link is noticed here too.
  setInterval(() => {
    fetch(`/display/${encodeURIComponent(key)}/state`, { cache: 'no-store' })
      .then(r => r.status === 404 ? (linkGone(), null) : r.ok ? r.json() : null)
      .then(s => { if (s) setReader(s); })
      .catch(() => {});
  }, 30000);

  showIdle();
  connect();
})();
