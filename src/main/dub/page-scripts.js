'use strict';

// Scripts injected into episode pages: the SUB/DUB server-row scan and the
// click helper (pure string builders). Moved out of dubselect.js unchanged.

// In-page scan. Finds the DUB and SUB toggles, then classifies each provider
// button (Vidplay/BYFMS/DGHG/...) into the DUB row or the SUB row by vertical
// proximity to each toggle. This is what prevents grabbing a SUB stream when we
// asked for DUB (the page shows both rows at once). Explicit CSS selectors from
// the site profile take priority, with heuristics as fallback.
function scanScript(opts) {
  return `(() => {
    const norm = (s) => (s || '').trim().toLowerCase();
    const dubLabels = ${JSON.stringify(opts.dubLabelText || [])};
    const subLabels = ${JSON.stringify(opts.subLabelText || [])};
    const known = ${JSON.stringify(opts.knownSourceLabels || [])};
    const dubSelector = ${JSON.stringify(opts.dubSelector || '')};
    const subSelector = ${JSON.stringify(opts.subSelector || '')};
    const sourceSelector = ${JSON.stringify(opts.sourceSelector || '')};

    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const text = (el) => norm(el.textContent).slice(0, 40);
    const matchesAny = (t, arr) => arr.some((w) => t === w || t.includes(w));
    const q = (sel) => { try { return Array.from(document.querySelectorAll(sel)); } catch (e) { return []; } };
    const top = (el) => el.getBoundingClientRect().top;
    const left = (el) => el.getBoundingClientRect().left;
    const clickable = Array.from(document.querySelectorAll('button, a, li, div, span, [role="button"], [onclick]'));

    // A row label is an element whose text - ignoring emoji/icons - is exactly
    // "sub"/"dub". This avoids matching a big container or a "Sub & Dub" filter
    // dropdown that merely contains the word.
    const isLabel = (el, labels) => {
      const t = text(el).replace(/[^a-z ]/g, '').replace(/\\s+/g, ' ').trim();
      return labels.some((w) => t === w);
    };
    // The SUB / DUB row labels can be ANY element (span, b, label, div...), not
    // just clickable ones, so search all elements for one whose own short text is
    // exactly "sub"/"dub" (icons/emoji stripped).
    const allEls = Array.from(document.querySelectorAll('*'));
    const labelsOf = (words) => allEls.filter((el) => isLabel(el, words) && visible(el) && !matchesAny(text(el), known));
    let dub = dubSelector ? q(dubSelector).find(visible) : labelsOf(dubLabels)[0];
    let sub = subSelector ? q(subSelector).find(visible) : labelsOf(subLabels)[0];

    // The audio a button belongs to, read from an explicit data-type="sub|dub"
    // on the button or an ancestor (HiAnime-style sites like enma.lol tag every
    // .server-item this way). This is authoritative when present - no geometry.
    const dataMode = (el) => {
      const h = el.closest ? el.closest('[data-type]') : null;
      const v = h ? norm(h.getAttribute('data-type')) : '';
      return v === 'sub' || v === 'dub' ? v : '';
    };

    // Provider/server candidates.
    let cands = [];
    if (sourceSelector) cands = q(sourceSelector).filter(visible);
    if (!cands.length) {
      cands = clickable.filter((el) => visible(el) && (
        matchesAny(text(el), known) || el.dataset.provider || el.dataset.server ||
        el.dataset.serverId || el.dataset.linkId || dataMode(el)
      ));
    }
    // Drop the toggles themselves and pure label chips.
    cands = cands.filter((el) => {
      const t = text(el);
      const isLabelOnly = (matchesAny(t, dubLabels) || matchesAny(t, subLabels)) && !matchesAny(t, known);
      return !isLabelOnly;
    });
    // Keep only the leaf-most candidates: drop any wrapper that contains another
    // candidate (e.g. the whole "sub/dub" block or a row container), which would
    // otherwise be misread as an extra source button.
    cands = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
    // A real provider button has short text (~one known label), not the
    // concatenated text of a container.
    cands = cands.filter((el) => text(el).replace(/\\s+/g, '').length <= 24);

    // Classify each candidate button by the SUB/DUB label whose ROW (vertical
    // center) is nearest. The page shows "SUB <servers>" and "DUB <servers>" as
    // two horizontal rows, so the closest label vertically is the right audio.
    const midY = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
    const subY = sub ? midY(sub) : null;
    const dubY = dub ? midY(dub) : null;
    let dubSources = [], subSources = [];
    for (const el of cands) {
      const y = midY(el);
      const dm = dataMode(el);
      let isSubRow;
      if (dm) isSubRow = dm === 'sub'; // explicit data-type wins over geometry
      else if (subY != null && dubY != null) isSubRow = Math.abs(y - subY) < Math.abs(y - dubY);
      else if (dubY != null) isSubRow = Math.abs(y - dubY) > 80; // far from the dub row -> sub
      else if (subY != null) isSubRow = Math.abs(y - subY) < 80; // near the sub row -> sub
      else isSubRow = false; // no labels found -> assume dub (we still try every button)
      (isSubRow ? subSources : dubSources).push(el);
    }

    // Sort row-by-row (top), then left-to-right. Dedup by text+row so the SAME
    // provider in TWO different rows (e.g. a sub-row Vidplay AND a dub-row Vidplay)
    // are BOTH kept and tried - only a genuinely duplicated element at the same
    // spot is dropped. This is what lets us fall through to servers 2 and 3 (and
    // the other row) when the first one is broken.
    const order = (arr) => arr.sort((a, b) => top(a) - top(b) || left(a) - left(b));
    const dedup = (arr) => {
      const seen = new Set();
      return arr.filter((el) => {
        const k = text(el) + '@' + Math.round(top(el) / 8);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };
    dubSources = dedup(order(dubSources));
    subSources = dedup(order(subSources));

    dubSources.forEach((el, i) => el.setAttribute('data-wvd-source', 'dub-' + i));
    subSources.forEach((el, i) => el.setAttribute('data-wvd-source', 'sub-' + i));
    if (dub) dub.setAttribute('data-wvd-toggle', 'dub');
    if (sub) sub.setAttribute('data-wvd-toggle', 'sub');

    return {
      hasDub: !!dub,
      hasSub: !!sub,
      dubSources: dubSources.map((el, i) => ({
        index: i,
        label: text(el),
        playerUrl: (el.getAttribute && el.getAttribute('data-player-url')) || ''
      })),
      subSources: subSources.map((el, i) => ({
        index: i,
        label: text(el),
        playerUrl: (el.getAttribute && el.getAttribute('data-player-url')) || ''
      }))
    };
  })()`;
}

function clickScript(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    el.click();
    const host = el.closest('[data-link-id]') || el;
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      linkId: (host.getAttribute && host.getAttribute('data-link-id')) || '',
      playerUrl: (el.getAttribute && el.getAttribute('data-player-url')) || ''
    };
  })()`;
}

module.exports = {
  scanScript,
  clickScript
};
