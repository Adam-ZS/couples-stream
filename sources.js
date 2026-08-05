'use strict';

/**
 * sources.js — lawful free-source adapter for Watch Together Sync.
 *
 * Searches and extracts watchable sources from UAE-reachable sites and
 * resolves them into real playback through the ballerina / vidlove API.
 *
 * Sites covered:
 *   - ramoflix.net, doraby.com  : fmovie-theme WordPress sites (Servers blob)
 *   - hydrahd.ru                : custom WP theme — /movie/ID-slug and
 *                                 /watchseries/slug/season/S/episode/E pages
 *                                 that leak the TMDB id
 *   - 67movies.net              : Next.js SPA with a public JSON search API
 *                                 (/api/semantic-search) returning TMDB ids
 *
 * All sources funnel into a single resolution path: TMDB id (+ season /
 * episode for series) -> ballerina /movie or /tv endpoint -> signed direct
 * MP4 or HLS stream + VTT subtitles, served through the synced player.
 * No torrents, no debrid, no unrestricted proxy. Anything the sites publish
 * is handled server-side with allowlisted hosts only.
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
  {
    id: 'hydra',
    name: 'HydraHD',
    domain: 'https://hydrahd.ru',
  },
  {
    id: '67movies',
    name: '67Movies',
    domain: 'https://67movies.net',
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
  'b.ballerinacappuccinalovestungtungtungsahur.com',
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
    // Skip obvious nav/taxonomy pages (movie, tv-series, home…).
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

/** Search HydraHD: /index.php?menu=search&query=QUERY -> movies + series. */
async function searchHydra(query) {
  const url = `https://hydrahd.ru/index.php?menu=search&query=${encodeURIComponent(query)}`;
  const { status, ok, body } = await fetchPage(url, { referer: 'https://hydrahd.ru/' });
  if (!ok || status !== 200) return [];
  const results = [];
  // Hydra lists results as <a class="hthis" href="..." title="...">
  const anchorRe = /<a[^>]+href="([^"]+)"[^>]+title="([^"]*)"[^>]*>/gi;
  let match;
  while ((match = anchorRe.exec(body))) {
    const href = match[1];
    const title = cleanText(match[2], 200);
    if (!title || !href) continue;
    if (!/^\/?(movie|watchseries)\//.test(href)) continue;
    const urlObj = (() => { try { return new URL(href, 'https://hydrahd.ru'); } catch { return null; } })();
    if (!urlObj) continue;
    results.push({
      source: 'hydra',
      sourceName: 'HydraHD',
      title,
      url: urlObj.toString().replace(/\/+$/, ''),
      kind: href.startsWith('/watchseries') ? 'series' : 'movie',
    });
  }
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    const key = r.url;
    if (!seen.has(key)) { seen.add(key); unique.push(r); }
  }
  return unique.slice(0, 12);
}

/** Search 67Movies via its public JSON API: /api/semantic-search?q=QUERY. */
async function search67Movies(query) {
  const base = 'https://67movies.net/api/semantic-search';
  const { status, ok, body } = await fetchPage(`${base}?q=${encodeURIComponent(query)}`, { referer: 'https://67movies.net/' });
  if (!ok || status !== 200) return [];
  let data;
  try { data = JSON.parse(body); } catch { return []; }
  const results = [];
  for (const item of (data.results || [])) {
    const tmdbId = String(item.id || '');
    const mediaType = item.media_type === 'tv' ? 'tv' : 'movie';
    const title = cleanText(item.title || item.name || '', 200);
    if (!tmdbId || !title) continue;
    results.push({
      source: '67movies',
      sourceName: '67Movies',
      title,
      // Synthetic URL carrying the TMDB id + media type; resolved by detailPage.
      url: new URL(`/m/${tmdbId}?mediaType=${mediaType}`, 'https://67movies.net').toString(),
      kind: mediaType,
      tmdbId,
      mediaType,
    });
  }
  return results.slice(0, 12);
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
      mediaType: 'movie',
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

/**
 * Extract the TMDB id (and for series the season/episode) from a HydraHD
 * movie or watchseries page. Hydra leaks these as string params near the
 * player AJAX handler: "i":"ttIMDB","t":"TMDB", "s":"S", "e":"E".
 */
function parseHydraPage(body, url = '') {
  const tMatch = body.match(/"t"\s*:\s*"(\d+)"/);
  const iMatch = body.match(/"i"\s*:\s*"?(tt\d+)"?/);
  const tmdbId = tMatch ? tMatch[1] : '';
  const imdbId = iMatch ? iMatch[1] : '';

  // Series episode URLs carry season/episode in the path:
  // /watchseries/slug/season/S/episode/E
  let season = '';
  let episode = '';
  let mediaType = 'movie';
  const urlObj = (() => { try { return new URL(url); } catch { return null; } })();
  if (urlObj && /\/season\/\d+\/episode\/\d+/i.test(url)) {
    const se = url.match(/\/season\/(\d+)\/episode\/(\d+)/i);
    season = se[1];
    episode = se[2];
    mediaType = 'series';
  }
  return { tmdbId, imdbId, mediaType: mediaType === 'series' ? 'tv' : 'movie', season, episode, embedServers: [] };
}

/** Fetch a HydraHD page (movie or series) and return a parseHydra detail. */
async function hydraDetail(url) {
  const { ok, status, body } = await fetchPage(url, { referer: 'https://hydrahd.ru/' });
  if (!ok || status !== 200) return { status, error: 'Detail page unavailable' };
  const parsed = parseHydraPage(body, url);
  if (!parsed.tmdbId) return { status: 200, error: 'No resolvable TMDB id on this page' };
  return { status: 200, ...parsed };
}

/** Fetch a movie detail page and return the parsed Servers blob. */
async function detailPage(url) {
  const host = hostnameOf(url);
  // 67Movies synthetic URL: /m/{id}?mediaType=tv|movie — resolve directly.
  if (host === '67movies.net') {
    const urlObj = (() => { try { return new URL(url); } catch { return null; } })();
    if (urlObj) {
      const m = urlObj.pathname.match(/^\/(?:m|movie|tv)\/(\d+)/);
      const mediaType = urlObj.searchParams.get('mediaType') || (urlObj.pathname.includes('/tv/') ? 'tv' : 'movie');
      if (m && m[1]) {
        return { status: 200, tmdbId: m[1], mediaType, imdbId: '', season: '', episode: '', embedServers: [], poster: '', title: urlObj.searchParams.get('title') || '' };
      }
    }
  }
  // HydraHD — movie or watchseries URLs.
  if (host === 'hydrahd.ru') {
    return hydraDetail(url);
  }
  // fmovie/WordPress sites & default — standard detailPage.
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
 * Resolve a title via the vidlove/ballerina API. The /movie endpoint
 * returns a signed stream URL plus quality variants; /tv does the same for
 * a specific season/episode. /subtitles returns VTT tracks.
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
 * Sniff a ballerina stream URL's kind by peeking its content-type. Returns
 * 'hls' | 'mp4'. Prefers the backend signal (moviebox is progressive MP4,
 * vidapi/ipcloud are HLS manifests) but verifies with a small HEAD/Range
 * fetch so a single failed probe still yields the right label.
 */
async function sniffStreamKind(url, backend) {
  const fallback = backend === 'moviebox' ? 'mp4' : 'hls';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
        Referer: VIDLOVE_REFERER,
        Origin: 'https://player.vidlove.cc',
        Accept: '*/*',
        'Sec-Fetch-Dest': 'video',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
        Range: 'bytes=0-16',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    const ct = r.headers.get('content-type') || '';
    if (/m3u8|vnd\.apple\.mpegurl/.test(ct)) return 'hls';
    if (/mp4|octet-stream/.test(ct)) return 'mp4';
    // Fall back to magic bytes when content-type is generic.
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      const head = buf.slice(0, 16).toString('ascii');
      if (head.startsWith('#EXTM3U') || /mpegurl/.test(ct)) return 'hls';
      if (head.includes('ftyp')) return 'mp4';
    }
    return fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a movie by TMDB id into a direct MP4/HLS stream + subtitles,
 * trying each backend in order (movies availability differs per title).
 */
async function resolveMovie(tmdbId) {
  if (!tmdbId) return null;
  for (const backend of ['moviebox', 'vidapi', 'ipcloud']) {
    const movie = await ballerinaJson(`/movie?id=${encodeURIComponent(tmdbId)}&mode=json&sources=${backend}`, VIDLOVE_REFERER);
    if (!movie || !movie.source || !movie.source.url) continue;
    const subtitles = await ballerinaJson(`/subtitles/movie/${encodeURIComponent(tmdbId)}`, VIDLOVE_REFERER);
    const streamKind = await sniffStreamKind(movie.source.url, backend);
    return {
      type: 'direct',
      label: String(movie.source.label || 'MovieBox'),
      url: movie.source.url,
      streamKind,
      qualities: Array.isArray(movie.source.qualities) ? movie.source.qualities : [],
      subtitles: Array.isArray(subtitles) ? subtitles : [],
      referer: VIDLOVE_REFERER,
    };
  }
  return null;
}

/**
 * Resolve a TV series episode by TMDB id + season + episode.
 * Tries each backend in order (not every series is on every source).
 */
async function resolveTvSeries(tmdbId, season, episode) {
  if (!tmdbId) return null;
  const s = season || '1';
  const e = episode || '1';
  for (const backend of ['moviebox', 'vidapi', 'ipcloud']) {
    const ep = await ballerinaJson(
      `/tv?id=${encodeURIComponent(tmdbId)}&season=${s}&episode=${e}&mode=json&sources=${backend}`,
      VIDLOVE_REFERER
    );
    if (!ep || !ep.source || !ep.source.url) continue;
    const subtitles = await ballerinaJson(`/subtitles/tv/${encodeURIComponent(tmdbId)}/${s}/${e}`, VIDLOVE_REFERER);
    const streamKind = await sniffStreamKind(ep.source.url, backend);
    return {
      type: 'direct',
      label: String(ep.source.label || 'MovieBox'),
      url: ep.source.url,
      streamKind,
      qualities: Array.isArray(ep.source.qualities) ? ep.source.qualities : [],
      subtitles: Array.isArray(subtitles) ? subtitles : [],
      referer: VIDLOVE_REFERER,
      title: String((ep.meta && ep.meta.name) || ''),
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
 * Resolve the best playable source for a detail object. Prefers
 * TMDB-id -> ballerina direct path (real pause-synced stream), then falls
 * back to embed URL resolution per host.
 */
async function resolveDetail(detail) {
  if (!detail) return { ok: false, error: 'No detail' };
  const tmdbId = tmdbFromServers(detail) || detail.tmdbId;
  if (tmdbId) {
    if (detail.mediaType === 'tv' || detail.mediaType === 'series') {
      const direct = await resolveTvSeries(tmdbId, detail.season, detail.episode);
      if (direct) return { ok: true, ...direct };
    } else {
      const direct = await resolveMovie(tmdbId);
      if (direct) return { ok: true, ...direct };
    }
  }
  for (const embed of detail.embedServers || []) {
    const resolved = await resolveEmbed(embed);
    if (resolved) return { ok: true, ...resolved };
  }
  return { ok: false, error: 'No playable source found' };
}

module.exports = {
  SOURCES,
  EMBED_HOSTS,
  searchHydra,
  search67Movies,
  searchSite,
  fetchPage,
  detailPage,
  resolveEmbed,
  resolveDetail,
  resolveMovie,
  resolveTvSeries,
  hostnameOf,
  cleanText,
  UA,
  allowedHosts() {
    const hosts = [...EMBED_HOSTS];
    for (const s of SOURCES) {
      try { hosts.push(new URL(s.domain).hostname.replace(/^www\./, '')); } catch { /* skip */ }
    }
    return hosts;
  },
};