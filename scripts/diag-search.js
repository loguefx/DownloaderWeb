'use strict';

// Try to pass the movienow /play/ Turnstile challenge by clicking the
// checkbox programmatically, then dump the player.

const { app, BrowserWindow } = require('electron');

async function main() {
  const win = new BrowserWindow({
    show: true,
    width: 1000,
    height: 700,
    title: 'CF click test',
    webPreferences: { partition: 'persist:web', backgroundThrottling: false, sandbox: true }
  });
  const wc = win.webContents;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    const t = setTimeout(finish, 30000);
    wc.once('did-finish-load', () => {
      clearTimeout(t);
      finish();
    });
    wc.loadURL('https://movienow.online/shows/1739-1-5/according-to-jim/play/').catch((e) => {
      clearTimeout(t);
      finish();
    });
  });
  await new Promise((r) => setTimeout(r, 4000));

  // Attempt a real mouse click on the checkbox area. Turnstile renders a
  // checkbox in a child frame; click center-left where the box sits.
  const clickResult = await wc.executeJavaScript(
    `(() => {
      // If a visible turnstile checkbox exists in the top document, click it.
      const box = document.querySelector('input[type="checkbox"], .cf-turnstile, #challenge-stage, .turnstile');
      if (box) { try { box.click(); } catch (e) {} return 'clicked top-level: ' + box.tagName; }
      return 'no top-level checkbox';
    })()`,
    true
  );
  console.log('click:', clickResult);

  // Locate the Turnstile iframe's on-screen bounds and click the checkbox
  // (it sits ~30px from the left edge, vertically centered).
  let pt = null;
  try {
    pt = await wc.executeJavaScript(
      `(() => {
        const f = document.querySelector('iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"], .cf-turnstile');
        if (!f) return null;
        const r = f.getBoundingClientRect();
        return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) };
      })()`,
      true
    );
  } catch (e) {
    pt = null;
  }
  if (pt) {
    console.log('turnstile at', JSON.stringify(pt));
    try {
      wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
      await new Promise((r) => setTimeout(r, 300));
      wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      console.log('clicked checkbox');
    } catch (e) {
      console.log('click failed: ' + e.message);
    }
  } else {
    console.log('no turnstile iframe found in top document');
  }

  // Watch for clearance up to 45s.
  let passed = false;
  for (let i = 0; i < 9; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    let s;
    try {
      s = await wc.executeJavaScript(
        `(() => {
          const t = document.title || '';
          const body = ((document.body && document.body.innerText) || '').slice(0, 150).replace(/\\s+/g, ' ');
          return { challenge: /just a moment|performing security verification/i.test(t + ' ' + body), blocked: /sorry,? you/i.test(t + ' ' + body) };
        })()`,
        true
      );
    } catch (e) {
      continue;
    }
    console.log(`t+${(i + 1) * 5}s challenge=${s.challenge} blocked=${s.blocked}`);
    if (s.blocked) {
      console.log('HARD BLOCKED');
      break;
    }
    if (!s.challenge) {
      passed = true;
      break;
    }
  }
  if (passed) {
    await new Promise((r) => setTimeout(r, 5000));
    const info = await wc.executeJavaScript(
      `(() => {
        const iframes = Array.from(document.querySelectorAll('iframe')).map((f) => f.src);
        const vids = Array.from(document.querySelectorAll('video, source')).map((v) => v.tagName + ' ' + (v.src || v.currentSrc || ''));
        const html = (document.documentElement && document.documentElement.innerHTML) || '';
        const m3u8 = (html.match(/https?:[^"\\s]+\\.m3u8[^"\\s]*/g) || []).slice(0, 5);
        const mp4 = (html.match(/https?:[^"\\s]+\\.mp4[^"\\s]*/g) || []).slice(0, 5);
        return { title: document.title, iframes, vids, m3u8, mp4 };
      })()`,
      true
    );
    console.log('--- PASSED. title:', info.title);
    console.log('iframes:', JSON.stringify(info.iframes, null, 1));
    console.log('vids:', JSON.stringify(info.vids));
    console.log('m3u8:', JSON.stringify(info.m3u8));
    console.log('mp4:', JSON.stringify(info.mp4));
  } else {
    console.log('still challenged after clicks (needs a real human click)');
  }
  try {
    win.destroy();
  } catch (e) {
    // ignore
  }
  app.quit();
}

app.whenReady().then(() => {
  main().catch((e) => {
    console.error('crash', e);
    app.quit(1);
  });
});
setTimeout(() => {
  console.error('hard timeout');
  process.exit(2);
}, 240000);
