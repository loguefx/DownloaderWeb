'use strict';

const $ = (sel) => document.querySelector(sel);
const view = $('#view');

let viewWcId = null; // webContents id of the embedded browser
let detected = new Map(); // url -> detection (for the current tab)
let outputFolder = '';
let pendingDetection = null; // detection chosen for single download

// ---------- init ----------
window.addEventListener('DOMContentLoaded', async () => {
  outputFolder = (await api.defaultDownloadDir()) || '';
  $('#name-folder').value = outputFolder;

  const vpn = await api.vpnStatus();
  setVpnBadge(vpn.connected);
});

// ---------- tab navigation ----------
function showPage(id) {
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + id));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.page === id));
}
document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => showPage(t.dataset.page);
});

// ---------- detected videos panel toggle (Browser page) ----------
const DETECTED_KEY = 'wvd-detected-hidden';
function applyDetected(hidden) {
  document.getElementById('app').classList.toggle('detected-hidden', hidden);
}
$('#btn-toggle-detected').onclick = () => {
  const hidden = !document.getElementById('app').classList.contains('detected-hidden');
  localStorage.setItem(DETECTED_KEY, hidden ? '1' : '0');
  applyDetected(hidden);
};
applyDetected(localStorage.getItem(DETECTED_KEY) === '1');

// ---------- embedded browser ----------
view.addEventListener('dom-ready', async () => {
  if (viewWcId == null) {
    viewWcId = view.getWebContentsId();
    refreshDetected();
  }
  $('#address').value = view.getURL();
});

view.addEventListener('did-navigate', (e) => {
  $('#address').value = e.url;
  if (viewWcId != null) api.snifferClear(viewWcId);
  detected.clear();
  renderDetected();
});
view.addEventListener('did-navigate-in-page', (e) => {
  if (e.isMainFrame) $('#address').value = e.url;
});

$('#btn-back').onclick = () => vpnOnline && view.canGoBack() && view.goBack();
$('#btn-forward').onclick = () => vpnOnline && view.canGoForward() && view.goForward();
$('#btn-reload').onclick = () => vpnOnline && view.reload();

$('#address-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!vpnOnline) return; // killswitch: no browsing while VPN is offline
  let url = $('#address').value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    url = /\./.test(url) && !url.includes(' ') ? 'https://' + url : 'https://www.google.com/search?q=' + encodeURIComponent(url);
  }
  view.loadURL(url);
});

// ---------- detected videos ----------
async function refreshDetected() {
  if (viewWcId == null) return;
  const list = await api.snifferList(viewWcId);
  detected = new Map(list.map((d) => [d.url, d]));
  renderDetected();
}

api.onDetected((d) => {
  if (d.webContentsId !== viewWcId) return; // ignore offscreen bulk windows
  detected.set(d.url, d);
  renderDetected();
});

$('#btn-clear-detected').onclick = () => {
  if (viewWcId != null) api.snifferClear(viewWcId);
  detected.clear();
  renderDetected();
};

// Quick bulk-download of the series on the current page: auto-fills the series
// name from the page, then a small popup lets you confirm/edit the name before
// it auto-detects and downloads ALL episodes. Both the toolbar "Bulk Download"
// button and the Detected-videos "Bulk download" button open this same popup.
let seriesBulkUrl = '';
function openSeriesModal() {
  if (!detected.size) {
    alert('Play a video first so a stream is detected, then click Bulk download.');
    return;
  }
  try {
    seriesBulkUrl = view.getURL();
  } catch (e) {
    seriesBulkUrl = $('#address').value || '';
  }
  // Show the popup immediately, then fill in the auto-detected name. (Reading the
  // title from the page can be slow, so we must not block opening the modal on it.)
  $('#series-season').value = parseSeasonClient(seriesBulkUrl);
  $('#series-mode').value = 'dub';
  $('#series-folder').value = outputFolder;
  // Instant best-guess from the URL slug, refined from the page title below.
  $('#series-name').value = seriesFromSlug(seriesBulkUrl) || guessTitle();
  $('#series-modal').classList.remove('hidden');
  $('#series-name').focus();
  $('#series-name').select();
  // Refine the name asynchronously (won't block / won't hang the popup).
  autoSeriesName(seriesBulkUrl)
    .then((name) => {
      if (name) {
        $('#series-name').value = name;
        $('#series-name').select();
      }
    })
    .catch(() => {});
}
$('#btn-bulk-detected').onclick = openSeriesModal;
$('#btn-bulk').onclick = openSeriesModal;

