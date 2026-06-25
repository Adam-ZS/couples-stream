const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const PORT = 8765;
const TMDB_KEY = '8265bd1679663a7ea12ac168da84d2e8';
const TORRENTIO_BASE = 'https://torrentio.strem.fun';
const TPB_BASE = 'https://thepiratebay-plus.strem.fun';

// ---- Stream sources ----
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// TMDB search proxy
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.json({ results: [] });
  try {
    const resp = await fetch(
      `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(q)}&language=en-US&page=1`
    );
    const data = await resp.json();
    // Return simplified results
    const results = (data.results || []).slice(0, 10).map(m => ({
      id: m.id,
      imdb_id: '', // filled via detail call
      title: m.title,
      year: m.release_date?.split('-')[0] || '',
      poster: m.poster_path ? `https://image.tmdb.org/t/p/w200${m.poster_path}` : '',
      overview: m.overview?.substring(0, 200) || ''
    }));
    // Fetch IMDB ids in parallel
    await Promise.all(results.map(async (r) => {
      try {
        const d = await fetch(
          `https://api.themoviedb.org/3/movie/${r.id}?api_key=${TMDB_KEY}`
        );
        const j = await d.json();
        r.imdb_id = j.imdb_id || '';
        // Also get runtime
        r.runtime = j.runtime || 0;
      } catch(e) { /* skip */ }
    }));
    res.json({ results: results.filter(r => r.imdb_id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stream sources: Torrentio + ThePirateBay+
const FETCH_TIMEOUT = 8000; // 8s max per source

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/streams/:imdbId', async (req, res) => {
  try {
    const { imdbId } = req.params;
    // Fetch from all sources in parallel with individual timeouts
    const [torrentioResp, tpbResp] = await Promise.allSettled([
      fetchWithTimeout(`${TORRENTIO_BASE}/stream/movie/${imdbId}.json`).catch(e => { console.log(`Torrentio: ${e.message}`); return null; }),
      fetchWithTimeout(`${TPB_BASE}/stream/movie/${imdbId}.json`).catch(e => { console.log(`TPB: ${e.message}`); return null; })
    ]);
    const combined = { streams: [] };
    if (torrentioResp.status === 'fulfilled' && torrentioResp.value?.streams) {
      combined.streams.push(...torrentioResp.value.streams.map(s => ({ ...s, source: 'torrentio' })));
    }
    if (tpbResp.status === 'fulfilled' && tpbResp.value?.streams) {
      combined.streams.push(...tpbResp.value.streams.map(s => ({ ...s, source: 'tpb' })));
    }
    // Deduplicate by infoHash
    const seen = new Set();
    combined.streams = combined.streams.filter(s => {
      const key = s.infoHash || s.url || s.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    res.json(combined);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- HiTV API (from PC client reverse engineering) ----
const HITV_API = 'https://api.hitv.win';

app.get('/api/hitv/search', async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.json({ results: [] });
  try {
    const resp = await fetch(
      `${HITV_API}/cms/pc/search/searchWithKeyWord?keyword=${encodeURIComponent(q)}&page=1&size=20`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/hitv/detail', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.json({ error: 'no id' });
  try {
    const resp = await fetch(
      `${HITV_API}/cms/pc/movieDrama/get?id=${id}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/hitv/play', async (req, res) => {
  const { id, episode } = req.query;
  if (!id) return res.json({ error: 'no id' });
  try {
    const url = episode
      ? `${HITV_API}/cms/pc/movieDrama/getSimplePlayInfo?id=${id}&episode=${episode}`
      : `${HITV_API}/cms/pc/movieDrama/getSimplePlayInfo?id=${id}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/hitv/home', async (req, res) => {
  try {
    const resp = await fetch(
      `${HITV_API}/home/pc/getHome`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/hitv/hot', async (req, res) => {
  try {
    const resp = await fetch(
      `${HITV_API}/cms/pc/search/hot`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Real-Debrid API (from HDO Box reverse engineering) ----
const RD_CLIENT_ID = 'H7UK3NUAECBQY';

// Real-Debrid OAuth - get device code
app.get('/api/rd/auth', async (req, res) => {
  try {
    const resp = await fetch(
      `https://api.real-debrid.com/oauth/v2/device/code?client_id=${RD_CLIENT_ID}`,
      { method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Check OAuth credentials
app.get('/api/rd/credentials', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.json({ error: 'no code' });
  try {
    const resp = await fetch(
      `https://api.real-debrid.com/oauth/v2/device/credentials?client_id=${RD_CLIENT_ID}&code=${code}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Unrestrict link via Real-Debrid (turn a torrent/magnet into direct stream)
app.post('/api/rd/unrestrict', async (req, res) => {
  const { link, token } = req.query;
  if (!link || !token) return res.json({ error: 'need link and token' });
  try {
    const form = new URLSearchParams();
    form.append('link', link);
    const resp = await fetch('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Mozilla/5.0'
      },
      body: form
    });
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- OpenSubtitles API ----
app.get('/api/subs/search', async (req, res) => {
  const { imdb_id, lang } = req.query;
  if (!imdb_id) return res.json({ error: 'no imdb_id' });
  try {
    const url = lang
      ? `https://rest.opensubtitles.org/search/imdbid-${imdb_id}/${lang}`
      : `https://rest.opensubtitles.org/search/imdbid-${imdb_id}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'XBMC_Subtitles_v1' }
    });
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Torrent Streaming (server-side WebTorrent) ----
// WebTorrent v3 is ESM, loaded dynamically
let _torrentClient = null;
let _torrentsMap = null;

async function getTorrentClient() {
  if (!_torrentClient) {
    const { default: WebTorrent } = await import('webtorrent');
    _torrentClient = new WebTorrent();
    _torrentsMap = new Map();
  }
  return _torrentClient;
}

app.get('/api/stream/torrent', async (req, res) => {
  try {
    const { infoHash, magnet } = req.query;
    const torrentId = infoHash || magnet;
    if (!torrentId) return res.status(400).send('Need infoHash or magnet');

    const client = await getTorrentClient();
    const normId = infoHash ? infoHash.toLowerCase() : null;
    let entry = normId ? _torrentsMap.get(normId) : null;

    if (entry && entry.ready) {
      return serveTorrentFile(entry.torrent, req, res);
    }

    if (!entry) {
      if (normId) _torrentsMap.set(normId, { ready: false, torrent: null });
      client.add(torrentId, { path: '/tmp/couples-stream' }, (t) => {
        console.log(`[torrent] Started: ${t.name}`);
        if (normId) _torrentsMap.set(normId, { ready: true, torrent: t });
        serveTorrentFile(t, req, res);
      });
      client.on('error', (err) => {
        console.error('[torrent] Error:', err.message);
        if (!res.headersSent) res.status(500).send('Torrent error: ' + err.message);
      });
    } else {
      serveTorrentFile(entry.torrent, req, res);
    }
  } catch (e) {
    console.error('[torrent] Fatal:', e.message);
    if (!res.headersSent) res.status(500).send('Stream error: ' + e.message);
  }
});

function serveTorrentFile(torrent, req, res) {
  if (!torrent || !torrent.files) {
    return res.status(500).send('Torrent not ready');
  }

  // Find best video file (largest video)
  const file = torrent.files
    .filter(f => /\.(mp4|mkv|avi|mov|webm|m4v)$/i.test(f.name))
    .sort((a, b) => b.length - a.length)[0];

  if (!file) {
    // Fallback: largest file that might be playable
    const fallback = torrent.files.sort((a, b) => b.length - a.length)[0];
    if (!fallback) return res.status(404).send('No files in torrent');
    return streamFileToResponse(fallback, req, res);
  }

  streamFileToResponse(file, req, res);
}

function streamFileToResponse(file, req, res) {
  const range = req.headers.range;
  const fileSize = file.length;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
      'Access-Control-Allow-Origin': '*'
    });
    file.createReadStream({ start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*'
    });
    file.createReadStream().pipe(res);
  }

  req.on('close', () => {
    // Client disconnected — stream is cleaned up automatically
  });
}

// ---- HTTP Server ----
const server = http.createServer(app);

// ---- WebSocket ----
const wss = new WebSocketServer({ server });

// Room state: { roomId -> { users: Map<ws, {name}>, state: {playing, time} } }
const rooms = new Map();
const roomPasswords = new Map(); // roomId -> password (set on first join if provided)

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      users: new Map(),
      state: { playing: false, time: 0, lastUpdate: Date.now() },
      chatHistory: [], // 200k limit with compression (see addToHistory)
    });
  }
  return rooms.get(roomId);
}

function rejectJoin(ws, reason) {
  ws.send(JSON.stringify({ type: 'join_rejected', reason }));
}

function broadcast(room, message, exclude = null) {
  const msg = JSON.stringify(message);
  for (const [ws, _] of room.users) {
    if (ws !== exclude && ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

wss.on('connection', (ws) => {
  let userRoom = null;
  let userName = null;
  let wsRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    if (msg.type === 'join') {
      // Leave previous room
      if (wsRoom) {
        wsRoom.users.delete(ws);
        broadcast(wsRoom, { type: 'user_left', name: userName });
      }

      const roomId = msg.room || 'default';
      userName = msg.name || 'Anonymous';
      const password = msg.password || '';

      // Check room password
      if (roomPasswords.has(roomId)) {
        if (password !== roomPasswords.get(roomId)) {
          rejectJoin(ws, 'wrong_password');
          return;
        }
      } else {
        // No password set yet — if one was provided, set it
        if (password) {
          roomPasswords.set(roomId, password);
        }
      }

      wsRoom = getRoom(roomId);
      wsRoom.users.set(ws, { name: userName });
      userRoom = roomId;

      // Send current state to joining user
      ws.send(JSON.stringify({
        type: 'room_state',
        state: wsRoom.state,
        users: Array.from(wsRoom.users.values()).map(u => u.name),
        chatHistory: wsRoom.chatHistory.slice(-200)
      }));

      // Broadcast user joined
      broadcast(wsRoom, { type: 'user_joined', name: userName }, ws);
    }

    else if (msg.type === 'play' || msg.type === 'pause' || msg.type === 'seek') {
      if (!wsRoom) return;
      wsRoom.state.playing = msg.type === 'play';
      wsRoom.state.time = msg.time || 0;
      wsRoom.state.lastUpdate = Date.now();
      // Broadcast to ALL including sender (for sync accuracy)
      broadcast(wsRoom, {
        type: msg.type,
        time: msg.time,
        by: userName
      });
    }

    else if (msg.type === 'chat') {
      if (!wsRoom || !userName) return;
      const chatMsg = {
        type: 'chat',
        name: userName,
        message: msg.message?.substring(0, 2000) || '',
        timestamp: Date.now()
      };
      // 200k history with compression
      wsRoom.chatHistory.push(chatMsg);
      if (wsRoom.chatHistory.length > 200000) {
        // Compress: keep last 190k, summarize oldest 10k
        const oldest = wsRoom.chatHistory.splice(0, wsRoom.chatHistory.length - 190000);
        const byDay = {};
        for (const m of oldest) {
          const day = new Date(m.timestamp || 0).toISOString().split('T')[0];
          if (!byDay[day]) byDay[day] = { count: 0, users: new Set() };
          byDay[day].count++;
          if (m.name) byDay[day].users.add(m.name);
        }
        const compressed = Object.entries(byDay).map(([day, info]) => ({
          type: 'chat',
          name: '📅 system',
          message: `${day}: ${info.count} messages from ${info.users.size} users`,
          timestamp: new Date(day).getTime(),
          compressed: true
        }));
        wsRoom.chatHistory.unshift(...compressed);
        if (wsRoom.chatHistory.length > 200000) {
          wsRoom.chatHistory.splice(0, wsRoom.chatHistory.length - 200000);
        }
      }
      broadcast(wsRoom, chatMsg);
    }

    else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    if (wsRoom) {
      wsRoom.users.delete(ws);
      broadcast(wsRoom, { type: 'user_left', name: userName });
      if (wsRoom.users.size === 0) {
        // Clean up empty rooms after 10 minutes
        setTimeout(() => {
          if (wsRoom && wsRoom.users.size === 0) {
            rooms.delete(userRoom);
          }
        }, 10 * 60 * 1000);
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Couples Stream running on http://0.0.0.0:${PORT}`);
  console.log(`TMDB proxy ready | WebSocket ready`);
});
