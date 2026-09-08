'use strict';

// Runs in the discovery player window's page world (contextIsolation: false)
// before site scripts, so HLS.js uses the wrapped fetch/XHR. Token CDNs only
// give us segment bytes through the player's own requests.

(function () {
  if (window.__wvdHooked) return;
  window.__wvdHooked = 'ok';
  window.__wvdParts = window.__wvdParts || {};
  window.__wvdSeen = window.__wvdSeen || [];

  const keep = (url, buf) => {
    if (!url || !/peakstorm|\/r6\/s\//i.test(String(url))) return;
    if (window.__wvdParts[url]) return;
    try {
      const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer || buf);
      if (!bytes.length) return;
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
    const origAB = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (data) {
      try {
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : data && data.buffer
              ? new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.length || 0)
              : null;
        if (bytes && bytes.length && window.__wvdMse.length < 4000) {
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

  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    return origFetch(input, init).then((res) => {
      if (/peakstorm|\/r6\/s\//i.test(url)) {
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