$('#series-close').onclick = $('#series-cancel').onclick = () => $('#series-modal').classList.add('hidden');
$('#series-choose-folder').onclick = async () => {
  const f = await api.chooseFolder();
  if (f) {
    $('#series-folder').value = f;
    outputFolder = f;
  }
};
$('#series-go').onclick = async () => {
  const series = $('#series-name').value.trim();
  const folder = $('#series-folder').value.trim() || outputFolder;
  if (!series) {
    alert('Enter a series name.');
    return;
  }
  if (!folder) {
    alert('Choose a download folder.');
    return;
  }
  const entry = {
    series,
    season: $('#series-season').value.trim(),
    baseUrl: seriesBulkUrl,
    startEp: '1',
    endEp: '', // blank = auto-detect all episodes
    mode: $('#series-mode').value
  };
  // Close the popup immediately - episode detection happens in the background and
  // can take a while, so we must NOT block the modal on bulkStart resolving.
  $('#series-modal').classList.add('hidden');
  showBanner(`Queued \u201c${series}\u201d \u2014 detecting episodes\u2026`, true);
  api.bulkStart({ entries: [entry], outputRoot: folder }).catch((e) => showBanner('Bulk start failed: ' + e.message, false));
};

// Schedule the current series: re-checked weekly so new episodes auto-download.
$('#series-schedule').onclick = async () => {
  const series = $('#series-name').value.trim();
  const folder = $('#series-folder').value.trim() || outputFolder;
  if (!series) {
    alert('Enter a series name.');
    return;
  }
  if (!folder) {
    alert('Choose a download folder.');
    return;
  }
  await api.scheduleAdd({
    series,
    season: $('#series-season').value.trim(),
    mode: $('#series-mode').value,
    baseUrl: seriesBulkUrl,
    outputRoot: folder
  });
  $('#series-modal').classList.add('hidden');
  showBanner(`Scheduled \u201c${series}\u201d \u2014 new episodes download automatically each week.`, true);
};

