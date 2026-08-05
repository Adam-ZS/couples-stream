'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const els = {
  landing: $('#landing'), app: $('#app'), entryForm: $('#entryForm'), nameInput: $('#nameInput'), roomInput: $('#roomInput'),
  passwordInput: $('#passwordInput'), roomField: $('#roomField'), createRoomBtn: $('#createRoomBtn'), joinRoomBtn: $('#joinRoomBtn'),
  joinNotice: $('#joinNotice'), invitedRoom: $('#invitedRoom'), roomCopyBtn: $('#roomCopyBtn'), roomLabel: $('#roomLabel'),
  connectionBadge: $('#connectionBadge'), addMediaBtn: $('#addMediaBtn'), emptyAddBtn: $('#emptyAddBtn'), playerStage: $('#playerStage'),
  emptyPlayer: $('#emptyPlayer'), video: $('#videoPlayer'), youtubeSurface: $('#youtubeSurface'), youtubeMount: $('#youtubeMount'),
  embedSurface: $('#embedSurface'), embedFrame: $('#embedFrame'),
  localFileGate: $('#localFileGate'), localFileDescription: $('#localFileDescription'), matchingFileInput: $('#matchingFileInput'),
  playerOverlay: $('#playerOverlay'), overlayText: $('#overlayText'), controls: $('#controls'), playBtn: $('#playBtn'),
  currentTime: $('#currentTime'), durationTime: $('#durationTime'), seekBar: $('#seekBar'), rateSelect: $('#rateSelect'),
  syncNowBtn: $('#syncNowBtn'), fullscreenBtn: $('#fullscreenBtn'), mediaTitle: $('#mediaTitle'), mediaKind: $('#mediaKind'),
  mediaPoster: $('#mediaPoster'), readinessText: $('#readinessText'), peopleCount: $('#peopleCount'), chatPanel: $('#chatPanel'),
  peoplePanel: $('#peoplePanel'), settingsPanel: $('#settingsPanel'), chatMessages: $('#chatMessages'), chatForm: $('#chatForm'),
  chatInput: $('#chatInput'), peopleList: $('#peopleList'), controlPolicySelect: $('#controlPolicySelect'),
  copyLinkSettingsBtn: $('#copyLinkSettingsBtn'), leaveRoomBtn: $('#leaveRoomBtn'), mediaDialog: $('#mediaDialog'),
  urlInput: $('#urlInput'), urlTitleInput: $('#urlTitleInput'), addUrlBtn: $('#addUrlBtn'), addDemoBtn: $('#addDemoBtn'),
  youtubeInput: $('#youtubeInput'), youtubeTitleInput: $('#youtubeTitleInput'), addYoutubeBtn: $('#addYoutubeBtn'),
  localFileInput: $('#localFileInput'), discoverInput: $('#discoverInput'), discoverHelp: $('#discoverHelp'),
  discoverResults: $('#discoverResults'), sourcesInput: $('#sourcesInput'), sourcesResults: $('#sourcesResults'), toast: $('#toast'),
};

const persistedClientId = localStorage.getItem('wt_client_id');
const state = {
  roomId: '',
  password: '',
  hostToken: '',
  name: localStorage.getItem('wt_name') || '',
  clientId: persistedClientId && /^[A-Za-z0-9_-]{8,64}$/.test(persistedClientId) ? persistedClientId : randomId(),
  selfId: '',
  isHost: false,
  settings: { controlPolicy: 'everyone' },
  participants: [],
  media: null,
  playback: null,
  socket: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  intentionalClose: false,
  kicked: false,
  clockOffset: 0,
  clockSamples: [],
  pingTimer: null,
  playerReady: false,
  pendingPlayback: null,
  applyingRemoteUntil: 0,
  userSeeking: false,
  hls: null,
  ytPlayer: null,
  ytReady: false,
  ytApiPromise: null,
  localFiles: new Map(),
  selectedMetadata: null,
  discoverTimer: null,
  toastTimer: null,
  config: { tmdbEnabled: false },
};

localStorage.setItem('wt_client_id', state.clientId);
els.nameInput.value = state.name;

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function roomFromUrl() {
  return new URL(location.href).searchParams.get('room') || '';
}

function hostTokenKey(roomId) {
  return `wt_host_${roomId}`;
}

function inviteUrl() {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('room', state.roomId);
  return url.toString();
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3200);
}

function setConnection(mode, label) {
  els.connectionBadge.className = `connection-badge ${mode}`;
  els.connectionBadge.textContent = label;
}

function canControl() {
  return state.settings.controlPolicy === 'everyone' || state.isHost;
}

function updateControlAccess() {
  const allowed = canControl();
  els.addMediaBtn.disabled = !allowed;
  els.emptyAddBtn.disabled = !allowed;
  els.controlPolicySelect.disabled = !state.isHost;
  els.controlPolicySelect.value = state.settings.controlPolicy;
  els.controls.classList.toggle('disabled', !state.playerReady || !allowed);
}

function send(payload) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

async function copyInvite() {
  const text = inviteUrl();
  try {
    await navigator.clipboard.writeText(text);
    showToast('Invite link copied');
  } catch {
    window.prompt('Copy this invite link:', text);
  }
}

