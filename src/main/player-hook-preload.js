'use strict';

// Runs in the discovery player window's page world (contextIsolation: false)
// before site scripts, so HLS.js uses the wrapped fetch/XHR. Token CDNs only
// give us segment bytes through the player's own requests.

(function () {
  if (window.__wvdHooked) return;
  window.__wvdHooked = 'ok';
  window.__wvdParts = window.__wvdParts || {};
  window.__wvdSeen = window.__wvdSeen || [];

  try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
  } catch (e) {
    // ignore
  }

  const keep = (url, buf) => {
    if (url && window.__wvdSeen.length < 40) window.__wvdSeen.push(String(url).slice(0, 120));
    if (!url || !/peakstorm|ashencloud|ashenlion|orbitnorth|hiddenmesa|solidbear|primecomet|calmcanvas|nobleember|plainorbit|nobletrail|rapidtree|metaldisk|vidfast|thunderpencil|pearlmaple|novaoak|lightgrove|peakbadger|\/r6\/|\/r2\/|\/vd\//i.test(String(url))) return;
    if (window.__wvdParts[url]) return;
    try {
      const bytes =
        buf instanceof Uint8Array
          ? buf
          : buf instanceof ArrayBuffer
            ? new Uint8Array(buf)
            : buf && buf.buffer
              ? new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength || buf.length || 0)
              : null;
      if (!bytes || !bytes.length) return;
      let bin = '';
      const step = 0x4000;
      for (let i = 0; i < bytes.length; i += step) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
      }
      window.__wvdParts[url] = btoa(bin);
    } catch (e) {
      // ignore
    }
  };

  // MSE appends run on the window that owns <video>, even when HLS.js
  // fetches segments from a worker. This is how we get playable bytes
  // from token CDNs that 502 every extra request.
  try {
    window.__wvdMse = window.__wvdMse || [];
    window.__wvdMseHooked = 'ok';
    const origAB = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (data) {
      try {
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : data && data.buffer
              ? new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.length || 0)
              : null;
          if (bytes && bytes.length && window.__wvdMse.length < 20000) {
          let bin = '';
          const step = 0x4000;
          for (let i = 0; i < bytes.length; i += step) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
          }
          window.__wvdMse.push(btoa(bin));
        }
      } catch (e) {
        // never break playback
      }
      return origAB.apply(this, arguments);
    };
  } catch (e) {
    // ignore
  }

  try {
    const attachHls = (Hls) => {
      if (!Hls) return Hls;
        try {
          if (Hls.DefaultConfig) {
            Hls.DefaultConfig.enableWorker = false;
            Hls.DefaultConfig.maxBufferLength = 4000;
            Hls.DefaultConfig.maxMaxBufferLength = 8000;
            Hls.DefaultConfig.maxBufferSize = 500 * 1000 * 1000;
            Hls.DefaultConfig.capLevelToPlayerSize = false;
            Hls.DefaultConfig.abrEwmaDefaultEstimate = 20000000;
          }
        } catch (e) {
          // ignore
        }
        try {
          return new Proxy(Hls, {
            construct(target, args) {
              const cfg = Object.assign({}, args[0] || {}, {
                enableWorker: false,
                maxBufferLength: 4000,
                maxMaxBufferLength: 8000,
                maxBufferSize: 500 * 1000 * 1000,
                capLevelToPlayerSize: false,
                abrEwmaDefaultEstimate: 20000000
              });
            const inst = new target(cfg);
            try { window.__wvdHls = inst; } catch (e) {}
            try {
              const ev = (target.Events && target.Events.MANIFEST_PARSED) || 'hlsManifestParsed';
              if (inst && typeof inst.on === 'function') {
                inst.on(ev, () => {
                  const levels = inst.levels || [];
                  let best = 0;
                  for (let i = 1; i < levels.length; i++) {
                    const a = levels[i] || {};
                    const b = levels[best] || {};
                    if ((a.height || 0) > (b.height || 0) ||
                        ((a.height || 0) === (b.height || 0) && (a.bitrate || 0) > (b.bitrate || 0))) {
                      best = i;
                    }
                  }
                  try { inst.autoLevelCapping = -1; } catch (e) {}
                  try { inst.currentLevel = best; } catch (e) {}
                  try { inst.loadLevel = best; } catch (e) {}
                  try { inst.nextLevel = best; } catch (e) {}
                });
              }
            } catch (e) {}
            return inst;
            }
          });
      } catch (e) {
        return Hls;
      }
    };
    let currentHls;
    Object.defineProperty(window, 'Hls', {
      configurable: true,
      enumerable: true,
      get() {
        return currentHls;
      },
      set(v) {
        currentHls = attachHls(v);
      }
    });
  } catch (e) {
    // ignore
  }

  try {
    const bc = new BroadcastChannel('__wvdParts');
    bc.onmessage = (ev) => {
      const d = ev && ev.data;
      if (d && d.url && d.b64 && !window.__wvdParts[d.url]) window.__wvdParts[d.url] = d.b64;
    };
  } catch (e) {
    // ignore
  }

  try {
    const OrigWorker = window.Worker;
    window.__wvdWorkerSeen = window.__wvdWorkerSeen || [];
    window.Worker = function Worker(url, options) {
      const srcUrl = typeof url === 'string' ? url : String(url || '');
      const kind = (options && options.type) || 'classic';
      if (window.__wvdWorkerSeen.length < 12) {
        window.__wvdWorkerSeen.push(kind + ':' + srcUrl.slice(0, 80));
      }
      if (/hls|transmuxer|mpegts|^blob:/i.test(srcUrl)) {
        window.__wvdWorkerPatched = 'hls-passthrough';
      }
      return new OrigWorker(url, options);
    };
    window.Worker.prototype = OrigWorker.prototype;
    Object.setPrototypeOf(window.Worker, OrigWorker);
  } catch (e) {
    // ignore
  }

  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.getRegistrations().then((rs) => {
        rs.forEach((r) => r.unregister());
      }).catch(() => {});
    }
  } catch (e) {
    // ignore
  }

  try {
    const stripSpeculation = () => {
      try {
        document.querySelectorAll('script[type="speculationrules"]').forEach((s) => s.remove());
      } catch (e) {
        // ignore
      }
    };
    stripSpeculation();
    new MutationObserver(stripSpeculation).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  } catch (e) {
    // ignore
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    return origFetch(input, init).then((res) => {
      if (/peakstorm|ashencloud|ashenlion|orbitnorth|hiddenmesa|solidbear|primecomet|calmcanvas|nobleember|vidfast|\/r6\/|\/r2\/|\/vd\//i.test(url)) {
        res
          .clone()
          .arrayBuffer()
          .then((buf) => keep(url, buf))
          .catch(() => {});
      }
      return res;
    });
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__wvdUrl = url;
    return origOpen.apply(this, arguments);
  };

  const grab = (xhr) => {
    if (!xhr || xhr.readyState !== 4) return;
    if (xhr.status < 200 || xhr.status >= 300) return;
    try {
      const r = xhr.response;
      if (r == null) return;
      if (typeof r === 'string') {
        const bytes = new Uint8Array(r.length);
        for (let i = 0; i < r.length; i++) bytes[i] = r.charCodeAt(i) & 0xff;
        keep(xhr.__wvdUrl, bytes.buffer);
        return;
      }
      if (r instanceof ArrayBuffer) {
        keep(xhr.__wvdUrl, r);
        return;
      }
      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(r)) {
        keep(xhr.__wvdUrl, r.buffer);
        return;
      }
      if (typeof Blob !== 'undefined' && r instanceof Blob) {
        r.arrayBuffer()
          .then((b) => keep(xhr.__wvdUrl, b))
          .catch(() => {});
      }
    } catch (e) {
      // ignore
    }
  };

  const origAEL = XMLHttpRequest.prototype.addEventListener;
  XMLHttpRequest.prototype.addEventListener = function (type, listener, ...rest) {
    if (listener && (type === 'load' || type === 'readystatechange')) {
      const wrapped = function (...args) {
        try {
          grab(this);
        } catch (e) {
          // ignore
        }
        return listener.apply(this, args);
      };
      return origAEL.call(this, type, wrapped, ...rest);
    }
    return origAEL.call(this, type, listener, ...rest);
  };
})();
