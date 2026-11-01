'use strict';
/* The Program page of the admin site (and the JSON import/export of the check-in zones): the plain, testable parts.
   A program is the document of GET /public/program: { title, days:[{key,label,date}], goal:{total,dayKey,dayMin}, events:[...] }.
   Nothing here touches the page or the network. The checks only catch the obvious mistakes before sending; the server checks everything again. */
(function (root) {
  const KEY = /^[a-z0-9]{1,12}$/, ID = /^[A-Za-z0-9_-]{1,40}$/, CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
  const MODELS = ['rate', 'tasks', 'flat'], KINDS = ['time', 'task', 'mix'], TEXTS = ['rule', 'bonus', 'bring', 'note', 'check'];
  const minutes = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const isInt = (v, lo, hi) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  const realDate = s => DATE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
  const clone = x => JSON.parse(JSON.stringify(x));
  const str = v => (v === undefined || v === null ? '' : String(v));
  /** '' (or nothing) is "not given"; anything else becomes a number, which is NaN, and so refused, if it is not one. */
  const num = v => { const s = str(v).trim(); return s === '' ? undefined : Number(s); };
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

  /* ---------- showing an event ---------- */

  /** The one-line scoring summary: "8 p / 12 min, up to 24 p", "3 tasks, up to 18 p", "12 p for staying to the end". */
  function summary(e) {
    if (e.model === 'rate') {
      return `${e.rate} p / ${e.block} min` + (e.cap ? `, up to ${e.cap} p` : '') + (e.maxMin ? `, counts at most ${e.maxMin} min` : '');
    }
    if (e.model === 'tasks') {
      const items = e.items || [], home = e.home || [];
      const sum = list => list.reduce((n, x) => n + (Number(x.pts) || 0), 0);
      return `${plural(items.length, 'task')}, up to ${sum(items)} p` + (home.length ? `, ${plural(home.length, 'home task')} (+${sum(home)} p)` : '');
    }
    if (e.model === 'flat') return `${e.cap} p for staying to the end`;
    return '';
  }
  const timeRange = e => `${e.from}–${e.to}`;

  /** Events by day (in the order of the program's days), then start time, end time, title. Events of an unknown day come last. */
  function sorted(doc) {
    const at = e => { const i = doc.days.findIndex(d => d.key === e.day); return i < 0 ? 999 : i; };
    return doc.events.slice().sort((a, b) => at(a) - at(b) || str(a.from).localeCompare(str(b.from)) || str(a.to).localeCompare(str(b.to)) || str(a.title).localeCompare(str(b.title)));
  }
  /** [{ day, events }] for every day of the program (also the ones without events), plus a last group with day null if some event has a day that does not exist. */
  function groups(doc) {
    const all = sorted(doc);
    const out = doc.days.map(day => ({ day, events: all.filter(e => e.day === day.key) }));
    const lost = all.filter(e => !doc.days.some(d => d.key === e.day));
    if (lost.length) out.push({ day: null, events: lost });
    return out;
  }

  /* ---------- ids ---------- */

  /** An id made from the title ("Table tennis" -> "table-tennis"), not one of `taken` ("table-tennis-2", ...). Always 1 to 40 letters, digits, - or _. */
  function slugId(title, taken) {
    const used = new Set(taken || []);
    const base = str(title).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'event';
    if (!used.has(base)) return base;
    for (let n = 2; ; n++) {
      const tail = '-' + n, id = base.slice(0, 40 - tail.length).replace(/-+$/, '') + tail;
      if (!used.has(id)) return id;
    }
  }

  /* ---------- the event form ---------- */

  /** An empty form for a new event: every value a string, as the fields of the window hold them. */
  function blankForm(doc, dayKey) {
    return { title: '', day: dayKey && doc.days.some(d => d.key === dayKey) ? dayKey : (doc.days[0] || {}).key || '', room: '', from: '10:00', to: '11:00', model: 'rate',
      rate: '8', block: '12', cap: '', maxMin: '', items: [{ name: '', pts: '', min: '' }], home: [], kind: '', rule: '', bonus: '', bring: '', note: '', check: '' };
  }
  /** The form values of an existing event. */
  function formFromEvent(e) {
    const f = blankForm({ days: [] }, '');
    Object.assign(f, { title: str(e.title), day: str(e.day), room: str(e.room), from: str(e.from), to: str(e.to), model: e.model, rate: str(e.rate), block: str(e.block), cap: str(e.cap), maxMin: str(e.maxMin), kind: str(e.kind) });
    f.items = (e.items || []).map(i => ({ name: str(i.name), pts: str(i.pts), min: str(i.min) }));
    if (!f.items.length) f.items = [{ name: '', pts: '', min: '' }];
    f.home = (e.home || []).map(h => ({ name: str(h.name), pts: str(h.pts) }));
    for (const k of TEXTS) f[k] = str(e[k]);
    return f;
  }
  /** The event the form describes (without an id): only the fields of the chosen model, numbers as numbers, blank optional things left out,
      rows of a list that were left completely empty dropped. A value that is not a number stays NaN, which validateEvent refuses. */
  function eventFromForm(f) {
    const e = { day: str(f.day), title: str(f.title).trim(), room: str(f.room).trim(), from: str(f.from).trim(), to: str(f.to).trim(), model: f.model };
    if (f.model === 'rate') {
      e.rate = num(f.rate); e.block = num(f.block);
      if (num(f.cap) !== undefined) e.cap = num(f.cap);
      if (num(f.maxMin) !== undefined) e.maxMin = num(f.maxMin);
    } else if (f.model === 'tasks') {
      const blank = r => Object.values(r).every(v => str(v).trim() === '');
      e.items = (f.items || []).filter(r => !blank(r)).map(r => ({ name: str(r.name).trim(), pts: num(r.pts), min: num(r.min) }));
      const home = (f.home || []).filter(r => !blank(r)).map(r => ({ name: str(r.name).trim(), pts: num(r.pts) }));
      if (home.length) e.home = home;
    } else if (f.model === 'flat') e.cap = num(f.cap);
    if (f.kind) e.kind = f.kind;
    for (const k of TEXTS) if (str(f[k]).trim()) e[k] = str(f[k]).trim();
    return e;
  }

  /** What is wrong with the event (in words for the person who typed it), or null. */
  function validateEvent(e, doc) {
    if (!e.title || e.title.length > 100) return 'Give the event a title (up to 100 characters).';
    if (!e.room || e.room.length > 60) return 'Give the event a room (up to 60 characters).';
    if (!doc.days.some(d => d.key === e.day)) return 'Pick the day of the event.';
    if (!CLOCK.test(e.from) || !CLOCK.test(e.to)) return 'Give the start and the end as times like 08:00.';
    if (minutes(e.to) <= minutes(e.from)) return 'The event must end after it starts.';
    if (!MODELS.includes(e.model)) return 'Pick how the event scores.';
    if (e.model === 'rate') {
      if (!isInt(e.rate, 1, 1000)) return 'Points per block must be a whole number from 1 to 1000.';
      if (!isInt(e.block, 1, 600)) return 'The block length must be a whole number of minutes, 1 to 600.';
      if (e.cap !== undefined && !isInt(e.cap, 1, 10000)) return 'The most points must be empty or a whole number from 1 to 10000.';
      if (e.maxMin !== undefined && !isInt(e.maxMin, 1, 1440)) return 'The longest stay that counts must be empty or a whole number of minutes, 1 to 1440.';
    } else if (e.model === 'tasks') {
      if (!e.items.length || e.items.length > 20) return 'A tasks event needs 1 to 20 tasks.';
      for (const [i, t] of e.items.entries()) {
        if (!t.name || t.name.length > 60) return `Task ${i + 1} needs a name (up to 60 characters).`;
        if (!isInt(t.pts, 0, 1000)) return `Task ${i + 1}: points must be a whole number from 0 to 1000.`;
        if (!isInt(t.min, 1, 600)) return `Task ${i + 1}: minutes must be a whole number from 1 to 600.`;
      }
      const home = e.home || [];
      if (home.length > 10) return 'At most 10 home tasks.';
      for (const [i, t] of home.entries()) {
        if (!t.name || t.name.length > 60) return `Home task ${i + 1} needs a name (up to 60 characters).`;
        if (!isInt(t.pts, 0, 1000)) return `Home task ${i + 1}: points must be a whole number from 0 to 1000.`;
      }
    } else if (!isInt(e.cap, 1, 10000)) return 'Give the points for staying to the end (a whole number, 1 to 10000).';
    if (e.kind !== undefined && !KINDS.includes(e.kind)) return 'The kind must be time, task or mix.';
    for (const k of TEXTS) if (e[k] !== undefined && e[k].length > 300) return `The ${k} text can be up to 300 characters.`;
    return null;
  }

  /* ---------- changing the document: each returns { doc } (a changed copy) or { error } ---------- */

  /** Adds a new event (existingId null: its id is made from the title) or replaces the event `existingId` (which keeps its id). */
  function applyEvent(doc, form, existingId) {
    const e = eventFromForm(form), problem = validateEvent(e, doc);
    if (problem) return { error: problem };
    const next = clone(doc);
    if (existingId) {
      const at = next.events.findIndex(x => x.id === existingId);
      if (at < 0) return { error: 'That event is no longer in the program (someone else may have deleted it). Close this window and refresh.' };
      next.events[at] = { id: existingId, ...e };
      return { doc: next, id: existingId };
    }
    if (next.events.length >= 300) return { error: 'The program can have up to 300 events.' };
    const id = slugId(e.title, next.events.map(x => x.id));
    next.events.push({ id, ...e });
    return { doc: next, id };
  }
  function removeEvent(doc, id) {
    if (!doc.events.some(x => x.id === id)) return { error: 'That event is no longer in the program.' };
    const next = clone(doc);
    next.events = next.events.filter(x => x.id !== id);
    return { doc: next };
  }
  /** Removes every event; the title, days and goal stay. */
  function clearEvents(doc) { const next = clone(doc); next.events = []; return { doc: next }; }

  /** What is obviously wrong with the whole document, or null. */
  function validateDoc(doc) {
    if (!doc.title || doc.title.length > 80) return 'The program needs a title of up to 80 characters.';
    if (!Array.isArray(doc.days) || doc.days.length < 1 || doc.days.length > 4) return 'The program needs 1 to 4 days.';
    const seen = new Set();
    for (const [i, d] of doc.days.entries()) {
      if (!KEY.test(d.key)) return `Day ${i + 1} needs a short key: up to 12 lower-case letters and digits, like day1.`;
      if (seen.has(d.key)) return `The day key “${d.key}” is used twice.`;
      seen.add(d.key);
      if (!d.label || d.label.length > 30) return `Day ${i + 1} needs a label of up to 30 characters.`;
      if (!realDate(d.date)) return `Day ${i + 1} needs a date like 2026-10-22.`;
    }
    const g = doc.goal || {};
    if (!isInt(g.total, 0, 10000)) return 'The goal needs a total, a whole number of points.';
    if (!seen.has(g.dayKey)) return 'Pick the day of the goal from the days of the program.';
    if (!isInt(g.dayMin, 0, 10000)) return 'The goal needs the points needed on that day, a whole number.';
    const lost = doc.events.filter(e => !seen.has(e.day));
    if (lost.length) return `${plural(lost.length, 'event')} (like “${lost[0].title}”) ${lost.length === 1 ? 'is' : 'are'} on a day that is not in the program: move or delete ${lost.length === 1 ? 'it' : 'them'} first.`;
    return null;
  }

  /** The values of the settings form (all strings) as a draft; days keep `isNew` so that only a new day's key can be typed. */
  function settingsForm(doc) {
    return { title: doc.title, total: str(doc.goal.total), dayKey: doc.goal.dayKey, dayMin: str(doc.goal.dayMin), days: doc.days.map(d => ({ key: d.key, label: d.label, date: d.date, isNew: false })) };
  }
  /** The document with the title, goal and days of the settings form. Events are left as they are. */
  function applySettings(doc, form) {
    const next = clone(doc);
    next.title = str(form.title).trim();
    next.days = form.days.map(d => ({ key: str(d.key).trim().toLowerCase(), label: str(d.label).trim(), date: str(d.date).trim() }));
    next.goal = { total: num(form.total), dayKey: str(form.dayKey), dayMin: num(form.dayMin) };
    const problem = validateDoc(next);
    return problem ? { error: problem } : { doc: next };
  }

  /* ---------- JSON in and out ---------- */

  /** The document without what the server adds when it is read (`updatedAt`). */
  function clean(doc) { const { updatedAt, ...rest } = doc; return rest; }
  /** The program as formatted JSON: what Export shows and what Import takes. */
  const toJson = doc => JSON.stringify(clean(doc), null, 2);

  /** The pasted text as a program document, or what is wrong with it. Only the shape is checked here; the server checks the rest and says what it finds. */
  function parseImport(text) {
    if (!str(text).trim()) return { error: 'Paste the program as JSON first.' };
    let v;
    try { v = JSON.parse(text); } catch (e) { return { error: 'That is not valid JSON (' + e.message + '). Check the commas and quotes.' }; }
    if (Array.isArray(v)) return { error: 'That is a list of events. Paste the whole program: { "title": …, "days": […], "goal": {…}, "events": […] }, like the example.' };
    if (!v || typeof v !== 'object') return { error: 'Paste the whole program as one JSON object, like the example.' };
    if (!Array.isArray(v.events)) return { error: 'The program needs an "events" list (it may be empty: []).' };
    return { doc: clean(v) };
  }

  /** A small example for the Import window. */
  const EXAMPLE = {
    title: 'Spring event',
    days: [{ key: 'day1', label: 'Day 1', date: '2026-04-10' }, { key: 'day2', label: 'Day 2', date: '2026-04-11' }],
    goal: { total: 60, dayKey: 'day2', dayMin: 30 },
    events: [
      { id: 'table-tennis', day: 'day1', title: 'Table tennis', room: 'Hall', from: '10:00', to: '12:00', model: 'rate', rate: 8, block: 12, cap: 24, rule: '8 points per 12 minutes, up to 24 points.' },
      { id: 'quiz', day: 'day1', title: 'Quiz', room: 'Quiz room', from: '13:00', to: '14:00', model: 'tasks', items: [{ name: 'Round 1', pts: 6, min: 20 }, { name: 'Round 2', pts: 6, min: 20 }] },
      { id: 'closing', day: 'day2', title: 'Closing show', room: 'Main hall', from: '15:00', to: '16:00', model: 'flat', cap: 12 },
    ],
  };

  /* ---------- zones as JSON (the Check-in page) ---------- */

  /** The zones as formatted JSON in the shape POST /zones/import takes: { zones: [{ name, settings }] }. */
  const zonesToJson = zones => JSON.stringify({ zones: zones.map(z => ({ name: z.name, settings: z.settings })) }, null, 2);
  /** The pasted text as the body of POST /zones/import, or what is wrong with it (the server checks every zone and says which one is wrong). */
  function parseZonesImport(text) {
    if (!str(text).trim()) return { error: 'Paste the zones as JSON first.' };
    let v;
    try { v = JSON.parse(text); } catch (e) { return { error: 'That is not valid JSON (' + e.message + '). Check the commas and quotes.' }; }
    if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.zones)) return { error: 'Paste an object with a "zones" list: { "zones": [ { "name": …, "settings": {…} } ] }, like the example.' };
    if (!v.zones.length) return { error: 'The "zones" list is empty.' };
    if (v.zones.length > 100) return { error: 'At most 100 zones can be imported at once.' };
    return { body: { zones: v.zones } };
  }
  const ZONES_EXAMPLE = { zones: [{ name: 'Table tennis', settings: { pointsPerBlock: 8, blockMinutes: 12, rounding: 'down', minMinutes: 0, maxPointsVisit: null, maxPoints24h: null, maxStayHours: 12, cooldownSeconds: 30 } }] };

  root.PontProgram = {
    summary, timeRange, sorted, groups, slugId, blankForm, formFromEvent, eventFromForm, validateEvent, applyEvent, removeEvent, clearEvents,
    validateDoc, settingsForm, applySettings, toJson, parseImport, clean, EXAMPLE, zonesToJson, parseZonesImport, ZONES_EXAMPLE,
  };
})(typeof window !== 'undefined' ? window : globalThis);