// Derives a clean series name. Prefers a real page title (og:title / h1), but
// falls back to the URL slug when the title is empty or just the site name
// (many of these sites set <title> to "Aniwave").
async function autoSeriesName(url) {
  let raw = '';
  try {
    const probe = view.executeJavaScript(`(function(){
      var m = document.querySelector('meta[property="og:title"]') || document.querySelector('meta[name="title"]');
      var og = m && m.content;
      var h = document.querySelector('h1');
      return (og || (h && h.textContent) || document.title || '').toString();
    })()`);
    // Never let a slow/unresponsive page block name detection.
    const timeout = new Promise((resolve) => setTimeout(() => resolve(''), 2500));
    raw = await Promise.race([probe, timeout]);
  } catch (e) {
    raw = '';
  }
  const fromTitle = cleanSeries(raw);
  const fromSlug = seriesFromSlug(url || seriesBulkUrl);
  if (fromTitle && !isSiteName(fromTitle) && fromTitle.length > 2) return fromTitle;
  return fromSlug || fromTitle;
}
function isSiteName(t) {
  return /^aniwaves?$/i.test(t.trim());
}
function cleanSeries(raw) {
  let t = (raw || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^aniwave\s*[-–—|:]\s*/i, ''); // drop site prefix
  t = t.replace(/^watch\s+/i, ''); // drop leading "Watch "
  // The series name comes before "Episode N" - cut it and any episode subtitle.
  t = t.replace(/\s+(episode|ep)\s*\d+.*$/i, '');
  // Cut at a separator that precedes a tagline / alternate title.
  t = t.split(/\s[–—|:-]\s/)[0];
  t = t.replace(/\(\s*\d{4}\s*\)/g, ''); // drop year like (2026)
  t = t.replace(/\b(english\s+)?(sub|dub)(bed)?\b.*$/i, ''); // drop "English Sub/Dub…"
  t = t.replace(/[\s\-–—|:]+$/g, ''); // strip any trailing separators/dashes
  return t.replace(/\s+/g, ' ').trim();
}
// Builds a series name from the /watch/<slug>/... URL, stripping the trailing
// numeric site id and any season marker, then title-casing.
function seriesFromSlug(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    let slug = '';
    const wi = parts.indexOf('watch');
    if (wi >= 0 && parts[wi + 1]) slug = parts[wi + 1];
    if (!slug) slug = parts.filter((p) => !/^(ep|episode)[-_]?\d+$/i.test(p)).pop() || '';
    return slugToName(slug);
  } catch (e) {
    return '';
  }
}
function slugToName(slug) {
  let s = (slug || '').toLowerCase();
  s = s.replace(/-\d+$/, ''); // trailing numeric site id (e.g. -82487)
  s = s.replace(/-\d+(st|nd|rd|th)?-season\b/g, ''); // "-4th-season"
  s = s.replace(/-season-\d+\b/g, ''); // "-season-4"
  s = s.replace(/-(part|cour)-?\d+\b/g, ''); // "-part-2"
  s = s.replace(/[-_]+/g, ' ').trim();
  return s.replace(/\b\w/g, (c) => c.toUpperCase()); // Title Case
}
function parseSeasonClient(url) {
  if (!url) return '';
  let m = url.match(/(\d+)(?:st|nd|rd|th)?[-_\s]*season/i);
  if (m) return m[1];
  m = url.match(/season[-_\s]*(\d+)/i);
  if (m) return m[1];
  return '';
}

function renderDetected() {
  const ul = $('#detected-list');
  const items = Array.from(detected.values())
    .filter((d) => ['hls', 'mp4', 'dash'].includes(d.type))
    .sort((a, b) => b.ts - a.ts);
  if (!items.length) {
    ul.innerHTML = '<li class="empty">Navigate to a video page; detected streams appear here.</li>';
    return;
  }
  ul.innerHTML = '';
  for (const d of items) {
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `
      <div class="row">
        <span class="badge ${d.type}">${d.type}</span>
        <button class="ghost-btn dl">Download</button>
      </div>
      <div class="meta">${escapeHtml(d.url)}</div>`;
    li.querySelector('.dl').onclick = () => openNameModal(d);
    ul.appendChild(li);
  }
}

// ---------- single download ----------
function openNameModal(detection) {
  pendingDetection = detection;
  let pageUrl = '';
  try {
    pageUrl = view.getURL() || $('#address').value || '';
  } catch (e) {
    pageUrl = $('#address').value || '';
  }
  // Show an immediate best-guess (from the URL slug), then upgrade to the real
  // English page title asynchronously - same logic the bulk popup uses, so it no
  // longer just says "Aniwave".
  $('#name-series').value = seriesFromSlug(pageUrl) || guessTitle();
  $('#name-season').value = parseSeasonClient(pageUrl);
  $('#name-episode').value = parseEpisodeClient(pageUrl);
  $('#name-folder').value = outputFolder;
  $('#name-modal').classList.remove('hidden');
  $('#name-series').focus();
  $('#name-series').select();
  autoSeriesName(pageUrl)
    .then((name) => {
      if (name && pendingDetection === detection && !$('#name-modal').classList.contains('hidden')) {
        $('#name-series').value = name;
        $('#name-series').select();
      }
    })
    .catch(() => {});
}
function parseEpisodeClient(url) {
  if (!url) return '';
  const m = url.match(/(?:ep|episode)[-_]?(\d+)/i);
  return m ? m[1] : '';
}
function guessTitle() {
  try {
    return (view.getTitle() || '').replace(/\s*[-|–].*$/, '').trim();
  } catch (e) {
    return '';
  }
}
$('#name-close').onclick = $('#name-cancel').onclick = () => $('#name-modal').classList.add('hidden');
$('#name-choose-folder').onclick = async () => {
  const f = await api.chooseFolder();
  if (f) $('#name-folder').value = f;
};
$('#name-go').onclick = async () => {
  if (!pendingDetection) return;
  const meta = {
    series: $('#name-series').value.trim() || 'Video',
    season: $('#name-season').value.trim(),
    episode: $('#name-episode').value.trim()
  };
  const folder = $('#name-folder').value.trim() || outputFolder;
  await api.downloadSingle({ detection: pendingDetection, meta, outputRoot: folder });
  pendingDetection = null;
  $('#name-modal').classList.add('hidden');
};