function setRoomInUrl(roomId) {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('room', roomId);
  history.replaceState({}, '', url);
}

async function createRoom() {
  const name = els.nameInput.value.trim();
  if (!name) return showToast('Enter your display name');
  els.createRoomBtn.disabled = true;
  try {
    const response = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: els.passwordInput.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not create room');
    localStorage.setItem(hostTokenKey(data.roomId), data.hostToken);
    enterRoom({ roomId: data.roomId, name, password: els.passwordInput.value, hostToken: data.hostToken });
  } catch (error) {
    showToast(error.message);
  } finally {
    els.createRoomBtn.disabled = false;
  }
}

function joinRoom() {
  const name = els.nameInput.value.trim();
  const roomId = (roomFromUrl() || els.roomInput.value).trim();
  if (!name) return showToast('Enter your display name');
  if (!/^[A-Za-z0-9_-]{12,32}$/.test(roomId)) return showToast('Enter a valid room code');
  enterRoom({
    roomId,
    name,
    password: els.passwordInput.value,
    hostToken: localStorage.getItem(hostTokenKey(roomId)) || '',
  });
}

function enterRoom({ roomId, name, password, hostToken }) {
  state.roomId = roomId;
  state.name = name.slice(0, 32);
  state.password = password || '';
  state.hostToken = hostToken || '';
  state.intentionalClose = false;
  state.kicked = false;
  localStorage.setItem('wt_name', state.name);
  setRoomInUrl(roomId);
  els.roomLabel.textContent = roomId;
  els.landing.classList.add('hidden');
  els.app.classList.remove('hidden');
  connectSocket();
}

function leaveRoom({ preserveUrl = false } = {}) {
  state.intentionalClose = true;
  clearTimeout(state.reconnectTimer);
  clearInterval(state.pingTimer);
  state.socket?.close(1000, 'Left room');
  state.socket = null;
  destroyPlayer();
  state.roomId = '';
  state.media = null;
  state.playback = null;
  state.participants = [];
  state.isHost = false;
  els.app.classList.add('hidden');
  els.landing.classList.remove('hidden');
  if (!preserveUrl) {
    const url = new URL(location.href);
    url.search = '';
    history.replaceState({}, '', url);
  }
}

