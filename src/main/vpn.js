'use strict';

const https = require('https');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const config = require('./config');

// Monitors whether traffic is exiting through Mullvad. Emits:
//   'status' -> { connected: boolean, detail: string }
// Provides isConnected() and waitUntilConnected() so the download pipeline can
// gate work on a healthy VPN and auto-resume when it returns.
class VpnMonitor extends EventEmitter {
  constructor() {
    super();
    this.connected = null; // null = unknown until first check
    this.timer = null;
    this._waiters = [];
  }

  start() {
    if (!config.vpn.enabled) {
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
    return this.connected === true || !config.vpn.enabled;
  }

  // Resolves immediately if connected, otherwise once the VPN comes back.
  waitUntilConnected() {
    if (this.isConnected()) return Promise.resolve();
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  _setStatus(connected, detail) {
    const changed = this.connected !== connected;
    this.connected = connected;
    if (connected) {
      const waiters = this._waiters;
      this._waiters = [];
      waiters.forEach((fn) => fn());
    }
    if (changed) this.emit('status', { connected, detail: detail || '' });
  }

  async _check() {
    const httpResult = await this._checkHttp();
    if (httpResult !== null) {
      this._setStatus(httpResult.connected, httpResult.detail);
      return;
    }
    // HTTP inconclusive (e.g. killswitch blocking traffic) -> try CLI.
    if (config.vpn.useCliFallback) {
      const cliResult = await this._checkCli();
      if (cliResult !== null) {
        this._setStatus(cliResult.connected, cliResult.detail);
        return;
      }
    }
    // No traffic and no CLI signal: assume disconnected (safer to pause).
    this._setStatus(false, 'No response from VPN check');
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
    return new Promise((resolve) => {
      execFile('mullvad', ['status'], { timeout: config.vpn.requestTimeoutMs }, (err, stdout) => {
        if (err && err.code === 'ENOENT') return resolve(null); // CLI not installed
        if (err) return resolve(null);
        const out = String(stdout || '').toLowerCase();
        if (out.includes('connected')) return resolve({ connected: true, detail: 'mullvad status: connected' });
        if (out.includes('disconnected') || out.includes('connecting')) {
          return resolve({ connected: false, detail: 'mullvad status: not connected' });
        }
        resolve(null);
      });
    });
  }
}

module.exports = new VpnMonitor();
