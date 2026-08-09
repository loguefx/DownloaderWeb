'use strict';

// Site adapter for FilmeHD (filmehd.to) — Romanian movies & TV with RO subs.
//
// Series season page:
//   https://filmehd.to/seriale/{slug}-sezonul-{season}/
//   e.g. https://filmehd.to/seriale/dark-sezonul-2/
//
// Episodes are numbered buttons under each SERVER row on the SAME page
// (Vidmoly / Vidsrc / Doodstream). There is no /ep-N path — we tokenize the
// season URL as `...#ep-{episode}` and click that number before resolving.
//
// This site is not anime-style SUB/DUB; audio is usually original language with
// Romanian subtitles. All server buttons are treated as one source list.

module.exports = {
  id: 'filmehd',
  name: 'FilmeHD (filmehd.to)',
  match: [/filmehd\.to/i, /\bfilmehd\b/i],

  dub: {
    // No SUB/DUB rows — keep labels empty so the scanner does not invent them.
    dubLabelText: [],
    subLabelText: [],
    knownSourceLabels: [
      'vidmoly',
      'vidsrc',
      'doodstream',
      'dood',
      'server 1',
      'server 2',
      'server 3',
      'server1',
      'server2',
      'server3',
      'filemoon',
      'streamtape',
      'mp4upload'
    ],
    sourceWaitMs: 14000,
    pageSettleMs: 3000
  },

  urlTemplates: ['https://filmehd.to/seriale/{slug}-sezonul-{season}/#ep-{episode}'],

  // In-page episode numbers under SERVER / Vidmoly / Vidsrc / Dood rows.
  episodeScan: `(() => {
    const nums = new Set();
    const add = (v) => {
      const n = parseInt(v, 10);
      if (n > 0 && n < 500) nums.add(n);
    };
    const nearServer = (el) => {
      let node = el;
      for (let i = 0; i < 6 && node; i++) {
        const t = ((node.textContent || '') + ' ' + (node.className || '')).toLowerCase();
        if (/server\\s*\\d|vidmoly|vidsrc|doodstream|\\bdood\\b/.test(t)) return true;
        node = node.parentElement;
      }
      return false;
    };
    document.querySelectorAll('a, button, li, span, div').forEach((el) => {
      const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!/^\\d{1,3}$/.test(t)) return;
      if (!nearServer(el)) return;
      // Prefer leaf-ish nodes (avoid a huge container whose text starts with "1").
      if (el.children && el.children.length > 3) return;
      add(t);
    });
    document.querySelectorAll('a[href*="episod"], a[href*="episode"], a[href*="1x"], a[href*="2x"], a[href*="3x"]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      const m = href.match(/(?:episod(?:ul)?|episode|e)[-_]?(\\d+)/i) || href.match(/(\\d+)x(\\d+)/i);
      if (m) add(m[2] || m[1]);
    });
    const list = Array.from(nums).sort((a, b) => a - b);
    return { list, max: list.length ? list[list.length - 1] : 0, aired: list.length, total: list.length };
  })()`,

  // Click the in-page episode number before source sniffing.
  async beforeResolve(wc, { episode, onLog }) {
    const ep = parseInt(episode, 10);
    if (!ep) return;
    const result = await wc
      .executeJavaScript(
        `(() => {
          const ep = ${JSON.stringify(String(ep))};
          const ep2 = ep.length < 2 ? ('0' + ep) : ep;
          const nearServer = (el) => {
            let node = el;
            for (let i = 0; i < 6 && node; i++) {
              const t = ((node.textContent || '') + ' ' + (node.className || '')).toLowerCase();
              if (/server\\s*\\d|vidmoly|vidsrc|doodstream|\\bdood\\b/.test(t)) return true;
              node = node.parentElement;
            }
            return false;
          };
          const cands = Array.from(document.querySelectorAll('a, button, li, span, div')).filter((el) => {
            const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (t !== ep && t !== ep2) return false;
            if (el.children && el.children.length > 3) return false;
            return nearServer(el);
          });
          // Prefer the first server row (usually Vidmoly) — top-most match.
          cands.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top ||
            a.getBoundingClientRect().left - b.getBoundingClientRect().left);
          const el = cands[0];
          if (!el) return { ok: false, count: 0 };
          el.scrollIntoView({ block: 'center' });
          el.click();
          return { ok: true, count: cands.length, label: (el.textContent || '').trim() };
        })()`,
        true
      )
      .catch(() => null);

    if (result && result.ok) {
      onLog(`FilmeHD: selected episode ${ep} on page (${result.count} match(es)).`);
      await new Promise((r) => setTimeout(r, 1200));
    } else {
      onLog(`FilmeHD: could not find in-page button for episode ${ep}; trying default player.`);
    }
  }
};
