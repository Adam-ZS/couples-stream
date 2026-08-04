'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, normalizeMedia, roomPosition } = require('../server');

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 2_000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(new SocketInbox(ws));
    }, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
  });
}

class SocketInbox {
  constructor(ws) {
    this.ws = ws;
    this.queue = [];
    this.waiters = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.queue.push(message);
      }
    });
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  next(type, timeout = 2_000) {
    const predicate = (message) => message.type === type;
    const existing = this.queue.findIndex(predicate);
    if (existing >= 0) return Promise.resolve(this.queue.splice(existing, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  close() {
    this.ws.close();
  }
}

test('media validation accepts lawful source types and blocks unsafe URLs', () => {
  assert.equal(normalizeMedia({ kind: 'url', url: 'http://evil.example/video.mp4' }), null);
  assert.equal(normalizeMedia({ kind: 'youtube', youtubeId: 'too-short' }), null);
  assert.deepEqual(
    normalizeMedia({ id: 'one', kind: 'youtube', youtubeId: 'dQw4w9WgXcQ', title: 'Video' }),
    { id: 'one', kind: 'youtube', youtubeId: 'dQw4w9WgXcQ', title: 'Video', poster: '' },
  );
  assert.equal(normalizeMedia({ kind: 'url', url: 'https://example.com/video.mp4' }).url, 'https://example.com/video.mp4');
  // embed kind: allowlisted hosts pass, arbitrary hosts are blocked
  assert.equal(normalizeMedia({ kind: 'embed', url: 'https://vidcore.net/movie/27205' }).embedHost, 'vidcore.net');
  assert.equal(normalizeMedia({ kind: 'embed', url: 'https://ramoflix.net/inception' }).embedHost, 'ramoflix.net');
  assert.equal(normalizeMedia({ kind: 'embed', url: 'https://evil.example/embed' }), null);
  assert.equal(normalizeMedia({ kind: 'embed', url: 'http://vidcore.net/movie/1' }), null);
});

test('room position advances only while playing', () => {
  assert.equal(roomPosition({ paused: true, position: 12, rate: 1, updatedAt: 1_000 }, 6_000), 12);
  assert.equal(roomPosition({ paused: false, position: 12, rate: 1.5, updatedAt: 1_000 }, 5_000), 18);
});

test('HTTP and WebSocket room flow is synchronized and permissioned', async (t) => {
  const instance = createServer({ heartbeatMs: 10_000 });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => instance.server.close(resolve));
  });

  const address = instance.server.address();
  const httpBase = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;

  const health = await (await fetch(`${httpBase}/api/health`)).json();
  assert.equal(health.ok, true);

  const roomResponse = await fetch(`${httpBase}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'secret' }),
  });
  assert.equal(roomResponse.status, 201);
  const room = await roomResponse.json();
  assert.match(room.roomId, /^[A-Za-z0-9_-]{12,32}$/);

  const removedProxy = await fetch(`${httpBase}/api/proxy?url=https://example.com/video.mp4`);
  assert.equal(removedProxy.status, 404);

  const blockedProxy = await fetch(`${httpBase}/api/stream?u=https://evil.example/x.m3u8`);
  assert.equal(blockedProxy.status, 403);

  const nonMediaProxy = await fetch(`${httpBase}/api/stream?u=https://vidcore.net/nope`);
  assert.equal(nonMediaProxy.status, 415);

  const wrong = await openSocket(wsBase);
  wrong.send({ type: 'join', roomId: room.roomId, name: 'Wrong', password: 'bad', clientId: 'wrong_client_123' });
  assert.equal((await wrong.next('error')).code, 'WRONG_PASSWORD');
  wrong.close();

  const host = await openSocket(wsBase);
  host.send({
    type: 'join', roomId: room.roomId, name: 'Host', password: 'secret',
    clientId: 'host_client_123', hostToken: room.hostToken,
  });
  const hostWelcome = await host.next('welcome');
  assert.equal(hostWelcome.isHost, true);

  const guest = await openSocket(wsBase);
  guest.send({ type: 'join', roomId: room.roomId, name: 'Guest', password: 'secret', clientId: 'guest_client_123' });
  const guestWelcome = await guest.next('welcome');
  assert.equal(guestWelcome.isHost, false);

  host.send({ type: 'settings:update', controlPolicy: 'host' });
  assert.equal((await host.next('settings')).settings.controlPolicy, 'host');
  assert.equal((await guest.next('settings')).settings.controlPolicy, 'host');

  guest.send({ type: 'media:set', media: { id: 'guest-media', kind: 'url', title: 'No', url: 'https://example.com/no.mp4' } });
  assert.equal((await guest.next('error')).code, 'FORBIDDEN');

  host.send({ type: 'media:set', media: { id: 'demo-media', kind: 'url', title: 'Demo', url: 'https://example.com/demo.mp4' } });
  const hostMedia = await host.next('media');
  const guestMedia = await guest.next('media');
  assert.equal(hostMedia.media.id, 'demo-media');
  assert.equal(guestMedia.media.title, 'Demo');

  host.send({ type: 'playback:update', paused: false, position: 42, rate: 1.25 });
  const playback = await guest.next('playback');
  assert.equal(playback.playback.paused, false);
  assert.equal(playback.playback.position, 42);
  assert.equal(playback.playback.rate, 1.25);

  guest.send({ type: 'chat:send', message: 'hello room' });
  const chat = await host.next('chat');
  assert.equal(chat.chat.name, 'Guest');
  assert.equal(chat.chat.message, 'hello room');

  host.close();
  guest.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
});