// ---------- queue ----------
$('#btn-pause').onclick = () => api.queuePause();
$('#btn-resume').onclick = () => api.queueResume();
$('#btn-stop').onclick = () => api.queueStop();
$('#btn-clear-queue').onclick = () => {
  if (confirm('Remove ALL items from the download queue? In-progress downloads will be cancelled.')) {
    api.queueClear();
  }
};

api.onQueueUpdate(renderQueue);
api.queueSnapshot().then(renderQueue);

// True whenever something is queued/downloading - drives the "Queue ..." labels.
let queueActive = false;
const ACTIVE_STATUSES = ['queued', 'resolving', 'downloading', 'verifying', 'paused'];

function updateBulkLabels() {
  const b1 = $('#btn-bulk-detected');
  if (b1) b1.textContent = queueActive ? 'Queue bulk download' : 'Bulk download';
  const b2 = $('#series-go');
  if (b2) b2.textContent = queueActive ? 'Queue all episodes' : 'Download all episodes';
  const b3 = $('#btn-bulk');
  if (b3) b3.textContent = queueActive ? 'Queue Download' : 'Bulk Download';
}

// Shows a live count of in-flight episodes on the Download Queue tab.
function updateQueueTabBadge(items) {
  const badge = $('#tab-queue-count');
  if (!badge) return;
  const active = (items || []).filter((it) => ACTIVE_STATUSES.includes(it.status)).length;
  badge.textContent = String(active);
  badge.classList.toggle('hidden', active === 0);
}

function renderQueue(items) {
  const ul = $('#queue-list');
  queueActive = (items || []).some((it) => ACTIVE_STATUSES.includes(it.status));
  updateBulkLabels();
  updateQueueTabBadge(items);

  if (!items || !items.length) {
    ul.innerHTML = '<li class="empty">No downloads yet.</li>';
    return;
  }

  // Group episodes by their series-batch so each series is one tidy block.
  const groups = new Map();
  for (const it of items) {
    const g = it.group || 'single:' + it.id;
    if (!groups.has(g)) {
      groups.set(g, { series: it.series || it.label || 'Download', season: it.season, mode: it.mode, items: [] });
    }
    groups.get(g).items.push(it);
  }

  ul.innerHTML = '';
  let rendered = 0;
  for (const grp of groups.values()) {
    const total = grp.items.length;
    const done = grp.items.filter((i) => i.status === 'done').length;
    const active = grp.items.some((i) => ['downloading', 'resolving', 'verifying'].includes(i.status));
    const title = grp.series + (grp.season ? ` \u00b7 S${grp.season}` : '') + (grp.mode === 'sub' ? ' \u00b7 SUB' : '');

    // Only show episodes still in progress; hide completed/cancelled ones. When a
    // whole series is finished, every episode is hidden and the box disappears.
    const visible = grp.items.filter((i) => i.status !== 'done' && i.status !== 'cancelled');
    if (!visible.length) continue;

    let rows = '';
    for (const it of visible) {
      const pct = it.progress != null ? Math.round(it.progress * 100) : null;
      const indeterminate = (it.status === 'downloading' || it.status === 'resolving') && pct == null;
      const epName = it.episode != null ? `Episode ${it.episode}` : escapeHtml(it.label || 'Download');
      rows += `
        <div class="ep">
          <div class="ep-row">
            <span class="ep-name">${epName}</span>
            <span class="status ${it.status}">${it.status}${pct != null ? ' ' + pct + '%' : ''}</span>
          </div>
          ${it.error ? `<div class="meta">${escapeHtml(it.error)}</div>` : ''}
          <div class="progress ${indeterminate ? 'indeterminate' : ''}"><i style="width:${pct != null ? pct : 0}%"></i></div>
        </div>`;
    }

    const ids = grp.items.map((i) => i.id);
    const li = document.createElement('li');
    li.className = 'item group' + (active ? ' active' : '');
    li.innerHTML = `
      <div class="group-head">
        <span class="title">${escapeHtml(title)}</span>
        <span class="group-right">
          <span class="count">${done}/${total}</span>
          <button class="ghost-btn tiny danger rm-group">Remove</button>
        </span>
      </div>
      <div class="eps">${rows}</div>`;
    li.querySelector('.rm-group').onclick = () => api.queueRemove(ids);
    ul.appendChild(li);
    rendered += 1;
  }

  if (!rendered) ul.innerHTML = '<li class="empty">No active downloads.</li>';
}

