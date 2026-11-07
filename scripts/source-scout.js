#!/usr/bin/env node
'use strict';
/**
 * Which TMDB-id embed players answer from THIS PC / VPN right now?
 *
 *   node scripts/source-scout.js             test the candidates (read-only)
 *   node scripts/source-scout.js --install   also add the ones that look usable
 *                                            as engine sources (sites/*.json)
 *
 * Each candidate is asked for one TV episode (Breaking Bad S1E1) and one film
 * (Inception), the way the engine would. A page that answers 200, is not a
 * Cloudflare challenge and carries a player is "looks usable". Whether it
 * really yields a 1080p stream is only known once the engine downloads
 * through it - the engine keeps that score itself (Overview > Sources) and
 * moves a source that never delivers to the end of the line.
 *
 * The candidate list is unverified (gathered from public listings); sites
 * like these come and go.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TV = { tmdb: '1396', season: 1, episode: 1 };
const MOVIE = { tmdb: '27205' };

const CANDIDATES = [
  { id: 'vidlink', name: 'VidLink', tv: 'https://vidlink.pro/tv/{tmdb}/{season}/{episode}', movie: 'https://vidlink.pro/movie/{tmdb}' },
  { id: 'vidsrccc', name: 'Vidsrc.cc', tv: 'https://vidsrc.cc/v2/embed/tv/{tmdb}/{season}/{episode}', movie: 'https://vidsrc.cc/v2/embed/movie/{tmdb}' },
  { id: 'embedsu', name: 'Embed.su', tv: 'https://embed.su/embed/tv/{tmdb}/{season}/{episode}', movie: 'https://embed.su/embed/movie/{tmdb}' },
  { id: 'autoembed', name: 'AutoEmbed', tv: 'https://player.autoembed.cc/embed/tv/{tmdb}/{season}/{episode}', movie: 'https://player.autoembed.cc/embed/movie/{tmdb}' },
  { id: 'twoembed', name: '2Embed', tv: 'https://www.2embed.cc/embedtv/{tmdb}&s={season}&e={episode}', movie: 'https://www.2embed.cc/embed/{tmdb}' },
  { id: 'vidsrcsu', name: 'Vidsrc.su', tv: 'https://vidsrc.su/embed/tv/{tmdb}/{season}/{episode}', movie: 'https://vidsrc.su/embed/movie/{tmdb}' },
  { id: 'multiembed', name: 'MultiEmbed', tv: 'https://multiembed.mov/?video_id={tmdb}&tmdb=1&s={season}&e={episode}', movie: 'https://multiembed.mov/?video_id={tmdb}&tmdb=1' },
  { id: 'vidsrcrip', name: 'Vidsrc.rip', tv: 'https://vidsrc.rip/embed/tv/{tmdb}/{season}/{episode}', movie: 'https://vidsrc.rip/embed/movie/{tmdb}' },
  { id: 'moviesapi', name: 'MoviesAPI', tv: 'https://moviesapi.club/tv/{tmdb}-{season}-{episode}', movie: 'https://moviesapi.club/movie/{tmdb}' }
];

const fill = (tpl, r) => tpl.replace(/\{tmdb\}/g, r.tmdb).replace(/\{season\}/g, r.season).replace(/\{episode\}/g, r.episode);

function get(url, redirects = 4) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let mod;
    try { mod = new URL(url).protocol === 'http:' ? http : https; } catch (e) { return resolve({ error: 'bad url' }); }
    const req = mod.get(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return get(new URL(res.headers.location, url).href, redirects - 1).then((r) => resolve(Object.assign(r, { redirected: true })));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (d) => { if (size < 600000) { chunks.push(d); size += d.length; } });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - t0, url }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ error: e.code || e.message, ms: Date.now() - t0 }));
  });
}

function verdict(r) {
  if (r.error) return { ok: false, why: r.error };
  const body = r.body || '';
  const cf = /just a moment|cf-chl|challenge-platform|cf_chl_opt/i.test(body) || (r.status === 403 && /cloudflare/i.test(String(r.headers.server || '')));
  if (cf) return { ok: false, why: `Cloudflare check (HTTP ${r.status})` };
  if (r.status !== 200) return { ok: false, why: `HTTP ${r.status}` };
  const hints = [];
  if (/\.m3u8/i.test(body)) hints.push('m3u8');
  if (/<iframe/i.test(body)) hints.push('iframe');
  if (/jwplayer|hls\.js|Hls\(|videojs|plyr|artplayer|vidstack/i.test(body)) hints.push('player');
  if (/<video/i.test(body)) hints.push('video');
  if (/not found|no sources|unavailable/i.test(body.slice(0, 5000)) && !hints.length) return { ok: false, why: 'page says not found' };
  if (!hints.length && body.length < 800) return { ok: false, why: `tiny page (${body.length} bytes)` };
  return { ok: true, why: `${body.length} bytes${hints.length ? ', ' + hints.join('/') : ', no player markers (may build it with scripts)'}` };
}

function dataDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'webvideodownloader');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'webvideodownloader');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'webvideodownloader');
}

async function main() {
  const install = process.argv.includes('--install');
  console.log('Source scout: TMDB-id embed players, tested from this PC (Breaking Bad S1E1, Inception)\n');
  const usable = [];
  for (const c of CANDIDATES) {
    const [tv, mv] = await Promise.all([get(fill(c.tv, TV)), get(fill(c.movie, MOVIE))]);
    const vt = verdict(tv);
    const vm = verdict(mv);
    const ok = vt.ok && vm.ok;
    console.log(`${ok ? 'LOOKS USABLE' : 'no          '}  ${c.name.padEnd(11)}  TV: ${vt.ok ? 'ok' : 'NO'} (${vt.why}${tv.ms ? ', ' + tv.ms + ' ms' : ''})  ·  Movie: ${vm.ok ? 'ok' : 'NO'} (${vm.why})`);
    if (ok) usable.push(c);
  }
  console.log('');
  if (!usable.length) {
    console.log('None of the candidates looks usable from here right now.');
    return;
  }
  const dir = path.join(dataDir(), 'sites');
  if (!install) {
    console.log(`${usable.length} look usable. Run again with --install to add them as engine sources`);
    console.log(`(written to ${dir}; restart the engine afterwards; delete a file there to remove a source).`);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const c of usable) {
    const f = path.join(dir, `embed-${c.id}.json`);
    fs.writeFileSync(f, JSON.stringify({ id: `embed-${c.id}`, name: c.name, tmdbEmbed: { tv: c.tv, movie: c.movie } }, null, 2));
    console.log(`added ${c.name}: ${f}`);
  }
  console.log('\nRestart the engine. Overview > Sources shows how each one does in real searches.');
}

main().catch((e) => {
  console.error('Scout failed:', (e && e.stack) || e);
  process.exit(1);
});
