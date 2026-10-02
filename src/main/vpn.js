'use strict';

const https = require('https');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const config = require('./config');

// Monitors whether traffic is exiting through Mullvad. Emits:
//   'status' -> { connected: boolean, detail: string, source: 'http'|'cli'|'none' }
// Provides isConnected() and waitUntilConnected() so the download pipeline can
// gate work on a healthy VPN and auto-resume when it returns.
//
// Part 3 (Jellyfin build plan): the engine makes NO outside request unless
// Mullvad is confirmed up. start({ forced: true }) is used by --engine mode:
// there the requirement cannot be switched off from config.vpn.enabled.
//
// Fail closed: before the first check completes, connected is null and
// isConnected() is false, so a cold start never leaks traffic.
class VpnMonitor extends EventEmitter {
  constructor() {
    super();
    this.connected = null; // null = unknown until first check
    this.detail = '';
    this.source = 'none'; // which check produced the answer
    this.forced = false; // engine mode: VPN required, config cannot disable
    this.timer = null;
    this._waiters = [];
  }

  _enabled() {
    return this.forced || !!config.vpn.enabled;
  }

  start(opts = {}) {
    this.forced = !!opts.forced;
    if (!this._enabled()) {
      // Desktop app with the VPN check explicitly turned off by the user.
      this.connected = true;
      return;
    }
    if (this.timer) return;
    const tick = () => this._check().catch(() => {});
    tick();
    this.timer = setInterval(tick, config.vpn.pollIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isConnected() {
    return this.connected === true || !this._enabled();
  }

  // Resolves immediately if connected, otherwise once the VPN comes back.
  // Used at every network entry point (discovery, detection, watcher).
  waitUntilConnected() {
    if (this.isConnected()) return Promise.resolve();
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  // Snapshot for /api/health and the dashboard banner.
  status() {
    return {
      enabled: this._enabled(),
      forced: this.forced,
      connected: this.connected,
      detail: this.detail,
      source: this.source
    };
  }

  _setStatus(connected, detail, source) {
    const changed = this.connected !== connected;
    this.connected = connected;
    this.detail = detail || '';
    this.source = source || 'none';
    if (connected) {
      const waiters = this._waiters;
      this._waiters = [];
      waiters.forEach((fn) => fn());
    }
    if (changed) this.emit('status', { connected, detail: detail || '', source: this.source });
  }

  async _check() {
    const httpResult = await this._checkHttp();
    if (httpResult !== null) {
      this._setStatus(httpResult.connected, httpResult.detail, 'http');
      return;
    }
    // HTTP inconclusive (e.g. killswitch/lockdown blocking traffic) -> CLI.
    if (config.vpn.useCliFallback) {
      const cliResult = await this._checkCli();
      if (cliResult !== null) {
        this._setStatus(cliResult.connected, cliResult.detail, 'cli');
        return;
      }
    }
    // No traffic and no CLI signal: assume disconnected (safer to pause).
    this._setStatus(false, 'No response from VPN check', 'none');
  }

  _checkHttp() {
    return new Promise((resolve) => {
      const req = https.get(config.vpn.checkUrl, { timeout: config.vpn.requestTimeoutMs }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            const isMullvad = json.mullvad_exit_ip === true;
            resolve({
              connected: isMullvad,
              detail: isMullvad
                ? `Mullvad exit ${json.mullvad_exit_ip_hostname || ''} (${json.country || ''})`.trim()
                : 'Connected, but not through Mullvad'
            });
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null)); // network blocked -> inconclusive
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    });
  }

  _checkCli() {
    // Mullvad ships a CLI on both platforms: `mullvad status`.
    const bin = process.platform === 'win32' ? 'mullvad.exe' : 'mullvad';
    return new Promise((resolve) => {
      execFile(bin, ['status'], { timeout: config.vpn.requestTimeoutMs }, (err, stdout) => {
        if (err) return resolve(null); // CLI not installed or failed -> inconclusive
        const out = String(stdout || '');
        // Part 3 bugfix: test the NEGATIVE states first. The old code did
        // out.includes('connected'), and "disconnected" contains "connected",
        // so a dropped tunnel read as connected. With Lockdown on, the web
        // check is blocked exactly when this fallback runs - it had to be
        // right.
        if (/\b(disconnected|connecting|unavailable|blocked)\b/i.test(out)) {
          return resolve({ connected: false, detail: 'mullvad status: not connected' });
        }
        // `mullvad status` prints "State: Connected" (or a bare "Connected").
        if (/(?:^|\n)\s*(?:state:\s*)?connected\b/im.test(out)) {
          return resolve({ connected: true, detail: 'mullvad status: connected' });
        }
        resolve(null);
      });
    });
  }
}

module.exports = new VpnMonitor();