function connectSocket() {
  clearTimeout(state.reconnectTimer);
  if (!state.roomId || state.intentionalClose) return;
  if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) return;

  setConnection('connecting', state.reconnectAttempt ? 'Reconnecting…' : 'Connecting…');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}`);
  state.socket = socket;

  socket.addEventListener('open', () => {
    state.reconnectAttempt = 0;
    send({
      type: 'join', roomId: state.roomId, name: state.name, password: state.password,
      hostToken: state.hostToken, clientId: state.clientId,
    });
    clearInterval(state.pingTimer);
    state.pingTimer = setInterval(() => send({ type: 'ping', clientTime: Date.now() }), 15_000);
  });

  socket.addEventListener('message', (event) => {
    try { handleSocketMessage(JSON.parse(event.data)); } catch (error) { console.warn('Bad server message', error); }
  });

  socket.addEventListener('close', () => {
    clearInterval(state.pingTimer);
    if (state.intentionalClose || state.kicked) return;
    setConnection('disconnected', 'Disconnected');
    state.reconnectAttempt += 1;
    const delay = Math.min(10_000, 500 * (2 ** Math.min(state.reconnectAttempt, 5))) + Math.random() * 300;
    state.reconnectTimer = setTimeout(connectSocket, delay);
  });

  socket.addEventListener('error', () => setConnection('disconnected', 'Connection error'));
}

function recordServerTime(serverTime, clientSentAt = 0) {
  if (!Number.isFinite(serverTime)) return;
  const now = Date.now();
  const midpoint = clientSentAt ? clientSentAt + ((now - clientSentAt) / 2) : now;
  const sample = serverTime - midpoint;
  state.clockSamples.push(sample);
  if (state.clockSamples.length > 8) state.clockSamples.shift();
  state.clockOffset = state.clockSamples.reduce((sum, value) => sum + value, 0) / state.clockSamples.length;
}

function estimatedServerNow() {
  return Date.now() + state.clockOffset;
}

function handleSocketMessage(message) {
  if (message.serverTime) recordServerTime(message.serverTime, message.clientTime || 0);
  switch (message.type) {
    case 'welcome':
      state.selfId = message.selfId;
      state.clientId = message.selfId;
      state.isHost = Boolean(message.isHost);
      localStorage.setItem('wt_client_id', state.clientId);
      setConnection('connected', 'Connected');
      applySnapshot(message.snapshot);
      break;
    case 'snapshot':
      applySnapshot(message.snapshot);
      break;
    case 'participants':
      state.participants = message.participants || [];
      state.isHost = Boolean(state.participants.find((person) => person.id === state.selfId)?.isHost);
      renderParticipants();
      updateControlAccess();
      break;
    case 'media':
      loadMedia(message.media, message.playback);
      addSystemMessage(`${message.by || 'Someone'} changed the media`);
      break;
    case 'playback':
      state.playback = message.playback;
      applyPlayback(message.playback, false);
      break;
    case 'settings':
      state.settings = message.settings || state.settings;
      updateControlAccess();
      showToast(`Playback control: ${state.settings.controlPolicy === 'host' ? 'host only' : 'everyone'}`);
      break;
    case 'chat':
      appendChat(message.chat);
      break;
    case 'system':
      addSystemMessage(message.message);
      break;
    case 'host:granted':
      state.isHost = true;
      showToast('You are now the room host');
      updateControlAccess();
      send({ type: 'state:request' });
      break;
    case 'pong':
      recordServerTime(message.serverTime, message.clientTime);
      break;
    case 'kicked':
      state.kicked = true;
      showToast(message.message || 'You were removed from the room');
      leaveRoom();
      break;
    case 'error':
      handleServerError(message);
      break;
    default:
      break;
  }
}

function handleServerError(message) {
  const fatal = ['ROOM_NOT_FOUND', 'WRONG_PASSWORD', 'INVALID_ROOM', 'ROOM_FULL'];
  showToast(message.message || 'Room error');
  if (fatal.includes(message.code)) {
    state.intentionalClose = true;
    state.socket?.close();
    leaveRoom({ preserveUrl: message.code !== 'ROOM_NOT_FOUND' });
    if (message.code === 'WRONG_PASSWORD') {
      els.passwordInput.focus();
      els.joinNotice.classList.remove('hidden');
      els.invitedRoom.textContent = `${state.roomId || roomFromUrl()} — password required`;
    }
  }
}

function applySnapshot(snapshot) {
  if (!snapshot) return;
  recordServerTime(snapshot.serverTime);
  state.settings = snapshot.settings || { controlPolicy: 'everyone' };
  state.participants = snapshot.participants || [];
  state.isHost = Boolean(state.participants.find((person) => person.id === state.selfId)?.isHost) || state.isHost;
  renderChatHistory(snapshot.chatHistory || []);
  renderParticipants();
  updateControlAccess();
  if (snapshot.media) loadMedia(snapshot.media, snapshot.playback);
  else showEmptyPlayer();
}

function renderChatHistory(history) {
  els.chatMessages.replaceChildren();
  history.forEach(appendChat);
}

function appendChat(chat) {
  if (!chat) return;
  const item = document.createElement('article');
  item.className = 'chat-item';
  const meta = document.createElement('div');
  meta.className = 'chat-meta';
  const name = document.createElement('span');
  name.className = 'chat-name';
  name.textContent = chat.clientId === state.selfId ? `${chat.name} · you` : chat.name;
  const time = document.createElement('time');
  time.className = 'chat-time';
  time.textContent = new Date(chat.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const text = document.createElement('div');
  text.className = 'chat-text';
  text.textContent = chat.message;
  meta.append(name, time);
  item.append(meta, text);
  els.chatMessages.append(item);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function addSystemMessage(message) {
  if (!message) return;
  const item = document.createElement('div');
  item.className = 'system-message';
  item.textContent = message;
  els.chatMessages.append(item);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function renderParticipants() {
  els.peopleList.replaceChildren();
  els.peopleCount.textContent = String(state.participants.length);
  const readyCount = state.participants.filter((person) => person.mediaReady).length;
  els.readinessText.textContent = state.media ? `${readyCount}/${state.participants.length} ready` : `${state.participants.length} in room`;

  state.participants.forEach((person) => {
    const row = document.createElement('div');
    row.className = 'person';
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = (person.name || '?').slice(0, 2).toUpperCase();
    const copy = document.createElement('div');
    copy.className = 'person-copy';
    const strong = document.createElement('strong');
    strong.textContent = `${person.name}${person.id === state.selfId ? ' · you' : ''}`;
    const status = document.createElement('span');
    status.textContent = `${person.isHost ? 'Host · ' : ''}${state.media ? (person.mediaReady ? 'Ready' : 'Loading') : 'Connected'}`;
    copy.append(strong, status);
    row.append(avatar, copy);
    if (state.isHost && person.id !== state.selfId) {
      const kick = document.createElement('button');
      kick.className = 'kick-btn';
      kick.textContent = 'Remove';
      kick.addEventListener('click', () => {
        if (confirm(`Remove ${person.name} from the room?`)) send({ type: 'participant:kick', clientId: person.id });
      });
      row.append(kick);
    }
    els.peopleList.append(row);
  });
  updateControlAccess();
}

function showEmptyPlayer() {
  state.media = null;
  state.playback = null;
  destroyPlayer();
  els.emptyPlayer.classList.remove('hidden');
  els.mediaTitle.textContent = 'Nothing playing';
  els.mediaKind.textContent = 'Add media to begin';
  els.mediaPoster.classList.add('hidden');
  renderParticipants();
}

function showLoading(message = 'Loading media…') {
  els.overlayText.textContent = message;
  els.playerOverlay.classList.remove('hidden');
}

function hideLoading() {
  els.playerOverlay.classList.add('hidden');
}

function destroyPlayer() {
  state.playerReady = false;
  state.pendingPlayback = null;
  state.hls?.destroy();
  state.hls = null;
  if (state.ytPlayer) {
    try { state.ytPlayer.destroy(); } catch {}
  }
  state.ytPlayer = null;
  state.ytReady = false;
  els.youtubeSurface.replaceChildren();
  const youtubeMount = document.createElement('div');
  youtubeMount.id = 'youtubeMount';
  els.youtubeSurface.append(youtubeMount);
  els.video.pause();
  els.video.removeAttribute('src');
  els.video.load();
  els.video.classList.add('hidden');
  els.youtubeSurface.classList.add('hidden');
  els.embedSurface.classList.add('hidden');
  els.embedFrame.removeAttribute('src');
  els.localFileGate.classList.add('hidden');
  els.controls.classList.add('disabled');
}

async function loadMedia(media, playback) {
  if (!media) return showEmptyPlayer();
  const sameMedia = state.media?.id === media.id;
  state.media = media;
  state.playback = playback || state.playback;
  updateMediaInfo(media);
  if (sameMedia && state.playerReady) {
    if (playback) applyPlayback(playback, true);
    return;
  }

  destroyPlayer();
  els.emptyPlayer.classList.add('hidden');
  showLoading();
  send({ type: 'media:ready', ready: false });

  try {
    if (media.kind === 'url' || media.kind === 'demo') {
      await loadHtml5(media.url, { hls: !!media.hls });
    } else if (media.kind === 'youtube') {
      await loadYouTube(media.youtubeId);
    } else if (media.kind === 'embed') {
      loadEmbed(media.url);
    } else if (media.kind === 'local') {
      const local = state.localFiles.get(media.fingerprint);
      if (local) await loadHtml5(local.url);
      else {
        hideLoading();
        els.localFileDescription.textContent = `${media.fileName} · ${formatBytes(media.fileSize)}. Select the same file on this device.`;
        els.localFileGate.classList.remove('hidden');
        return;
      }
    }
    markPlayerReady();
    if (playback) applyPlayback(playback, true);
  } catch (error) {
    hideLoading();
    showToast(error.message || 'Could not load media');
    els.mediaKind.textContent = 'Media failed to load';
  }
}

function updateMediaInfo(media) {
  els.mediaTitle.textContent = media.title || 'Untitled media';
  const kinds = { url: 'Direct video URL', youtube: 'YouTube', local: 'Local file on each device', demo: 'Public demo video', embed: 'Free source embed' };
  els.mediaKind.textContent = kinds[media.kind] || media.kind;
  if (media.poster) {
    els.mediaPoster.src = media.poster;
    els.mediaPoster.alt = '';
    els.mediaPoster.classList.remove('hidden');
  } else {
    els.mediaPoster.classList.add('hidden');
    els.mediaPoster.removeAttribute('src');
  }
}

function markPlayerReady() {
  state.playerReady = true;
  hideLoading();
  els.localFileGate.classList.add('hidden');
  send({ type: 'media:ready', ready: true });
  updateControlAccess();
  if (state.pendingPlayback) {
    const pending = state.pendingPlayback;
    state.pendingPlayback = null;
    applyPlayback(pending, true);
  }
}

function loadEmbed(url) {
  els.embedSurface.classList.remove('hidden');
  els.embedFrame.src = url;
  // Mark ready immediately: iframe content cannot be controlled by the room,
  // so playback sync for embeds is best-effort (everyone watches the same source).
  markPlayerReady();
}

function loadHtml5(url, { hls = false } = {}) {
  return new Promise((resolve, reject) => {
    els.video.classList.remove('hidden');
    const pathName = (() => { try { return new URL(url, location.href).pathname.toLowerCase(); } catch { return ''; } })();
    const isHls = hls || pathName.endsWith('.m3u8');
    let settled = false;
    const finish = () => { if (!settled) { settled = true; cleanup(); resolve(); } };
    const fail = () => { if (!settled) { settled = true; cleanup(); reject(new Error('The video could not be loaded. Check the URL and browser access.')); } };
    const cleanup = () => {
      els.video.removeEventListener('loadedmetadata', finish);
      els.video.removeEventListener('canplay', finish);
      els.video.removeEventListener('error', fail);
    };
    els.video.addEventListener('loadedmetadata', finish, { once: true });
    els.video.addEventListener('canplay', finish, { once: true });
    els.video.addEventListener('error', fail, { once: true });

    if (isHls && window.Hls?.isSupported()) {
      state.hls = new window.Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 90 });
      state.hls.on(window.Hls.Events.ERROR, (event, data) => {
        if (data.fatal) fail();
      });
      state.hls.loadSource(url);
      state.hls.attachMedia(els.video);
    } else {
      els.video.src = url;
      els.video.load();
    }
    setTimeout(() => { if (!settled) fail(); }, 20_000);
  });
}

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (state.ytApiPromise) return state.ytApiPromise;
  state.ytApiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') previous();
      resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => reject(new Error('Could not load the YouTube player'));
    document.head.append(script);
    setTimeout(() => reject(new Error('YouTube player timed out')), 15_000);
  });
  return state.ytApiPromise;
}

async function loadYouTube(youtubeId) {
  await loadYouTubeApi();
  els.youtubeSurface.classList.remove('hidden');
  return new Promise((resolve, reject) => {
    state.ytPlayer = new window.YT.Player('youtubeMount', {
      videoId: youtubeId,
      width: '100%', height: '100%',
      playerVars: { autoplay: 0, controls: 0, disablekb: 1, modestbranding: 1, playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady: () => { state.ytReady = true; resolve(); },
        onError: () => reject(new Error('This YouTube video is unavailable for embedding')),
        onStateChange: (event) => {
          if (!state.playerReady || Date.now() < state.applyingRemoteUntil) return;
          if (event.data === window.YT.PlayerState.PLAYING) sendPlayback(false);
          if (event.data === window.YT.PlayerState.PAUSED || event.data === window.YT.PlayerState.ENDED) sendPlayback(true);
        },
        onPlaybackRateChange: () => {
          if (state.playerReady && Date.now() >= state.applyingRemoteUntil) sendPlayback(playerPaused());
        },
      },
    });
  });
}

function targetPosition(playback) {
  if (!playback) return 0;
  if (playback.paused) return playback.position || 0;
  return Math.max(0, (playback.position || 0) + ((estimatedServerNow() - playback.updatedAt) / 1000) * (playback.rate || 1));
}

function playerTime() {
  if (state.media?.kind === 'youtube') {
    try { return Number(state.ytPlayer?.getCurrentTime()) || 0; } catch { return 0; }
  }
  return Number(els.video.currentTime) || 0;
}

function playerDuration() {
  if (state.media?.kind === 'youtube') {
    try { return Number(state.ytPlayer?.getDuration()) || 0; } catch { return 0; }
  }
  return Number(els.video.duration) || 0;
}

function playerPaused() {
  if (state.media?.kind === 'youtube') {
    try { return state.ytPlayer?.getPlayerState() !== window.YT.PlayerState.PLAYING; } catch { return true; }
  }
  return els.video.paused;
}

function playerSeek(seconds) {
  const target = Math.max(0, Number(seconds) || 0);
  if (state.media?.kind === 'youtube') state.ytPlayer?.seekTo(target, true);
  else els.video.currentTime = target;
}

function playerSetRate(rate) {
  const value = Number(rate) || 1;
  if (state.media?.kind === 'youtube') {
    try { state.ytPlayer?.setPlaybackRate(value); } catch {}
  } else {
    els.video.playbackRate = value;
  }
  els.rateSelect.value = String(value);
}

async function playerPlay() {
  if (state.media?.kind === 'youtube') return state.ytPlayer?.playVideo();
  return els.video.play();
}

function playerPause() {
  if (state.media?.kind === 'youtube') state.ytPlayer?.pauseVideo();
  else els.video.pause();
}

function applyPlayback(playback, force = false) {
  state.playback = playback;
  if (!state.playerReady) {
    state.pendingPlayback = playback;
    return;
  }
  const target = targetPosition(playback);
  const drift = Math.abs(playerTime() - target);
  state.applyingRemoteUntil = Date.now() + 900;
  playerSetRate(playback.rate || 1);
  if (force || drift > 0.45) playerSeek(target);
  if (playback.paused) {
    playerPause();
  } else {
    Promise.resolve(playerPlay()).catch(() => showToast('Tap play once to allow synchronized playback'));
  }
  updatePlayButton();
}

function sendPlayback(paused = playerPaused()) {
  if (!state.playerReady || !canControl() || Date.now() < state.applyingRemoteUntil) return;
  send({ type: 'playback:update', paused, position: playerTime(), rate: Number(els.rateSelect.value) || 1 });
}

function updatePlayButton() {
  els.playBtn.textContent = playerPaused() ? '▶' : '❚❚';
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!bytes) return 'unknown size';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function parseYouTubeId(value) {
  const input = String(value || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0];
    if (url.hostname.endsWith('youtube.com')) {
      if (url.pathname === '/watch') return url.searchParams.get('v') || '';
      const match = url.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})/);
      return match?.[1] || '';
    }
  } catch {}
  return '';
}

function normalizeDirectUrl(value) {
  try {
    const url = new URL(String(value).trim());
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !local) return '';
    return url.toString();
  } catch { return ''; }
}

function shareMedia(media) {
  if (!canControl()) return showToast('Only the host can change media');
  send({ type: 'media:set', media });
  els.mediaDialog.close();
}

function resetMediaForm() {
  state.selectedMetadata = null;
  els.urlInput.value = '';
  els.urlTitleInput.value = '';
  els.youtubeInput.value = '';
  els.youtubeTitleInput.value = '';
}

function openMediaDialog() {
  if (!canControl()) return showToast('Only the host can change media');
  if (typeof els.mediaDialog.showModal === 'function') els.mediaDialog.showModal();
  else els.mediaDialog.setAttribute('open', '');
}

async function fileFingerprint(file) {
  const chunkSize = 64 * 1024;
  const first = await file.slice(0, Math.min(chunkSize, file.size)).arrayBuffer();
  const lastStart = Math.max(0, file.size - chunkSize);
  const last = await file.slice(lastStart, file.size).arrayBuffer();
  const meta = new TextEncoder().encode(`${file.name}|${file.size}|${file.lastModified}|${file.type}`);
  const bytes = new Uint8Array(meta.length + first.byteLength + last.byteLength);
  bytes.set(meta, 0);
  bytes.set(new Uint8Array(first), meta.length);
  bytes.set(new Uint8Array(last), meta.length + first.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function registerLocalFile(file, { broadcast = false } = {}) {
  if (!file) return;
  showLoading('Checking local file…');
  try {
    const fingerprint = await fileFingerprint(file);
    const existing = state.localFiles.get(fingerprint);
    if (existing) URL.revokeObjectURL(existing.url);
    const url = URL.createObjectURL(file);
    state.localFiles.set(fingerprint, { file, url });

    if (broadcast) {
      const title = file.name.replace(/\.[^.]+$/, '') || file.name;
      shareMedia({ id: randomId(), kind: 'local', title, fingerprint, fileName: file.name, fileSize: file.size });
    } else if (state.media?.kind === 'local') {
      if (fingerprint !== state.media.fingerprint) {
        URL.revokeObjectURL(url);
        state.localFiles.delete(fingerprint);
        hideLoading();
        return showToast('That file does not match the room media');
      }
      await loadMedia(state.media, state.playback);
    }
  } catch (error) {
    hideLoading();
    showToast(error.message || 'Could not read the file');
  }
}

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (response.ok) state.config = await response.json();
  } catch {}
  if (!state.config.tmdbEnabled) {
    els.discoverHelp.textContent = 'Metadata search is disabled. Add TMDB_BEARER_TOKEN or TMDB_API_KEY on the server to enable it.';
    els.discoverInput.disabled = true;
  }
}

async function discover(query) {
  els.discoverResults.replaceChildren();
  if (!state.config.tmdbEnabled || query.length < 2) return;
  const loading = document.createElement('p');
  loading.className = 'input-help';
  loading.textContent = 'Searching…';
  els.discoverResults.append(loading);
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Search failed');
    renderDiscoverResults(data.results || []);
  } catch (error) {
    els.discoverResults.replaceChildren();
    const message = document.createElement('p');
    message.className = 'input-help';
    message.textContent = error.message;
    els.discoverResults.append(message);
  }
}

function renderDiscoverResults(results) {
  els.discoverResults.replaceChildren();
  if (!results.length) {
    const empty = document.createElement('p');
    empty.className = 'input-help';
    empty.textContent = 'No results found.';
    els.discoverResults.append(empty);
    return;
  }
  results.forEach((result) => {
    const card = document.createElement('article');
    card.className = 'discover-card';
    if (result.poster) {
      const image = document.createElement('img');
      image.src = result.poster;
      image.alt = '';
      image.loading = 'lazy';
      card.append(image);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'poster-placeholder';
      card.append(placeholder);
    }
    const copy = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = `${result.title}${result.year ? ` (${result.year})` : ''}`;
    const overview = document.createElement('p');
    overview.textContent = result.overview || 'No overview available.';
    copy.append(title, overview);
    const actions = document.createElement('div');
    actions.className = 'discover-actions';
    const use = document.createElement('button');
    use.type = 'button';
    use.textContent = 'Use title';
    use.addEventListener('click', () => {
      state.selectedMetadata = result;
      els.urlTitleInput.value = result.title;
      els.youtubeTitleInput.value = result.title;
      $$('.source-tab').find((button) => button.dataset.sourcePanel === 'url')?.click();
      els.urlInput.focus();
      showToast('Title selected — add an authorized source');
    });
    const providers = document.createElement('a');
    providers.href = `https://www.justwatch.com/us/search?q=${encodeURIComponent(result.title)}`;
    providers.target = '_blank';
    providers.rel = 'noopener noreferrer';
    providers.textContent = 'Legal options';
    actions.append(use, providers);
    card.append(copy, actions);
    els.discoverResults.append(card);
  });
}

