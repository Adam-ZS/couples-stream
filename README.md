# Watch Together Sync

A private, account-free watch-room app for synchronizing media that participants are authorized to play.

## What changed in v2

The original project mixed watch-party features with exposed credentials, scraped stream providers, an unrestricted media proxy, and browser/server torrent engines. This rebuild removes those unsafe and unreliable parts and replaces the core with an authoritative real-time room server.

### Features

- Instant room creation and shareable links
- Optional room passwords
- Direct HTTPS MP4/WebM/HLS playback
- YouTube playback through the official embedded player
- Private local-file mode: every participant selects the same file; files never upload
- Server-authoritative play, pause, seek, and speed synchronization
- Automatic clock-offset and playback-drift correction
- Reconnect with full room-state recovery
- Host-only or everyone-can-control modes
- Participant readiness indicators and host removal controls
- Built-in ephemeral chat with bounded history
- Optional TMDB movie/TV metadata search
- Responsive dark interface
- Health endpoint and Render deployment configuration
- No runtime npm dependencies

## Requirements

- Node.js 20 or newer

## Run locally

```bash
npm start
```

Then open `http://localhost:8765`.

There are no production packages to download. `npm install` is optional and only creates npm metadata.

## Tests

```bash
npm test
npm run check
```

The integration suite covers HTTP health, room creation, password validation, WebSocket joining, host permissions, media synchronization, playback synchronization, chat, and removal of the old proxy route.

## Optional TMDB search

Movie/TV discovery is metadata-only. It does not locate or fetch streams.

Create an environment variable using either option:

```bash
TMDB_BEARER_TOKEN=your_v4_read_token
# or
TMDB_API_KEY=your_v3_api_key
```

Never place a TMDB secret in browser JavaScript or commit it to Git.

## Supported media

### Direct URL

Use an HTTPS URL to a video file or HLS playlist that the browser is permitted to access. HLS playback uses a pinned Hls.js build where native HLS is unavailable. The media is loaded directly by each participant; this server does not proxy it.

### YouTube

Paste a normal YouTube, `youtu.be`, Shorts, Live, or embed URL. Playback uses YouTube's official iframe API. Some videos may block embedding or show ads.

### Local file

The person selecting media chooses a local video. Other participants choose the matching file on their own devices. A SHA-256 fingerprint derived from file metadata and small beginning/end samples is compared; the video itself never leaves the device.

## Deploy to Render

The included `render.yaml` is ready to use. Set optional TMDB variables in the Render dashboard.

Room and chat state is stored only in process memory. A free instance restart clears rooms, which is intentional for privacy. For horizontal scaling, add a shared state/pub-sub layer before running multiple instances.

## Security model

- Room host tokens are random, hashed server-side, and stored locally by the creator.
- Optional passwords are salted and hashed with scrypt.
- User text is length-limited and rendered with `textContent`.
- HTTP and WebSocket message rates and payload sizes are bounded.
- Room, participant, and chat memory are capped and expired.
- Security headers and a restrictive Content Security Policy are enabled.
- There is no general-purpose URL proxy, torrent client, stream scraper, or embedded API secret.

See [SECURITY.md](SECURITY.md) for deployment guidance.

## Authorized use

Use this app only with media you own, created, licensed, or are otherwise authorized to access. The project intentionally does not provide torrent indexing, debrid integration, scraped streaming sources, DRM bypassing, or tools for evading provider restrictions.
