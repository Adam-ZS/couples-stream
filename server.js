'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { TextDecoder } = require('util');
const sources = require('./sources');

const DEFAULTS = Object.freeze({
  port: Number(process.env.PORT) || 8765,
  roomTtlMs: 24 * 60 * 60 * 1000,
  emptyRoomTtlMs: 30 * 60 * 1000,
  maxRooms: 5000,
  maxClientsPerRoom: 20,
  maxChatHistory: 200,
  maxMessageBytes: 16 * 1024,
  heartbeatMs: 30 * 1000,
});

const ROOM_ID_RE = /^[A-Za-z0-9_-]{12,32}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MEDIA_KINDS = new Set(['url', 'youtube', 'local', 'demo', 'embed']);
const CONTROL_POLICIES = new Set(['everyone', 'host']);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
});

function randomToken(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashSecret(secret, salt) {
  return crypto.scryptSync(String(secret), salt, 32).toString('base64url');
}

function safeEqual(a, b) {
  const aBuffer = Buffer.from(String(a));
  const bBuffer = Buffer.from(String(b));
  return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer);
}

function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function normalizeHttpUrl(value, { allowYouTube = false } = {}) {
  try {
    const url = new URL(String(value));
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localHttp) return null;
    if (!allowYouTube && /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(url.hostname)) return null;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeMedia(input) {
  if (!input || typeof input !== 'object' || !MEDIA_KINDS.has(input.kind)) return null;
  const media = {
    id: cleanText(input.id, 96) || randomToken(10),
    kind: input.kind,
    title: cleanText(input.title, 160) || 'Untitled media',
    poster: normalizeHttpUrl(input.poster) || '',
  };

  if (media.kind === 'url' || media.kind === 'demo') {
    media.url = normalizeHttpUrl(input.url);
    if (!media.url) return null;
  } else if (media.kind === 'youtube') {
    const youtubeId = cleanText(input.youtubeId, 20);
    if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeId)) return null;
    media.youtubeId = youtubeId;
  } else if (media.kind === 'local') {
    media.fingerprint = cleanText(input.fingerprint, 160);
    media.fileName = cleanText(input.fileName, 180);
    media.fileSize = clampNumber(input.fileSize, 0, 100 * 1024 ** 3, 0);
    if (!media.fingerprint || !media.fileName) return null;
  } else if (media.kind === 'embed') {
    // Embed URLs are iframe sources from the lawful source layer. Only allow
    // https and the source/embed hosts the app itself knows about.
    const embedUrl = normalizeHttpUrl(input.url);
    if (!embedUrl) return null;
    let host;
    try { host = new URL(embedUrl).hostname.replace(/^www\./, ''); } catch { return null; }
    const allowedHosts = new Set(sources.allowedHosts());
    if (!allowedHosts.has(host)) return null;
    media.url = embedUrl;
    media.embedHost = host;
  }
  return media;
}

function roomPosition(playback, now = Date.now()) {
  if (!playback || playback.paused) return playback?.position || 0;
  return Math.max(0, playback.position + ((now - playback.updatedAt) / 1000) * playback.rate);
}

function createRateLimiter({ windowMs, limit }) {
  const buckets = new Map();
  return function rateLimit(key) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (buckets.size > 10_000) {
      for (const [bucketKey, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(bucketKey);
      }
    }
    return bucket.count <= limit;
  };
}

