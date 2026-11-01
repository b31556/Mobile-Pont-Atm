'use strict';
/* Fills in the download buttons from /downloads/apps.json (written when an app is published). Without it the buttons say so. */
(() => {
  const size = n => (n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  const apps = [['card', 'dl-card', 'meta-card', 'Pont Card'], ['terminal', 'dl-terminal', 'meta-terminal', 'Pont Terminal']];

  fetch('/downloads/apps.json', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : Promise.reject()))
    .catch(() => ({}))
    .then(list => {
      const sums = document.getElementById('sums');
      for (const [key, buttonId, metaId, label] of apps) {
        const info = list[key], button = document.getElementById(buttonId), meta = document.getElementById(metaId);
        if (!info || !info.file) {
          button.querySelector('span').textContent = 'Not available yet';
          meta.textContent = 'This app has not been published on this server yet.';
          continue;
        }
        button.href = '/downloads/' + encodeURIComponent(info.file);
        button.setAttribute('download', info.file);
        button.removeAttribute('aria-disabled');
        meta.textContent = ['Version ' + info.version, size(info.size), 'Android 8 or newer, with NFC'].filter(Boolean).join(' · ');
        if (info.sha256) {
          const row = document.createElement('div');
          row.append(Object.assign(document.createElement('b'), { textContent: label + ' ' + info.version }), Object.assign(document.createElement('code'), { textContent: info.sha256 }));
          sums.append(row);
        }
      }
      if (sums.children.length) document.getElementById('checks').hidden = false;
    });
})();