// ---------- vpn (status + browser killswitch) ----------
let vpnOnline = false;
api.onVpnStatus((s) => setVpnBadge(s.connected));
function setVpnBadge(connected) {
  vpnOnline = !!connected;
  const badge = $('#vpn-badge');
  const text = $('#vpn-text');
  badge.classList.remove('up', 'down', 'unknown');
  if (connected) {
    badge.classList.add('up');
    text.textContent = 'Mullvad: Online';
  } else {
    badge.classList.add('down');
    text.textContent = 'Mullvad: Offline';
  }
  applyVpnGate();
}
// Block the browser whenever Mullvad is offline.
function applyVpnGate() {
  const overlay = $('#vpn-overlay');
  if (!overlay) return;
  overlay.classList.toggle('hidden', vpnOnline);
}

// ---------- logs & banner ----------
api.onQueueLog(({ ts, msg }) => {
  const log = $('#log');
  const line = document.createElement('div');
  line.className = 'line';
  line.innerHTML = `<span class="t">${new Date(ts).toLocaleTimeString()}</span>${escapeHtml(msg)}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  while (log.childNodes.length > 500) log.removeChild(log.firstChild);
});

api.onQueueStopped(({ reason, item }) => {
  showBanner(`Stopped: ${reason}${item ? ' (at "' + item + '")' : ''}`, false);
});

let bannerTimer = null;
function showBanner(text, ok) {
  const b = $('#banner');
  b.textContent = text;
  b.classList.toggle('ok', !!ok);
  b.classList.remove('hidden');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.add('hidden'), 8000);
}

// ---------- scheduled series (auto-grab new episodes weekly) ----------
$('#btn-check-schedules').onclick = () => api.scheduleCheck();
api.onScheduleUpdate(renderSchedule);
api.scheduleList().then(renderSchedule);

function renderSchedule(items) {
  const ul = $('#schedule-list');
  if (!items || !items.length) {
    ul.innerHTML = '<li class="empty">Use \u201cSchedule\u201d on a series to auto-grab new episodes each week.</li>';
    return;
  }
  ul.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'item';
    const checked = it.lastChecked ? new Date(it.lastChecked).toLocaleString() : 'not yet';
    const title = (it.series || 'Series') + (it.season ? ` \u00b7 S${it.season}` : '') + (it.mode === 'sub' ? ' \u00b7 SUB' : '');
    li.innerHTML = `
      <div class="row">
        <span class="title">${escapeHtml(title)}</span>
        <button class="ghost-btn tiny rm">Remove</button>
      </div>
      <div class="meta">Last checked: ${escapeHtml(checked)}</div>`;
    li.querySelector('.rm').onclick = () => api.scheduleRemove(it.key);
    ul.appendChild(li);
  }
}

// ---------- activity log controls ----------
$('#btn-clear-log').onclick = () => {
  $('#log').innerHTML = '';
};

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
