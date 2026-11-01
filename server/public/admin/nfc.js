'use strict';
/* Pure helpers for scanning a card in the Pont Admin app (the Android app hands the page a UID; see admin.js). */
(function (root) {
  /** The canonical form the server stores: upper case hex bytes joined by colons. Null unless it is 4, 7 or 10 bytes. */
  function normalizeUid(raw) {
    const hex = String(raw ?? '').replace(/[\s:-]/g, '').toUpperCase();
    if (!/^[0-9A-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
    const bytes = hex.match(/../g) || [];
    return [4, 7, 10].includes(bytes.length) ? bytes.join(':') : null;
  }

  /** The card of [cards] that has this UID, or null. Compares canonical forms, so spelling does not matter. */
  function findByUid(cards, uid) {
    const want = normalizeUid(uid);
    if (!want) return null;
    return (cards || []).find(c => normalizeUid(c.uid) === want) || null;
  }

  root.PontNfc = { normalizeUid, findByUid };
})(typeof window !== 'undefined' ? window : globalThis);
