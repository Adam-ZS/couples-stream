/*
 * StreamFinder — paste into the browser console of a movie/embed page.
 *
 * Watches the page for real stream URLs (m3u8 / mp4 / ts) and captures the
 * network context around them: which fetch/XHR call produced the stream, the
 * request headers, and the JSON/API payloads that contained it. Then prints a
 * report you can copy and send back.
 *
 * HOW TO USE
 *   1. Open the movie page / embed player (vidcore, vidfast, vidzee, etc.)
 *   2. Copy the whole IIFE below into the DevTools console and press Enter
 *   3. If the video is not already playing, press play yourself (or leave
 *      AUTO_PLAY on — it tries)
 *   4. Wait ~10-30s. The console prints a SUMMARY table, then a JSON report
 *   5. Copy the JSON report (it is also copied to your clipboard) and send it
 *
 * SAFE / CONSENT NOTE
 *   Runs only in YOUR browser on the page YOU opened. It reads network URLs,
 *   never sends anything anywhere unless you set POST_ENDPOINT to your own
 *   server. It does not touch logins, cookies, or other tabs.
 */
(() => {
  'use strict';

  const CONFIG = {
    AUTO_PLAY: true,            // try to start the video automatically
    WATCH_MS: 120000,           // keep watching for this long (2 min default)
    POST_ENDPOINT: '',          // optional: POST the JSON report here
    EXTRACT_JSON_STREAMS: true, // parse API JSON bodies for embedded stream URLs
  };

  const MEDIA_RE = /\.(m3u8|mp4|ts)(\?|$)/i;
  const JSON_STREAM_RE = /https?:\\?\/\\?\/[^"'\\\s]+?\.(m3u8|mp4)([^"'\\\s]*)/gi;

  const pageUrl = location.href;
  const captured = new Map();   // streamUrl -> capture record
  const apiCalls = [];          // api url -> stream urls found in body
  const startedAt = Date.now();

  function stamp() {
    return new Date().toISOString();
  }

  function record(url, via, detail) {
    const clean = String(url).replace(/\\\//g, '/').replace(/\\"/g, '"');
    if (!MEDIA_RE.test(clean)) return;
    if (!captured.has(clean)) {
      captured.set(clean, {
        url: clean,
        via: via || 'unknown',
        firstSeen: stamp(),
        pageUrl,
        headers: detail && detail.headers ? detail.headers : null,
        context: detail && detail.context ? detail.context : null,
      });
    }
  }

  function extractFromJson(text, apiUrl) {
    const found = [];
    const re = new RegExp(JSON_STREAM_RE.source, 'gi');
    let m;
    while ((m = re.exec(text))) {
      const u = m[1].replace(/\\\//g, '/');
      if (MEDIA_RE.test(u) && !found.includes(u)) found.push(u);
    }
    if (found.length) {
      apiCalls.push({ url: apiUrl, streams: found, at: stamp() });
      found.forEach((u) => record(u, 'api-json:' + apiUrl));
    }
    return found;
  }

  /* ---- capture already-loaded resources ---- */
  function scanPerformance() {
    try {
      performance.getEntriesByType('resource').forEach((entry) => {
        record(entry.name, 'performance');
      });
    } catch { /* older browsers */ }
  }

  /* ---- hook fetch ---- */
  function hookFetch() {
    const orig = window.fetch;
    if (!orig || window.__streamFinderFetchHooked) return;
    window.__streamFinderFetchHooked = true;
    window.fetch = function (...args) {
      const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      const init = args[1] || {};
      const headers = init.headers || null;
      const p = orig.apply(this, args);
      if (reqUrl) {
        record(reqUrl, 'fetch-request', { headers });
        p.then((resp) => {
          const ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
          if (/m3u8|mpegurl|video|mp4/.test(ct)) record(reqUrl, 'fetch-response');
          if (CONFIG.EXTRACT_JSON_STREAMS && /json|text/.test(ct) && resp.clone) {
            resp.clone().text().then((body) => extractFromJson(body, reqUrl)).catch(() => {});
          }
        }).catch(() => {});
      }
      return p;
    };
  }

  /* ---- hook XHR ---- */
  function hookXhr() {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    if (window.__streamFinderXhrHooked) return;
    window.__streamFinderXhrHooked = true;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__sfUrl = url;
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      if (this.__sfUrl) record(this.__sfUrl, 'xhr-request');
      this.addEventListener('load', () => {
        if (!this.__sfUrl) return;
        const ct = (this.getResponseHeader && this.getResponseHeader('content-type')) || '';
        if (/m3u8|mpegurl|video|mp4/.test(ct)) record(this.__sfUrl, 'xhr-response');
        if (CONFIG.EXTRACT_JSON_STREAMS && /json|text/.test(ct)) {
          try { extractFromJson(this.responseText, this.__sfUrl); } catch { /* ignore */ }
        }
      });
      return origSend.apply(this, args);
    };
  }

  /* ---- watch video elements ---- */
  function scanVideos() {
    document.querySelectorAll('video, audio').forEach((v) => {
      if (v.currentSrc) record(v.currentSrc, 'video-element');
      v.querySelectorAll('source').forEach((s) => { if (s.src) record(s.src, 'source-element'); });
      if (CONFIG.AUTO_PLAY && v.paused && !v.__sfTried) {
        v.__sfTried = true;
        v.play().catch(() => {});
      }
    });
  }

  function clickPlayButtons() {
    if (!CONFIG.AUTO_PLAY) return;
    document.querySelectorAll('button, .play, [class*="play"]').forEach((b) => {
      const text = (b.innerText || b.getAttribute('aria-label') || '').toLowerCase();
      if (/play|watch|start/i.test(text) && !b.__sfClicked) {
        b.__sfClicked = true;
        try { b.click(); } catch { /* ignore */ }
      }
    });
  }

  /* ---- report ---- */
  function buildReport() {
    return {
      tool: 'stream-finder',
      generatedAt: stamp(),
      pageUrl,
      pageTitle: document.title,
      streams: Array.from(captured.values()),
      apiCalls,
      counts: {
        streams: captured.size,
        apiCalls: apiCalls.length,
      },
    };
  }

  function printReport() {
    const report = buildReport();
    console.log('==== StreamFinder SUMMARY ====');
    console.table(Array.from(captured.values()).map((c) => ({ via: c.via, url: c.url.slice(0, 110) })));
    console.log('==== StreamFinder JSON REPORT (copy this) ====');
    const json = JSON.stringify(report, null, 2);
    console.log(json);
    try {
      const copy = document.createElement('textarea');
      copy.value = json;
      document.body.appendChild(copy);
      copy.select();
      document.execCommand('copy');
      copy.remove();
      console.log('✅ Report copied to clipboard. Paste it in the chat.');
    } catch {
      console.log('⚠️ Clipboard copy failed — select the JSON above manually.');
    }
    if (CONFIG.POST_ENDPOINT) {
      fetch(CONFIG.POST_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
      }).then(() => console.log('✅ Report POSTed to', CONFIG.POST_ENDPOINT)).catch((e) => console.log('⚠️ POST failed:', e.message));
    }
    return json;
  }

  /* ---- main ---- */
  function main() {
    console.log('🚀 StreamFinder watching', pageUrl, '— press play if the video does not start.');
    scanPerformance();
    hookFetch();
    hookXhr();
    scanVideos();
    clickPlayButtons();
    const iv = setInterval(() => {
      scanVideos();
      clickPlayButtons();
      if (Date.now() - startedAt > CONFIG.WATCH_MS) {
        clearInterval(iv);
        printReport();
      }
    }, 2000);
    // First report attempt at 8s, then every 20s so the console stays fresh.
    let printed = false;
    const printIv = setInterval(() => {
      if (captured.size && !printed) { printed = true; printReport(); }
    }, 8000);
    setTimeout(() => { clearInterval(printIv); if (!printed) printReport(); }, CONFIG.WATCH_MS);
    window.__streamFinderStop = () => { clearInterval(iv); clearInterval(printIv); printReport(); };
    console.log('ℹ️  Stop early and print report: __streamFinderStop()');
  }

  main();
  return 'StreamFinder started — watch the console.';
})();