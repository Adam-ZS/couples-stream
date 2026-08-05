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
  'player.vidlove.cc',
  'ballerinacappuccinalovestungtungtungsahur.com',
  'c.ballerinacappuccinalovestungtungtungsahur.com',
  'cache.vdrk.site',
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

/**
 * Resolve a title via the vidlove/ballerina API (111movies / vidlove embeds).
 *
 * The ballerina /movie endpoint returns a signed stream URL plus quality
 * variants, and /subtitles/movie/{id} returns VTT tracks. Both respond to a
 * plain fetch when the request carries browser-like headers (the site's API
 * gateway accepts standard Sec-Fetch headers; no cookies or tokens required
 * for the JSON endpoints themselves).
 */
const BALLERINA_BASE = 'https://ballerinacappuccinalovestungtungtungsahur.com';
const VIDLOVE_REFERER = 'https://player.vidlove.cc/';

function browserHeaders(referer) {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: referer || VIDLOVE_REFERER,
    Origin: referer ? (() => { try { return new URL(referer).origin; } catch { return 'https://player.vidlove.cc'; } })() : 'https://player.vidlove.cc',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
  };
}

async function ballerinaJson(path, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(BALLERINA_BASE + path, {
      headers: browserHeaders(referer),
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a vidlove-style embed (111movies.com/movie/ttXXXX, player.vidlove.cc)
 * into a direct MP4 stream + subtitle tracks.
 *
 * @param {string} tmdbId TMDB movie id (from the fmovie Servers blob)
 * @param {string} [imdbId] optional IMDb id (used as fallback title check)
 * @returns {Promise<object|null>} { streamUrl, qualities, subtitles, referer }
 */
async function resolveVidlove(tmdbId, imdbId = '') {
  if (!tmdbId) return null;
  // Try each backend in order — not every title exists on every source.
  for (const backend of ['moviebox', 'vidapi', 'ipcloud']) {
    const movie = await ballerinaJson(`/movie?id=${encodeURIComponent(tmdbId)}&mode=json&sources=${backend}`, VIDLOVE_REFERER);
    if (!movie || !movie.source || !movie.source.url) continue;
    const subtitles = await ballerinaJson(`/subtitles/movie/${encodeURIComponent(tmdbId)}`, VIDLOVE_REFERER);
    return {
      type: 'direct',
      label: String(movie.source.label || 'MovieBox'),
      url: movie.source.url,
      qualities: Array.isArray(movie.source.qualities) ? movie.source.qualities : [],
      subtitles: Array.isArray(subtitles) ? subtitles : [],
      referer: VIDLOVE_REFERER,
    };
  }
  return null;
}

/** Parse a TMDB id out of a Servers blob / detail object. */
function tmdbFromServers(blob) {
  if (!blob) return '';
  return String(blob.tmdbId || blob.id || '');
}

/**
 * Resolve the best playable source for a detail object. Tries the
 * vidlove/ballerina direct-stream path first (real pause-synced MP4 + subs),
 * then falls back to embed URL resolution per host.
 */
async function resolveDetail(detail) {
  if (!detail) return { ok: false, error: 'No detail' };
  const tmdbId = tmdbFromServers(detail);
  if (tmdbId) {
    const direct = await resolveVidlove(tmdbId, detail.imdbId);
    if (direct) return { ok: true, ...direct };
  }
  for (const embed of detail.embedServers || []) {
    const resolved = await resolveEmbed(embed);
    if (resolved) return { ok: true, ...resolved, embedUrl: embed.url };
  }
  return { ok: false, error: 'No playable source found' };
}

module.exports = {
  SOURCES,
  EMBED_HOSTS,
  searchSite,
  detailPage,
  resolveEmbed,
  resolveDetail,
  resolveVidlove,
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
