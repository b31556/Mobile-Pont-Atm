'use strict';
/*
 * The horizontal timeline of one card's report. Only days with something on them are drawn, side by side, each as wide as its own
 * activity needs, so a card seen twice a month still reads at a glance. One lane per zone shows its visits as bars (green: paid,
 * red: cancelled, amber: signed out too late, blue: inside now); a last lane shows grants, refunds and adjustments as dots.
 * A pure function of the report: it returns HTML (an SVG with a column of lane names beside it) and some numbers, and touches nothing.
 */
(function (root) {
  const HOUR = 3600000;
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const dayStart = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dayAfter = ms => { const d = new Date(ms); d.setHours(24, 0, 0, 0); return d.getTime(); };
  const clock = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const dayName = ms => { const d = new Date(ms); return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
  const lengthOf = min => (min == null ? '' : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${pad(min % 60)} min`);

  const LAYOUT = { header: 46, lane: 40, laneGap: 6, barPad: 6, pointsLane: 70, padLeft: 14, sameGap: 14, breakGap: 44, minHours: 2 };
  const STATUS_TEXT = { closed: 'paid', discarded: 'cancelled', expired: 'not signed out in time', open: 'inside now' };

  /**
   * [report] is the answer of GET /cards/:id/report. Options: pxPerHour (zoom, default 70), lastDays (show only the last N days
   * with activity, or null for all), nowMs (for the "inside now" bar and the line at the present).
   * Returns { html, width, days, hiddenDays, lanes }.
   */
  function render(report, opts = {}) {
    const pxPerHour = Math.max(8, opts.pxPerHour || 70);
    const nowMs = opts.nowMs ?? Date.now();
    const spans = (report.visits || []).map(v => {
      const start = Date.parse(v.inAt);
      const end = v.outAt ? Date.parse(v.outAt) : v.status === 'open' ? nowMs : start;
      return { v, start, end: Math.max(start, end) };
    }).filter(s => Number.isFinite(s.start) && Number.isFinite(s.end));
    const marks = (report.events || []).filter(e => e.type === 'grant' || e.type === 'refund' || e.type === 'adjust')
      .map(e => ({ e, at: Date.parse(e.at) })).filter(m => Number.isFinite(m.at));
    if (!spans.length && !marks.length) return { html: '<p class="empty">Nothing has happened with this card yet.</p>', width: 0, days: 0, hiddenDays: 0, lanes: [] };

    // What each day holds: the earliest and latest moment of anything on it.
    const dayMap = new Map();
    const touch = (day, from, to) => {
      const d = dayMap.get(day) ?? { start: day, min: from, max: to };
      d.min = Math.min(d.min, from); d.max = Math.max(d.max, to);
      dayMap.set(day, d);
    };
    for (const s of spans) for (let d = dayStart(s.start); d <= s.end; d = dayAfter(d)) touch(d, Math.max(s.start, d), Math.min(s.end, dayAfter(d)));
    for (const m of marks) touch(dayStart(m.at), m.at, m.at);
    if (spans.some(s => s.v.status === 'open')) touch(dayStart(nowMs), nowMs, nowMs);

    let cols = [...dayMap.values()].sort((a, b) => a.start - b.start).map(d => {
      const end = dayAfter(d.start);
      let from = Math.max(d.start, Math.floor(d.min / HOUR) * HOUR - HOUR / 2);       // half an hour of air before and after
      let to = Math.min(end, Math.ceil(d.max / HOUR) * HOUR + HOUR / 2);
      if (to - from < LAYOUT.minHours * HOUR) to = Math.min(end, from + LAYOUT.minHours * HOUR);
      if (to - from < LAYOUT.minHours * HOUR) from = Math.max(d.start, to - LAYOUT.minHours * HOUR);
      return { day: d.start, end, from, to, x: 0, w: 0 };
    });
    const hiddenDays = opts.lastDays && cols.length > opts.lastDays ? cols.length - opts.lastDays : 0;
    if (hiddenDays) cols = cols.slice(-opts.lastDays);
    const firstShown = cols[0].from;

    let cursor = LAYOUT.padLeft;
    cols.forEach((c, i) => {
      if (i) cursor += dayAfter(cols[i - 1].day) === c.day ? LAYOUT.sameGap : LAYOUT.breakGap;
      c.x = cursor; c.w = (c.to - c.from) / HOUR * pxPerHour; cursor += c.w;
    });
    const width = Math.ceil(cursor + LAYOUT.padLeft);
    const colAt = ms => cols.find(c => ms >= c.from - 1 && ms <= c.to + 1);
    const xOf = (ms, c) => c.x + (Math.min(Math.max(ms, c.from), c.to) - c.from) / HOUR * pxPerHour;

    // Lanes: a zone per lane in the order the card first went there.
    const zones = [];
    for (const s of [...spans].sort((a, b) => a.start - b.start)) if (!zones.includes(s.v.zone)) zones.push(s.v.zone);
    const laneTop = i => LAYOUT.header + i * (LAYOUT.lane + LAYOUT.laneGap);
    const pointsTop = LAYOUT.header + zones.length * (LAYOUT.lane + LAYOUT.laneGap);
    const height = pointsTop + LAYOUT.pointsLane + 8;

    const out = [];
    // day columns, with the date and the hours
    const stride = pxPerHour >= 56 ? 1 : pxPerHour >= 28 ? 2 : 4;
    cols.forEach((c, i) => {
      out.push(`<rect class="tl-day${i % 2 ? ' alt' : ''}" x="${c.x}" y="${LAYOUT.header - 8}" width="${c.w}" height="${height - LAYOUT.header + 8}" rx="8"/>`);
      out.push(`<text class="tl-date" x="${c.x + 6}" y="16">${esc(dayName(c.day))}</text>`);
      for (let h = Math.ceil(c.from / HOUR) * HOUR; h <= c.to; h += HOUR) {
        if (h >= c.end) continue;                       // the end of one day is the start of the next, which draws its own midnight
        const x = c.x + (h - c.from) / HOUR * pxPerHour, hour = new Date(h).getHours();
        out.push(`<line class="tl-grid" x1="${x}" x2="${x}" y1="${LAYOUT.header - 4}" y2="${height - 4}"/>`);
        if (hour % stride === 0) out.push(`<text class="tl-hour" x="${x}" y="34" text-anchor="middle">${pad(hour)}</text>`);
      }
      if (i && dayAfter(cols[i - 1].day) !== c.day) out.push(`<text class="tl-break" x="${c.x - LAYOUT.breakGap / 2}" y="${LAYOUT.header + 18}" text-anchor="middle">⋯</text>`);
    });

    // visits as bars, a piece in each day they touch
    for (const s of spans) {
      const lane = zones.indexOf(s.v.zone), y = laneTop(lane) + LAYOUT.barPad, h = LAYOUT.lane - 2 * LAYOUT.barPad;
      const status = ['closed', 'discarded', 'expired', 'open'].includes(s.v.status) ? s.v.status : 'closed';
      const tip = [`${s.v.zone}: ${STATUS_TEXT[status] || status}`,
        `In ${dayName(s.start)} ${clock(s.start)}${s.v.inPlace ? ' at ' + s.v.inPlace : ''}`,
        s.v.outAt ? `Out ${dayName(s.end)} ${clock(s.end)}${s.v.outPlace ? ' at ' + s.v.outPlace : ''}` : 'Not signed out yet',
        lengthOf(s.v.minutes), status === 'closed' ? `${signed(s.v.points)} points` : status === 'open' ? '' : 'No points'].filter(Boolean).join('\n');
      const pieces = [];
      for (let d = dayStart(s.start); d <= s.end; d = dayAfter(d)) {
        const c = cols.find(col => col.day === d);
        if (c) pieces.push({ c, from: Math.max(s.start, d), to: Math.min(s.end, dayAfter(d)), first: d === dayStart(s.start), last: dayAfter(d) > s.end });
      }
      let labelled = false;
      for (const p of pieces) {
        const x1 = xOf(p.from, p.c), x2 = Math.max(xOf(p.to, p.c), x1 + 7);
        const w = x2 - x1;
        out.push(`<g class="tl-visit ${status}"><title>${esc(tip)}</title>`
          + `<rect class="tl-bar" x="${x1}" y="${y}" width="${w}" height="${h}" rx="${p.first && p.last ? 7 : 3}"/>`
          + (!p.first ? `<path class="tl-more" d="M${x1 + 2} ${y + 6} l5 ${h / 2 - 6} l-5 ${h / 2 - 6}"/>` : '')
          + (!p.last ? `<path class="tl-more" d="M${x2 - 2} ${y + 6} l-5 ${h / 2 - 6} l5 ${h / 2 - 6}"/>` : '')
          + (!labelled && w >= 40 ? `<text class="tl-bartext" x="${x1 + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle">${esc(status === 'closed' ? (w >= 110 ? `${signed(s.v.points)} · ${lengthOf(s.v.minutes)}` : signed(s.v.points)) : status === 'open' ? 'inside' : status === 'discarded' ? 'cancelled' : 'too long')}</text>` : '')
          + '</g>');
        if (w >= 40) labelled = true;
      }
    }

    // grants, refunds and adjustments as dots, with their labels in up to three rows so they do not sit on each other
    const rowEnds = [[], [], []];
    for (const m of [...marks].sort((a, b) => a.at - b.at)) {
      const c = colAt(m.at);
      if (!c) continue;
      const x = xOf(m.at, c), label = signed(m.e.points);
      const reach = label.length * 7 + 8;
      let row = rowEnds.findIndex(r => !r.length || x - r[r.length - 1] >= reach);
      if (row < 0) row = 2;
      rowEnds[row].push(x);
      const kind = m.e.type === 'adjust' ? 'adjust' : m.e.points < 0 ? 'neg' : 'pos';
      const tip = [`${m.e.type === 'grant' ? 'Points given' : m.e.type === 'refund' ? 'Refund' : 'Adjustment'}: ${label}`, `${dayName(m.at)} ${clock(m.at)}`, m.e.place ? `At ${m.e.place}` : '', m.e.by && m.e.by !== m.e.place ? `By ${m.e.by}` : '', m.e.note || '', m.e.stornoed ? 'Reversed later' : ''].filter(Boolean).join('\n');
      out.push(`<g class="tl-mark ${kind}${m.e.stornoed ? ' undone' : ''}"><title>${esc(tip)}</title><line x1="${x}" x2="${x}" y1="${pointsTop + 10}" y2="${pointsTop + 22 + row * 16}"/>`
        + `<circle cx="${x}" cy="${pointsTop + 10}" r="5"/><text x="${x}" y="${pointsTop + 36 + row * 16}" text-anchor="middle">${esc(label)}</text></g>`);
    }
    // the present
    const nowCol = cols.find(c => nowMs >= c.from && nowMs <= c.to);
    if (nowCol) { const x = xOf(nowMs, nowCol); out.push(`<line class="tl-now" x1="${x}" x2="${x}" y1="${LAYOUT.header - 6}" y2="${height - 4}"/><text class="tl-nowtext" x="${x + 4}" y="${height - 8}">now</text>`); }

    const labels = zones.map((z, i) => `<div class="tl-lane" style="top:${laneTop(i)}px;height:${LAYOUT.lane}px" title="${esc(z)}"><span>${esc(z)}</span></div>`).join('')
      + `<div class="tl-lane points" style="top:${pointsTop}px;height:${LAYOUT.pointsLane - 14}px"><span>Points</span></div>`;
    const html = `<div class="tl"><div class="tl-labels" style="height:${height}px">${labels}</div>`
      + `<div class="tl-scroll"><svg class="tl-svg" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Timeline of this card">${out.join('')}</svg></div></div>`;
    return { html, width, days: cols.length, hiddenDays, lanes: zones, firstShown };
  }

  root.PontTimeline = { render };
})(typeof window !== 'undefined' ? window : globalThis);