async function searchSources(query) {
  els.sourcesResults.replaceChildren();
  if (query.length < 2) return;
  const loading = document.createElement('p');
  loading.className = 'input-help';
  loading.textContent = 'Searching free sources…';
  els.sourcesResults.append(loading);
  try {
    const response = await fetch(`/api/sources?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Source search failed');
    renderSourcesResults(data.results || []);
  } catch (error) {
    els.sourcesResults.replaceChildren();
    const message = document.createElement('p');
    message.className = 'input-help';
    message.textContent = error.message;
    els.sourcesResults.append(message);
  }
}

function renderSourcesResults(results) {
  els.sourcesResults.replaceChildren();
  if (!results.length) {
    const empty = document.createElement('p');
    empty.className = 'input-help';
    empty.textContent = 'No free sources found.';
    els.sourcesResults.append(empty);
    return;
  }
  results.forEach((result) => {
    const card = document.createElement('article');
    card.className = 'discover-card';
    const copy = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = result.title;
    const meta = document.createElement('p');
    meta.textContent = `from ${result.sourceName}`;
    copy.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'discover-actions';
    const use = document.createElement('button');
    use.type = 'button';
    use.textContent = 'Pick server…';
    use.addEventListener('click', () => loadSourceServers(result));
    actions.append(use);
    card.append(copy, actions);
    els.sourcesResults.append(card);
  });
}

async function loadSourceServers(result) {
  els.sourcesResults.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'input-help';
  loading.textContent = 'Fetching servers…';
  els.sourcesResults.append(loading);
  try {
    const response = await fetch(`/api/sources/detail?url=${encodeURIComponent(result.url)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load servers');
    renderSourceServers(result, data);
  } catch (error) {
    els.sourcesResults.replaceChildren();
    const message = document.createElement('p');
    message.className = 'input-help';
    message.textContent = error.message;
    els.sourcesResults.append(message);
  }
}

function renderSourceServers(result, detail) {
  els.sourcesResults.replaceChildren();
  const header = document.createElement('p');
  header.className = 'input-help';
  header.textContent = `${result.title} — pick a server. Direct plays in the synced player; others load as embeds.`;
  els.sourcesResults.append(header);
  (detail.embedServers || []).forEach((server) => {
    const card = document.createElement('article');
    card.className = 'discover-card';
    const copy = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = server.name;
    copy.append(title);
    const actions = document.createElement('div');
    actions.className = 'discover-actions';
    const direct = document.createElement('button');
    direct.type = 'button';
    direct.textContent = 'Play direct (synced)';
    direct.addEventListener('click', () => playSourceDirect(result, detail, server));
    const embed = document.createElement('button');
    embed.type = 'button';
    embed.textContent = 'Watch embed';
    embed.addEventListener('click', () => {
      shareMedia({
        id: randomId(), kind: 'embed', url: server.url,
        title: `${result.title} · ${server.name}`,
        poster: detail.poster || '',
      });
    });
    actions.append(direct, embed);
    card.append(copy, actions);
    els.sourcesResults.append(card);
  });
}

/** Resolve a detail page to a direct stream and share it as synced url media. */
async function playSourceDirect(result, detail, server) {
  const card = document.createElement('p');
  card.className = 'input-help';
  card.textContent = 'Resolving direct stream…';
  els.sourcesResults.replaceChildren(card);
  try {
    const response = await fetch(`/api/sources/resolve?url=${encodeURIComponent(result.url)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not resolve stream');
    if (data.type !== 'direct' || !data.url) throw new Error('No direct stream available — try Watch embed');
    const proxyUrl = `/api/stream?u=${encodeURIComponent(data.url)}&ref=${encodeURIComponent(data.referer || '')}`;
    shareMedia({
      id: randomId(), kind: 'url', url: proxyUrl,
      hls: data.streamKind === 'hls',
      title: `${result.title} · ${data.label || 'direct'}`,
      poster: detail.poster || '',
    });
    if (data.subtitles && data.subtitles.length) {
      const track = data.subtitles.find((sub) => /English/i.test(sub.label)) || data.subtitles[0];
      showToast(`${data.subtitles.length} subtitles available (showing ${track.label})`);
    }
  } catch (error) {
    els.sourcesResults.replaceChildren();
    const message = document.createElement('p');
    message.className = 'input-help';
    message.textContent = error.message;
    els.sourcesResults.append(message);
  }
}

els.createRoomBtn.addEventListener('click', createRoom);
els.entryForm.addEventListener('submit', (event) => { event.preventDefault(); joinRoom(); });
els.roomCopyBtn.addEventListener('click', copyInvite);
els.copyLinkSettingsBtn.addEventListener('click', copyInvite);
els.leaveRoomBtn.addEventListener('click', () => leaveRoom());
els.addMediaBtn.addEventListener('click', openMediaDialog);
els.emptyAddBtn.addEventListener('click', openMediaDialog);

els.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = els.chatInput.value.trim();
  if (!message) return;
  if (send({ type: 'chat:send', message })) els.chatInput.value = '';
});

$$('.tab-btn').forEach((button) => button.addEventListener('click', () => {
  $$('.tab-btn').forEach((item) => item.classList.toggle('active', item === button));
  [els.chatPanel, els.peoplePanel, els.settingsPanel].forEach((panel) => panel.classList.remove('active'));
  $(`#${button.dataset.tab}Panel`).classList.add('active');
}));

$$('.source-tab').forEach((button) => button.addEventListener('click', () => {
  $$('.source-tab').forEach((item) => item.classList.toggle('active', item === button));
  $$('.source-panel').forEach((panel) => panel.classList.remove('active'));
  $(`#source-${button.dataset.sourcePanel}`).classList.add('active');
}));

els.controlPolicySelect.addEventListener('change', () => {
  if (!state.isHost) return;
  send({ type: 'settings:update', controlPolicy: els.controlPolicySelect.value });
});

els.addUrlBtn.addEventListener('click', () => {
  const url = normalizeDirectUrl(els.urlInput.value);
  if (!url) return showToast('Use a valid HTTPS video or HLS URL');
  const selected = state.selectedMetadata;
  shareMedia({
    id: randomId(), kind: 'url', url,
    title: els.urlTitleInput.value.trim() || selected?.title || 'Shared video',
    poster: selected?.poster || '',
  });
  resetMediaForm();
});

els.addDemoBtn.addEventListener('click', () => {
  shareMedia({
    id: randomId(), kind: 'demo', title: 'Big Buck Bunny · public demo',
    url: 'https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  });
  resetMediaForm();
});

els.addYoutubeBtn.addEventListener('click', () => {
  const youtubeId = parseYouTubeId(els.youtubeInput.value);
  if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeId)) return showToast('Enter a valid YouTube URL');
  const selected = state.selectedMetadata;
  shareMedia({
    id: randomId(), kind: 'youtube', youtubeId,
    title: els.youtubeTitleInput.value.trim() || selected?.title || 'YouTube video',
    poster: selected?.poster || `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
  });
  resetMediaForm();
});

els.localFileInput.addEventListener('change', () => registerLocalFile(els.localFileInput.files?.[0], { broadcast: true }));
els.matchingFileInput.addEventListener('change', () => registerLocalFile(els.matchingFileInput.files?.[0], { broadcast: false }));

els.playBtn.addEventListener('click', async () => {
  if (!canControl()) return showToast('Only the host can control playback');
  state.applyingRemoteUntil = 0;
  if (playerPaused()) {
    try { await playerPlay(); } catch { showToast('Your browser blocked playback'); }
  } else playerPause();
});

els.seekBar.addEventListener('input', () => {
  state.userSeeking = true;
  const duration = playerDuration();
  els.currentTime.textContent = formatTime((Number(els.seekBar.value) / 1000) * duration);
});

els.seekBar.addEventListener('change', () => {
  if (!canControl()) { state.userSeeking = false; return showToast('Only the host can seek'); }
  const duration = playerDuration();
  state.applyingRemoteUntil = 0;
  playerSeek((Number(els.seekBar.value) / 1000) * duration);
  state.userSeeking = false;
  setTimeout(() => sendPlayback(playerPaused()), 80);
});

els.rateSelect.addEventListener('change', () => {
  if (!canControl()) return showToast('Only the host can change speed');
  state.applyingRemoteUntil = 0;
  playerSetRate(Number(els.rateSelect.value));
  sendPlayback(playerPaused());
});

els.syncNowBtn.addEventListener('click', () => {
  if (!canControl()) return showToast('Only the host can sync the room');
  sendPlayback(playerPaused());
  showToast('Room synchronized to your position');
});

els.fullscreenBtn.addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) await els.playerStage.requestFullscreen();
    else await document.exitFullscreen();
  } catch { showToast('Fullscreen is unavailable'); }
});

els.video.addEventListener('play', () => {
  updatePlayButton();
  if (state.playerReady && Date.now() >= state.applyingRemoteUntil) sendPlayback(false);
});
els.video.addEventListener('pause', () => {
  updatePlayButton();
  if (state.playerReady && Date.now() >= state.applyingRemoteUntil) sendPlayback(true);
});
els.video.addEventListener('seeked', () => {
  if (state.playerReady && !state.userSeeking && Date.now() >= state.applyingRemoteUntil) sendPlayback(playerPaused());
});
els.video.addEventListener('ratechange', () => {
  if (state.playerReady && Date.now() >= state.applyingRemoteUntil) sendPlayback(playerPaused());
});
els.video.addEventListener('ended', () => sendPlayback(true));

els.discoverInput.addEventListener('input', () => {
  clearTimeout(state.discoverTimer);
  const query = els.discoverInput.value.trim();
  state.discoverTimer = setTimeout(() => discover(query), 350);
});

els.sourcesInput.addEventListener('input', () => {
  clearTimeout(state.sourcesTimer);
  const query = els.sourcesInput.value.trim();
  state.sourcesTimer = setTimeout(() => searchSources(query), 350);
});

window.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea, select') || !state.playerReady) return;
  if (event.code === 'Space') { event.preventDefault(); els.playBtn.click(); }
  if (event.code === 'ArrowLeft' && canControl()) { playerSeek(Math.max(0, playerTime() - 10)); sendPlayback(playerPaused()); }
  if (event.code === 'ArrowRight' && canControl()) { playerSeek(playerTime() + 10); sendPlayback(playerPaused()); }
});

window.addEventListener('beforeunload', () => {
  state.intentionalClose = true;
  for (const local of state.localFiles.values()) URL.revokeObjectURL(local.url);
});

setInterval(() => {
  if (!state.playerReady) return;
  const current = playerTime();
  const duration = playerDuration();
  if (!state.userSeeking && duration > 0) els.seekBar.value = String(Math.min(1000, Math.max(0, (current / duration) * 1000)));
  els.currentTime.textContent = formatTime(current);
  els.durationTime.textContent = formatTime(duration);
  updatePlayButton();
}, 250);

setInterval(() => {
  if (!state.playerReady || !state.playback || state.userSeeking || Date.now() < state.applyingRemoteUntil) return;
  const target = targetPosition(state.playback);
  const drift = Math.abs(playerTime() - target);
  if (drift > 1.0) {
    state.applyingRemoteUntil = Date.now() + 700;
    playerSeek(target);
  }
  if (state.playback.paused !== playerPaused()) {
    state.applyingRemoteUntil = Date.now() + 700;
    if (state.playback.paused) playerPause();
    else Promise.resolve(playerPlay()).catch(() => {});
  }
}, 2000);

(function init() {
  const invited = roomFromUrl();
  if (invited) {
    els.roomInput.value = invited;
    els.roomField.classList.add('hidden');
    els.joinNotice.classList.remove('hidden');
    els.invitedRoom.textContent = invited;
    els.joinRoomBtn.textContent = 'Join invited room';
  }
  loadConfig();
})();