function createRoomStore(config) {
  const rooms = new Map();

  function create({ password = '' } = {}) {
    if (rooms.size >= config.maxRooms) {
      const oldestEmpty = [...rooms.values()]
        .filter((room) => room.clients.size === 0)
        .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
      if (oldestEmpty) rooms.delete(oldestEmpty.id);
      if (rooms.size >= config.maxRooms) throw new Error('ROOM_CAPACITY');
    }

    let id;
    do id = randomToken(10); while (rooms.has(id));
    const hostToken = randomToken(24);
    const hostSalt = randomToken(12);
    const passwordSalt = password ? randomToken(12) : '';
    const now = Date.now();
    const room = {
      id,
      createdAt: now,
      lastActiveAt: now,
      emptySince: now,
      hostClientId: null,
      hostTokenSalt: hostSalt,
      hostTokenHash: hashSecret(hostToken, hostSalt),
      passwordSalt,
      passwordHash: password ? hashSecret(password, passwordSalt) : '',
      settings: { controlPolicy: 'everyone' },
      media: null,
      playback: { paused: true, position: 0, rate: 1, updatedAt: now, revision: 0 },
      clients: new Map(),
      chatHistory: [],
    };
    rooms.set(id, room);
    return { room, hostToken };
  }

  function cleanup(now = Date.now()) {
    for (const [id, room] of rooms) {
      const tooOld = now - room.createdAt > config.roomTtlMs;
      const emptyTooLong = room.clients.size === 0 && now - room.emptySince > config.emptyRoomTtlMs;
      if (tooOld || emptyTooLong) rooms.delete(id);
    }
  }

  return { rooms, create, cleanup };
}

class WebSocketConnection extends EventEmitter {
  constructor(socket, head, maxPayload) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.readyState = 1;
    this.isAlive = true;
    this.buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.fragmentLength = 0;
    this.closedEmitted = false;

    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.emitClose());
    socket.on('end', () => this.emitClose());
    socket.on('error', (error) => this.emit('error', error));
    if (this.buffer.length) this.parseFrames();
  }

  sendText(text) {
    if (this.readyState !== 1) return;
    this.socket.write(encodeFrame(0x1, Buffer.from(String(text))));
  }

  ping() {
    if (this.readyState === 1) this.socket.write(encodeFrame(0x9, Buffer.alloc(0)));
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    const safeReason = Buffer.from(String(reason)).subarray(0, 123);
    const payload = Buffer.alloc(2 + safeReason.length);
    payload.writeUInt16BE(code, 0);
    safeReason.copy(payload, 2);
    this.socket.write(encodeFrame(0x8, payload));
    this.socket.end();
  }

  terminate() {
    this.readyState = 3;
    this.socket.destroy();
    this.emitClose();
  }

  emitClose() {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.readyState = 3;
    this.emit('close');
  }

  protocolError(reason = 'Protocol error') {
    this.close(1002, reason);
  }

  onData(chunk) {
    if (this.readyState >= 2) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    this.parseFrames();
  }

  parseFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let payloadLength = second & 0x7f;
      let offset = 2;

      if (rsv || !masked) return this.protocolError();
      if (payloadLength === 126) {
        if (this.buffer.length < 4) return;
        payloadLength = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) return;
        const high = this.buffer.readUInt32BE(2);
        const low = this.buffer.readUInt32BE(6);
        if (high > 0x1fffff) return this.close(1009, 'Message too large');
        payloadLength = high * 2 ** 32 + low;
        offset = 10;
      }

      const isControl = opcode >= 0x8;
      if ((isControl && (!fin || payloadLength > 125)) || payloadLength > this.maxPayload) {
        return this.close(1009, 'Message too large');
      }
      if (this.buffer.length < offset + 4 + payloadLength) return;

      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLength));
      this.buffer = this.buffer.subarray(offset + payloadLength);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];

      if (opcode === 0x8) {
        if (this.readyState === 1) this.socket.write(encodeFrame(0x8, payload));
        this.readyState = 2;
        this.socket.end();
        continue;
      }
      if (opcode === 0x9) {
        this.socket.write(encodeFrame(0xA, payload));
        continue;
      }
      if (opcode === 0xA) {
        this.isAlive = true;
        this.emit('pong');
        continue;
      }
      if (opcode === 0x2) return this.close(1003, 'Binary messages unsupported');
      if (![0x0, 0x1].includes(opcode)) return this.protocolError();

      if (opcode === 0x1 && !fin) {
        if (this.fragmentOpcode) return this.protocolError();
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentLength = payload.length;
        continue;
      }
      if (opcode === 0x0) {
        if (!this.fragmentOpcode) return this.protocolError();
        this.fragmentLength += payload.length;
        if (this.fragmentLength > this.maxPayload) return this.close(1009, 'Message too large');
        this.fragments.push(payload);
        if (!fin) continue;
        const complete = Buffer.concat(this.fragments, this.fragmentLength);
        this.fragments = [];
        this.fragmentOpcode = 0;
        this.fragmentLength = 0;
        this.emitText(complete);
        continue;
      }
      if (opcode === 0x1 && fin) this.emitText(payload);
    }
  }

  emitText(payload) {
    try {
      this.emit('message', UTF8_DECODER.decode(payload));
    } catch {
      this.close(1007, 'Invalid UTF-8');
    }
  }
}

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function json(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://www.youtube.com https://s.ytimg.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://image.tmdb.org https:",
    "media-src 'self' blob: https: http://localhost:* http://127.0.0.1:*",
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com https://soap2night.cc https://player.videasy.net https://vidfast.pro https://vidfast.vc https://vidcore.net https://player.vidzee.wtf https://111movies.com https://ramoflix.net https://doraby.com",
    "connect-src 'self' ws: wss: https:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
}

function requestIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return cleanText(Array.isArray(forwarded) ? forwarded[0] : String(forwarded || '').split(',')[0], 80)
    || req.socket.remoteAddress
    || 'unknown';
}

function readJsonBody(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, publicDir, pathname) {
  let relativePath;
  try { relativePath = decodeURIComponent(pathname); } catch { return false; }
  if (relativePath === '/') relativePath = '/index.html';
  if (!path.extname(relativePath)) relativePath = '/index.html';
  const resolved = path.resolve(publicDir, `.${relativePath}`);
  if (!resolved.startsWith(`${publicDir}${path.sep}`) && resolved !== path.join(publicDir, 'index.html')) return false;
  let stat;
  try { stat = fs.statSync(resolved); } catch { return false; }
  if (!stat.isFile()) return false;

  const type = MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': resolved.endsWith('index.html') ? 'no-cache' : (process.env.NODE_ENV === 'production' ? 'public, max-age=3600' : 'no-cache'),
  });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(resolved).pipe(res);
  return true;
}

function attachRoomProtocol(server, store, config) {
  const connections = new Set();

  function send(ws, payload) {
    if (ws.readyState === 1) ws.sendText(JSON.stringify(payload));
  }

  function publicParticipant(client, room) {
    return { id: client.id, name: client.name, isHost: room.hostClientId === client.id, mediaReady: Boolean(client.mediaReady) };
  }

  function roomSnapshot(room) {
    const now = Date.now();
    return {
      roomId: room.id,
      media: room.media,
      playback: { ...room.playback, position: roomPosition(room.playback, now), updatedAt: now },
      settings: room.settings,
      participants: [...room.clients.values()].map((client) => publicParticipant(client, room)),
      chatHistory: room.chatHistory,
      serverTime: now,
    };
  }

  function broadcast(room, payload, except = null) {
    const encoded = JSON.stringify(payload);
    for (const client of room.clients.values()) {
      if (client.ws !== except && client.ws.readyState === 1) client.ws.sendText(encoded);
    }
  }

  function broadcastParticipants(room) {
    broadcast(room, {
      type: 'participants',
      participants: [...room.clients.values()].map((client) => publicParticipant(client, room)),
      serverTime: Date.now(),
    });
  }

  function isHost(room, client) {
    return Boolean(client && room.hostClientId === client.id);
  }

  function canControl(room, client) {
    return room.settings.controlPolicy === 'everyone' || isHost(room, client);
  }

  function promoteHost(room) {
    const next = [...room.clients.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    room.hostClientId = next?.id || null;
    if (next) send(next.ws, { type: 'host:granted', serverTime: Date.now() });
  }

  function acceptConnection(socket, head) {
    const ws = new WebSocketConnection(socket, head, config.maxMessageBytes);
    connections.add(ws);
    let room = null;
    let client = null;
    let messageWindowStartedAt = Date.now();
    let messageCount = 0;

    function error(code, message) {
      send(ws, { type: 'error', code, message, serverTime: Date.now() });
    }

    ws.on('message', (raw) => {
      const now = Date.now();
      if (now - messageWindowStartedAt >= 10_000) {
        messageWindowStartedAt = now;
        messageCount = 0;
      }
      messageCount += 1;
      if (messageCount > 120) return error('RATE_LIMIT', 'Too many messages');

      let msg;
      try { msg = JSON.parse(raw); } catch { return error('BAD_JSON', 'Invalid message'); }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return error('BAD_MESSAGE', 'Invalid message');

      if (msg.type === 'join') {
        if (room) return error('ALREADY_JOINED', 'Already joined');
        const roomId = cleanText(msg.roomId, 32);
        if (!ROOM_ID_RE.test(roomId)) return error('INVALID_ROOM', 'Invalid room link');
        room = store.rooms.get(roomId);
        if (!room) return error('ROOM_NOT_FOUND', 'Room has expired or does not exist');
        if (room.clients.size >= config.maxClientsPerRoom) return error('ROOM_FULL', 'Room is full');

        if (room.passwordHash) {
          const supplied = hashSecret(cleanText(msg.password, 128), room.passwordSalt);
          if (!safeEqual(supplied, room.passwordHash)) {
            room = null;
            return error('WRONG_PASSWORD', 'Wrong room password');
          }
        }

        let requestedId = cleanText(msg.clientId, 64);
        if (!CLIENT_ID_RE.test(requestedId) || room.clients.has(requestedId)) requestedId = randomToken(12);
        const suppliedHostToken = cleanText(msg.hostToken, 256);
        const validHostToken = suppliedHostToken && safeEqual(hashSecret(suppliedHostToken, room.hostTokenSalt), room.hostTokenHash);
        client = {
          id: requestedId,
          ws,
          name: cleanText(msg.name, 32) || 'Guest',
          joinedAt: now,
          mediaReady: false,
        };
        room.clients.set(client.id, client);
        room.emptySince = 0;
        room.lastActiveAt = now;
        if (!room.hostClientId || validHostToken) room.hostClientId = client.id;

        send(ws, { type: 'welcome', selfId: client.id, isHost: isHost(room, client), snapshot: roomSnapshot(room) });
        broadcast(room, { type: 'system', message: `${client.name} joined`, serverTime: now }, ws);
        broadcastParticipants(room);
        return;
      }

      if (!room || !client) return error('NOT_JOINED', 'Join a room first');
      room.lastActiveAt = now;

      switch (msg.type) {
        case 'ping':
          send(ws, { type: 'pong', clientTime: Number(msg.clientTime) || 0, serverTime: now });
          break;
        case 'chat:send': {
          const message = cleanText(msg.message, 500);
          if (!message) break;
          const chat = { id: randomToken(8), name: client.name, clientId: client.id, message, timestamp: now };
          room.chatHistory.push(chat);
          if (room.chatHistory.length > config.maxChatHistory) room.chatHistory.splice(0, room.chatHistory.length - config.maxChatHistory);
          broadcast(room, { type: 'chat', chat, serverTime: now });
          break;
        }
        case 'media:set': {
          if (!canControl(room, client)) return error('FORBIDDEN', 'Only the host can change media');
          const media = normalizeMedia(msg.media);
          if (!media) return error('INVALID_MEDIA', 'Unsupported or invalid media');
          room.media = media;
          room.playback = { paused: true, position: 0, rate: 1, updatedAt: now, revision: room.playback.revision + 1 };
          for (const participant of room.clients.values()) participant.mediaReady = participant.id === client.id;
          broadcast(room, { type: 'media', media: room.media, playback: room.playback, by: client.name, revision: room.playback.revision, serverTime: now });
          broadcastParticipants(room);
          break;
        }
        case 'media:ready':
          client.mediaReady = Boolean(msg.ready);
          broadcastParticipants(room);
          break;
        case 'playback:update': {
          if (!canControl(room, client)) return error('FORBIDDEN', 'Only the host can control playback');
          if (!room.media) return error('NO_MEDIA', 'Choose media first');
          room.playback = {
            paused: Boolean(msg.paused),
            position: clampNumber(msg.position, 0, 7 * 24 * 60 * 60, roomPosition(room.playback, now)),
            rate: clampNumber(msg.rate, 0.25, 4, room.playback.rate || 1),
            updatedAt: now,
            revision: room.playback.revision + 1,
          };
          broadcast(room, { type: 'playback', playback: room.playback, by: client.name, revision: room.playback.revision, serverTime: now });
          break;
        }
        case 'state:request':
          send(ws, { type: 'snapshot', snapshot: roomSnapshot(room) });
          break;
        case 'settings:update': {
          if (!isHost(room, client)) return error('FORBIDDEN', 'Only the host can change room settings');
          const controlPolicy = cleanText(msg.controlPolicy, 16);
          if (!CONTROL_POLICIES.has(controlPolicy)) return error('INVALID_SETTING', 'Invalid control policy');
          room.settings.controlPolicy = controlPolicy;
          broadcast(room, { type: 'settings', settings: room.settings, serverTime: now });
          break;
        }
        case 'participant:kick': {
          if (!isHost(room, client)) return error('FORBIDDEN', 'Only the host can remove participants');
          const target = room.clients.get(cleanText(msg.clientId, 64));
          if (!target || target.id === client.id) return error('INVALID_TARGET', 'Invalid participant');
          send(target.ws, { type: 'kicked', message: 'You were removed from the room', serverTime: now });
          target.ws.close(4001, 'Removed by host');
          break;
        }
        default:
          error('UNKNOWN_TYPE', 'Unknown message type');
      }
    });

    ws.on('close', () => {
      connections.delete(ws);
      if (!room || !client) return;
      room.clients.delete(client.id);
      room.lastActiveAt = Date.now();
      broadcast(room, { type: 'system', message: `${client.name} left`, serverTime: Date.now() });
      if (room.hostClientId === client.id) promoteHost(room);
      if (room.clients.size === 0) room.emptySince = Date.now();
      else broadcastParticipants(room);
    });
    ws.on('error', (errorValue) => console.warn('[ws]', errorValue.message));
  }

  server.on('upgrade', (req, socket, head) => {
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    const connection = String(req.headers.connection || '').toLowerCase();
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (upgrade !== 'websocket' || !connection.includes('upgrade') || !key || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'));
    acceptConnection(socket, head);
  });

  const heartbeat = setInterval(() => {
    for (const ws of connections) {
      if (!ws.isAlive) ws.terminate();
      else {
        ws.isAlive = false;
        ws.ping();
      }
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  return {
    connections,
    close() {
      clearInterval(heartbeat);
      for (const ws of connections) ws.close(1001, 'Server shutting down');
    },
  };
}

function createServer(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const store = createRoomStore(config);
  const publicDir = path.resolve(__dirname, 'public');
  const apiLimiter = createRateLimiter({ windowMs: 60_000, limit: 90 });
  const createLimiter = createRateLimiter({ windowMs: 60_000, limit: 15 });
  const tmdbToken = process.env.TMDB_BEARER_TOKEN || '';
  const tmdbApiKey = process.env.TMDB_API_KEY || '';

  // Hosts approved by parsed HLS manifests for the /api/stream proxy. Locked
  // to hosts a source manifest actually referenced; expires after 10 minutes.
  const approvedSegmentHosts = new Map();
  const approveSweeper = setInterval(() => {
    const now = Date.now();
    for (const [host, expiry] of approvedSegmentHosts) {
      if (expiry <= now) approvedSegmentHosts.delete(host);
    }
  }, 60_000);
  approveSweeper.unref();

  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    try {
      if (pathname.startsWith('/api/')) {
        const ip = requestIp(req);
        if (!apiLimiter(ip)) return json(res, 429, { error: 'Too many requests' });
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        return json(res, 200, { ok: true, rooms: store.rooms.size, uptime: Math.round(process.uptime()), now: Date.now() });
      }

      if (req.method === 'GET' && pathname === '/api/config') {
        return json(res, 200, { tmdbEnabled: Boolean(tmdbToken || tmdbApiKey), maxRoomSize: config.maxClientsPerRoom });
      }

      if (req.method === 'POST' && pathname === '/api/rooms') {
        const ip = requestIp(req);
        if (!createLimiter(ip)) return json(res, 429, { error: 'Too many rooms created' });
        const body = await readJsonBody(req);
        const password = cleanText(body.password, 128);
        try {
          const { room, hostToken } = store.create({ password });
          return json(res, 201, { roomId: room.id, hostToken, passwordProtected: Boolean(password) });
        } catch (error) {
          if (error.message === 'ROOM_CAPACITY') return json(res, 503, { error: 'Room capacity reached' });
          throw error;
        }
      }

      if (req.method === 'GET' && pathname === '/api/search') {
        const query = cleanText(url.searchParams.get('q'), 80);
        if (query.length < 2) return json(res, 200, { results: [] });
        if (!tmdbToken && !tmdbApiKey) return json(res, 503, { error: 'TMDB search is not configured', code: 'TMDB_DISABLED' });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        try {
          const tmdbUrl = new URL('https://api.themoviedb.org/3/search/multi');
          tmdbUrl.searchParams.set('query', query);
          tmdbUrl.searchParams.set('include_adult', 'false');
          tmdbUrl.searchParams.set('language', 'en-US');
          tmdbUrl.searchParams.set('page', '1');
          if (tmdbApiKey) tmdbUrl.searchParams.set('api_key', tmdbApiKey);
          const response = await fetch(tmdbUrl, {
            signal: controller.signal,
            headers: tmdbToken ? { Authorization: `Bearer ${tmdbToken}`, Accept: 'application/json' } : { Accept: 'application/json' },
          });
          if (!response.ok) return json(res, 502, { error: 'TMDB request failed' });
          const data = await response.json();
          const results = (data.results || [])
            .filter((item) => item.media_type === 'movie' || item.media_type === 'tv')
            .slice(0, 12)
            .map((item) => ({
              id: String(item.id),
              type: item.media_type,
              title: cleanText(item.title || item.name, 160),
              year: String(item.release_date || item.first_air_date || '').slice(0, 4),
              overview: cleanText(item.overview, 260),
              poster: item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : '',
            }));
          return json(res, 200, { results });
        } catch (error) {
          return json(res, error.name === 'AbortError' ? 504 : 502, { error: error.name === 'AbortError' ? 'TMDB request timed out' : 'TMDB request failed' });
        } finally {
          clearTimeout(timer);
        }
      }

      if (req.method === 'GET' && pathname === '/api/sources') {
        const query = cleanText(url.searchParams.get('q'), 80);
        if (query.length < 2) return json(res, 200, { results: [] });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const results = [];
          for (const source of sources.SOURCES) {
            const found = await sources.searchSite(source, query);
            for (const item of found) results.push(item);
          }
          // Merge duplicates across sites by normalized title slug.
          const seen = new Map();
          for (const item of results) {
            const key = item.url.replace(/^https?:\/\//, '');
            if (!seen.has(key)) seen.set(key, item);
          }
          return json(res, 200, { results: [...seen.values()] });
        } catch (error) {
          return json(res, 502, { error: error.name === 'AbortError' ? 'Source search timed out' : 'Source search failed' });
        } finally {
          clearTimeout(timer);
        }
      }

      if (req.method === 'GET' && pathname === '/api/sources/detail') {
        const target = cleanText(url.searchParams.get('url'), 300);
        if (!/^https?:\/\//.test(target)) return json(res, 400, { error: 'Missing source URL' });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const detail = await sources.detailPage(target);
          if (detail.error) return json(res, detail.status === 404 ? 404 : 502, { error: detail.error });
          return json(res, 200, detail);
        } catch (error) {
          return json(res, error.name === 'AbortError' ? 504 : 502, { error: error.name === 'AbortError' ? 'Source detail timed out' : 'Source detail failed' });
        } finally {
          clearTimeout(timer);
        }
      }

      // Resolve a detail page into a playable stream. Returns a direct MP4 or
      // HLS stream URL (playable in the synced player through /api/stream) plus
      // subtitle tracks and quality variants when the vidlove/ballerina path is
      // available; otherwise falls back to an embed URL.
      if (req.method === 'GET' && pathname === '/api/sources/resolve') {
        const target = cleanText(url.searchParams.get('url'), 300);
        if (!/^https?:\/\//.test(target)) return json(res, 400, { error: 'Missing source URL' });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        try {
          const detail = await sources.detailPage(target);
          if (detail.error) return json(res, detail.status === 404 ? 404 : 502, { error: detail.error });
          const resolved = await sources.resolveDetail(detail);
          if (!resolved.ok) return json(res, 502, { error: resolved.error || 'No playable source' });
          // Sniff the upstream content-type to tell the client whether this is
          // an HLS manifest (needs hls.js) or a progressive MP4.
          let streamKind = 'mp4';
          if (resolved.type === 'direct' && resolved.url) {
            const probe = new AbortController();
            const probeTimer = setTimeout(() => probe.abort(), 8000);
            try {
              const probeRes = await fetch(resolved.url, {
                headers: {
                  'User-Agent': sources.UA,
                  Referer: resolved.referer || 'https://player.vidlove.cc/',
                  Origin: (() => { try { return new URL(resolved.referer || 'https://player.vidlove.cc/').origin; } catch { return 'https://player.vidlove.cc'; } })(),
                  'Accept': '*/*',
                  'Sec-Fetch-Dest': 'video',
                  'Sec-Fetch-Mode': 'no-cors',
                  'Sec-Fetch-Site': 'cross-site',
                  Range: 'bytes=0-2047',
                },
                signal: probe.signal,
                redirect: 'follow',
              });
              const probeCt = probeRes.headers.get('content-type') || '';
              if (/m3u8|vnd\.apple\.mpegurl/.test(probeCt)) streamKind = 'hls';
            } catch {
              /* probe failure falls back to mp4 guess */
            } finally {
              clearTimeout(probeTimer);
            }
          }
          return json(res, 200, {
            detail,
            type: resolved.type,
            label: resolved.label || '',
            url: resolved.url,
            streamKind,
            qualities: resolved.qualities || [],
            subtitles: resolved.subtitles || [],
            referer: resolved.referer || '',
          });
        } catch (error) {
          return json(res, error.name === 'AbortError' ? 504 : 502, { error: error.name === 'AbortError' ? 'Source resolve timed out' : 'Source resolve failed' });
        } finally {
          clearTimeout(timer);
        }
      }

      // Locked-down stream proxy: only allowlist hosts, HTTPS only, streams
      // forwarded with the proper Referer for the embed source. This replaces
      // the old unrestricted /api/proxy with a strict allowlist. HLS segment
      // hosts are approved dynamically from parsed manifests so playback works
      // while arbitrary hosts stay unreachable.
      if (req.method === 'GET' && pathname === '/api/stream') {
        const target = cleanText(url.searchParams.get('u'), 2500);
        const from = cleanText(url.searchParams.get('ref'), 300);
        if (!/^https?:\/\//.test(target)) return json(res, 400, { error: 'Missing stream URL' });
        let targetHost;
        try { targetHost = new URL(target).hostname.replace(/^www\./, ''); } catch { return json(res, 400, { error: 'Invalid stream URL' }); }
        const allowed = new Set(sources.allowedHosts());
        if (!allowed.has(targetHost) && !approvedSegmentHosts.has(targetHost)) return json(res, 403, { error: 'Host not allowed' });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        const headers = { 'User-Agent': sources.UA };
        if (from) headers.Referer = from;
        // Ballerina stream URLs need browser-like Origin/Sec-Fetch headers for
        // range (seek) requests — without them the CDN returns 403 on ranges.
        if (targetHost === 'ballerinacappuccinalovestungtungtungsahur.com' || targetHost === 'c.ballerinacappuccinalovestungtungtungsahur.com') {
          headers.Origin = 'https://player.vidlove.cc';
          headers['Accept'] = '*/*';
          headers['Sec-Fetch-Dest'] = 'video';
          headers['Sec-Fetch-Mode'] = 'no-cors';
          headers['Sec-Fetch-Site'] = 'cross-site';
          if (!from) headers.Referer = 'https://player.vidlove.cc/';
        }
        try {
          // Forward the client's Range header so seeking works through the proxy.
          if (req.headers.range) headers.Range = req.headers.range;
          const upstream = await fetch(target, { headers, signal: controller.signal, redirect: 'follow' });
          const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
          if (upstream.status === 200 && /m3u8|vnd\.apple\.mpegurl/.test(contentType)) {
            // Manifest: fetch body, rewrite segment URLs through the proxy.
            const manifest = await upstream.text();
            const base = new URL(target);
            const now = Date.now();
            const rewritten = manifest
              .split('\n')
              .map((line) => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return line;
                let segmentUrl;
                try { segmentUrl = new URL(trimmed, base).toString(); } catch { return line; }
                if (!/^https?:\/\//.test(segmentUrl)) return line;
                let segHost;
                try { segHost = new URL(segmentUrl).hostname.replace(/^www\./, ''); } catch { return line; }
                // Approve this segment host so subsequent segment requests pass.
                approvedSegmentHosts.set(segHost, now + 10 * 60 * 1000);
                return `/api/stream?u=${encodeURIComponent(segmentUrl)}&ref=${encodeURIComponent(from || '')}`;
              })
              .join('\n');
            res.writeHead(200, {
              'Content-Type': 'application/vnd.apple.mpegurl',
              'Content-Length': Buffer.byteLength(rewritten),
              'Cache-Control': 'no-store',
              'Access-Control-Allow-Origin': '*',
            });
            return res.end(rewritten);
          }
          // Non-manifest: pipe through only media/subtitle types (video segments,
          // subtitles, audio). HTML/JS responses from embed hosts are never
          // proxied — they are client-side SPA shells, not media.
          const isMedia = /^(video|audio)\/|application\/octet-stream|text\/vtt|application\/x-subrip|application\/vnd\.apple\.mpegurl|mpegurl|x-mpegurl|text\/plain/.test(contentType);
          if (!upstream.body) return json(res, 502, { error: 'Upstream body missing' });
          if (!isMedia) return json(res, 415, { error: 'Not a media stream' });
          res.writeHead(upstream.status === 206 ? 206 : 200, {
            'Content-Type': contentType,
            'Content-Length': upstream.headers.get('content-length') || undefined,
            'Content-Range': upstream.headers.get('content-range') || undefined,
            'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          });
          // fetch() bodies are web ReadableStreams — convert to a Node stream
          // for .pipe(). (Missing this used to throw after writeHead and tear
          // the connection down with an "empty reply".)
          return Readable.fromWeb(upstream.body).pipe(res);
        } catch (error) {
          if (res.headersSent) return res.destroy();
          return json(res, error.name === 'AbortError' ? 504 : 502, { error: error.name === 'AbortError' ? 'Stream timed out' : 'Stream failed' });
        } finally {
          clearTimeout(timer);
        }
      }

      if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
      if (!serveStatic(req, res, publicDir, pathname)) return json(res, 404, { error: 'Not found' });
    } catch (error) {
      console.error('[http]', error);
      if (!res.headersSent) json(res, error.statusCode || 500, { error: error.statusCode ? error.message : 'Internal server error' });
      else res.destroy();
    }
  });

  const websocket = attachRoomProtocol(server, store, config);
  const cleanup = setInterval(() => store.cleanup(), 5 * 60 * 1000);
  cleanup.unref();
  server.on('close', () => {
    clearInterval(cleanup);
    clearInterval(approveSweeper);
    websocket.close();
  });

  return { server, store, config, websocket };
}

if (require.main === module) {
  const { server, config } = createServer();
  server.listen(config.port, '0.0.0.0', () => console.log(`Watch Together running on http://0.0.0.0:${config.port}`));
}

module.exports = { createServer, normalizeMedia, roomPosition, WebSocketConnection, encodeFrame };
