'use strict';

/**
 * sources.js — lawful free-source adapter for Watch Together Sync.
 *
 * Searches and extracts watchable sources from UAE-reachable, yarrlist-class
 * WordPress sites (ramoflix.net, doraby.com) that expose the "fmovie" theme's
 * Servers blob. The adapter performs search -> detail -> embed -> (best-effort
 * direct stream) resolution. No torrents, no debrid, no API keys, no
 * unrestricted proxy. Anything the sites publish as an embed is treated as an
 * embed; direct stream resolution is attempted per-host with documented
 * patterns only, and any proxy access is allowlisted in server.js.
 */

const SOURCES = Object.freeze([
  {
    id: 'ramoflix',
    name: 'RamoFlix',
    domain: 'https://ramoflix.net',
  },
  {
    id: 'doraby',
    name: 'DoraBy',
    domain: 'https://doraby.com',
  },
]);

const EMBED_HOSTS = Object.freeze([
  'soap2night.cc',
  'player.videasy.net',
  'vidfast.pro',
  'vidfast.vc',
  'vidcore.net',
  'player.vidzee.wtf',
  '111movies.com',
]);

const UA =
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function hostnameOf(urlString) {
  try {
    return new URL(urlString).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Fetch with a short timeout, browser UA, optional Referer. */
async function fetchPage(url, { referer = '', timeoutMs = 12_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.7',
    };
    if (referer) headers.Referer = referer;
    const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
    const body = await response.text();
    return { status: response.status, ok: response.ok, body, finalUrl: response.url };
  } catch (error) {
    return { status: 0, ok: false, body: '', finalUrl: url, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Search a fmovie/WordPress site: /?s=QUERY -> list of post links + titles. */
async function searchSite(source, query) {
  const url = `${source.domain}/?s=${encodeURIComponent(query)}`;
  const { status, ok, body } = await fetchPage(url, { referer: source.domain + '/' });
  if (!ok || status !== 200) return [];
  const results = [];
  // Anchor tags whose href is a post permalink (site root + /slug/, not a
  // category/upload/query URL). The fmovie theme puts results in .items a.
  const anchorRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(body))) {
    const href = match[1];
    const rawTitle = cleanText(match[2].replace(/<[^>]+>/g, ''), 200);
    if (!rawTitle || !href) continue;
    const urlObj = (() => { try { return new URL(href, source.domain); } catch { return null; } })();
    if (!urlObj) continue;
    if (urlObj.hostname.replace(/^www\./, '') !== source.domain.replace(/^https?:\/\//, '').replace(/^www\./, '')) continue;
    if (/\/category\/|\/\?s=|\/wp-content\/|\/tag\/|\/request\/|\/years\/|#/.test(urlObj.pathname + urlObj.search)) continue;
    const slug = urlObj.pathname.replace(/\/+$/, '');
    // Skip obvious nav/taxonomy pages: single-segment slugs that are not a real
    // title match are usually theme pages (home, 2026, movies, tv-series…).
    const segments = slug.split('/').filter(Boolean);
    if (!slug || slug === '') continue;
    if (segments.length === 1 && /^(home|movies|tv-series|movie|series|years|genres|country|request|page|feed)$/i.test(segments[0])) continue;
    results.push({
      source: source.id,
      sourceName: source.name,
      title: rawTitle,
      url: urlObj.toString().replace(/\/+$/, ''),
    });
  }
  // dedupe by url
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    if (!seen.has(r.url)) { seen.add(r.url); unique.push(r); }
  }
  return unique.slice(0, 10);
}

/** Parse a fmovie detail page's Servers blob. */
function parseServers(body) {
  const m = body.match(/var Servers\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try {
    const raw = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
    const blob = JSON.parse(raw);
    const embedServers = [];
    const serverKeys = ['embedru', 'vidlink', 'superembed', 'vidsrc', 'vidsrc2', 'movieclub'];
    for (const key of serverKeys) {
      const value = blob[key];
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
        embedServers.push({ id: key, name: key, url: value });
      }
    }
    return {
      postId: String(blob.post_id ?? ''),
      tmdbId: String(blob.id ?? ''),
      imdbId: String(blob.imdb_id ?? ''),
      poster: (() => {
        try {
          const image = blob.image || '';
          if (image.startsWith('//')) return 'https:' + image;
          return image;
        } catch { return ''; }
      })(),
      voteAverage: blob.vote_average ?? '',
      domain: String(blob.domain ?? ''),
      embedServers,
    };
  } catch {
    return null;
  }
}

/** Fetch a movie detail page and return the parsed Servers blob. */
async function detailPage(url) {
  const referer = (() => { try { return new URL(url).origin + '/'; } catch { return ''; } })();
  const { ok, status, body } = await fetchPage(url, { referer });
  if (!ok || status !== 200) return { status, error: 'Detail page unavailable' };
  const parsed = parseServers(body);
  if (!parsed) return { status: 200, error: 'No playable servers found on this page' };
  // limit poster to https
  if (parsed.poster && !parsed.poster.startsWith('https://')) parsed.poster = '';
  return { status: 200, ...parsed };
}

/** Best-effort direct stream resolution for a single embed host. */
async function resolveEmbed(embed) {
  const host = hostnameOf(embed.url);
  const referer = (() => { try { const u = new URL(embed.url); return u.origin + '/'; } catch { return ''; } })();
  try {
    if (host === 'vidcore.net') {
      const r = await resolveVidcore(embed.url, referer);
      if (r) return r;
    } else if (host === 'vidfast.pro' || host === 'vidfast.vc') {
      const r = await resolveVidfast(embed.url, referer);
      if (r) return r;
    } else if (host === 'soap2night.cc' || host === 'player.videasy.net' || host === '111movies.com') {
      const r = await resolveGeneric(embed.url, referer);
      if (r) return r;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Scan HTML for a direct playable URL (m3u8 or mp4). */
function findDirectUrl(body) {
  const patterns = [
    /(https?:\\?\/\\?\/[^"'\s\\]+?\.m3u8[^"'\s\\]*)/i,
    /(https?:\\?\/\\?\/[^"'\s\\]+?\.mp4[^"'\s\\]*)/i,
    /(["'])(https?:\\?\/\\?\/[^"'\s]+?\.m3u8[^"'\s]*)\1/i,
    /(["'])(https?:\\?\/\\?\/[^"'\s]+?\.mp4[^"'\s]*)\1/i,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m) {
      const url = (m[1] || m[2] || '').replace(/\\\//g, '/').replace(/\\"/g, '"');
      if (/^https?:\/\//.test(url)) return url;
    }
  }
  return null;
}

async function resolveVidcore(embedUrl, referer) {
  // VidCore is a Next.js SPA; stream URLs are fetched client-side, so we
  // settle for a direct URL if it happens to be present in SSR/HTML.
  const { ok, body } = await fetchPage(embedUrl, { referer });
  if (!ok) return null;
  const direct = findDirectUrl(body);
  if (direct) return { type: 'direct', url: direct, referer };
  return null;
}

async function resolveVidfast(embedUrl, referer) {
  const { ok, body } = await fetchPage(embedUrl, { referer });
  if (!ok) return null;
  const direct = findDirectUrl(body);
  if (direct) return { type: 'direct', url: direct, referer };
  return null;
}

async function resolveGeneric(embedUrl, referer) {
  const { ok, body } = await fetchPage(embedUrl, { referer });
  if (!ok) return null;
  const direct = findDirectUrl(body);
  if (direct) return { type: 'direct', url: direct, referer };
  return null;
}

module.exports = {
  SOURCES,
  EMBED_HOSTS,
  searchSite,
  detailPage,
  resolveEmbed,
  hostnameOf,
  cleanText,
  allowedHosts() {
    const hosts = [...EMBED_HOSTS];
    for (const s of SOURCES) {
      try { hosts.push(new URL(s.domain).hostname.replace(/^www\./, '')); } catch { /* skip */ }
    }
    return hosts;
  },
};
