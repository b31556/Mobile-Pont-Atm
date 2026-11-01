'use strict';
/* Reads the pasted card list of the import page, and matches the photo names in it to the chosen picture files. */
(function (root) {
  /** Lower case, accents removed, only letters and digits: "Név", "photo file" and "Photo_File" all compare alike. */
  const key = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

  const COLUMNS = {
    name: ['name', 'holder', 'holdername', 'fullname', 'cardholder', 'person', 'member', 'nev', 'tulajdonos'],
    uid: ['uid', 'carduid', 'cardid', 'card', 'rfid', 'nfc', 'tag', 'kartya', 'kartyaid', 'kartyaszam'],
    points: ['points', 'point', 'balance', 'startingpoints', 'startpoints', 'pont', 'pontok', 'egyenleg'],
    photo: ['photo', 'pfp', 'picture', 'image', 'avatar', 'photofile', 'photofilename', 'pfpfile', 'pfpfilename', 'picturefile', 'imagefile', 'file', 'filename', 'kep', 'fenykep'],
  };
  const columnOf = cell => Object.keys(COLUMNS).find(c => COLUMNS[c].includes(key(cell))) ?? null;
  const looksLikeUid = cell => /^[0-9a-f]{2}([\s:-]?[0-9a-f]{2}){3,9}$/i.test(String(cell).trim());

  /** Tab if there is one on the first line, else whichever of ; and , the first line has more of (outside quotes). */
  function detectDelimiter(text) {
    const first = text.split(/\r\n|\r|\n/).find(l => l.trim()) ?? '';
    const counts = { '\t': 0, ';': 0, ',': 0 };
    let quoted = false;
    for (const ch of first) { if (ch === '"') quoted = !quoted; else if (!quoted && ch in counts) counts[ch]++; }
    if (counts['\t'] > 0) return '\t';
    return counts[';'] > counts[','] ? ';' : ',';
  }

  /** Splits into records of cells; a quoted cell may hold the separator, line breaks and "" for a quote. Each record knows its first line. */
  function records(text, delimiter) {
    const out = [];
    let cells = [], cell = '', quoted = false, line = 1, recordLine = 1, touched = false;
    const endCell = () => { cells.push(cell); cell = ''; };
    const endRecord = () => { endCell(); if (cells.some(c => c.trim() !== '')) out.push({ line: recordLine, cells }); cells = []; touched = false; };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
        else { if (ch === '\n') line++; cell += ch; }
      } else if (ch === '"' && cell === '') { quoted = true; touched = true; }
      else if (ch === delimiter) { endCell(); touched = true; }
      else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        endRecord(); line++; recordLine = line;
      } else { cell += ch; touched = true; }
    }
    if (touched || cell !== '' || cells.length) endRecord();
    return out;
  }

  /** The file name of what was written in the photo column: "photos/anna.jpg" and "C:\pics\anna.jpg" both give "anna.jpg". */
  const baseName = s => String(s ?? '').trim().replace(/^"+|"+$/g, '').split(/[\\/]/).pop().trim();

  /**
   * Reads the list. The first row may name the columns (name, uid, points, photo, in any order, English or Hungarian);
   * without one the columns are taken in that order. Points and photo may be left out.
   * Returns { ok: true, rows: [{ line, name, uid, points, photo }], header, delimiter } or { ok: false, error }.
   */
  function parse(input) {
    const text = String(input ?? '').replace(/^\uFEFF/, '');
    if (!text.trim()) return { ok: false, error: 'Paste the list of cards first' };
    const delimiter = detectDelimiter(text);
    const recs = records(text, delimiter);
    if (!recs.length) return { ok: false, error: 'Paste the list of cards first' };

    let map = { name: 0, uid: 1, points: 2, photo: 3 }, header = false, start = 0;
    const known = recs[0].cells.map(columnOf);
    const recognised = known.filter(Boolean).length;
    if (recognised >= 2 || (recognised === 1 && !recs[0].cells.some(looksLikeUid))) {
      header = true; start = 1; map = {};
      known.forEach((c, i) => { if (c && !(c in map)) map[c] = i; });
      if (!('name' in map)) return { ok: false, error: 'The first row has no “name” column' };
      if (!('uid' in map)) return { ok: false, error: 'The first row has no “uid” column' };
    }
    const at = (cells, c) => (c in map && map[c] < cells.length ? cells[map[c]].trim() : '');
    const rows = recs.slice(start).map(r => {
      const rawPoints = at(r.cells, 'points');
      // A whole number becomes a number; anything else is passed on as text so the server can say it is wrong.
      const points = rawPoints === '' ? undefined : /^\d+$/.test(rawPoints) ? Number(rawPoints) : rawPoints;
      return { line: r.line, name: at(r.cells, 'name'), uid: at(r.cells, 'uid'), points, photo: baseName(at(r.cells, 'photo')) };
    });
    if (!rows.length) return { ok: false, error: 'The list has a header but no cards' };
    return { ok: true, rows, header, delimiter };
  }

  /**
   * Finds the chosen picture for a photo name from the list. The name must match the file name (ignoring capitals and any
   * folder); a name without an extension ("anna") also finds "anna.jpg" when only one file has that name.
   * [files] is a list of file names. Returns { index } for the file, { none: true } when the row names no photo,
   * or { error } when the name matches no file or several.
   */
  function matchPhoto(photo, files) {
    const wanted = baseName(photo).toLowerCase();
    if (!wanted) return { none: true };
    const names = files.map(f => baseName(f).toLowerCase());
    const exact = names.flatMap((n, i) => (n === wanted ? [i] : []));
    if (exact.length === 1) return { index: exact[0] };
    if (exact.length > 1) return { error: `Several chosen files are called ${photo}` };
    if (!/\.[a-z0-9]{2,5}$/.test(wanted)) {
      const stem = names.flatMap((n, i) => (n.replace(/\.[a-z0-9]{2,5}$/, '') === wanted ? [i] : []));
      if (stem.length === 1) return { index: stem[0] };
      if (stem.length > 1) return { error: `Several chosen files start with ${photo}: write the whole file name` };
    }
    return { error: `No chosen file is called ${photo}` };
  }

  root.PontCsv = { parse, matchPhoto, baseName };
})(typeof window !== 'undefined' ? window : globalThis);
