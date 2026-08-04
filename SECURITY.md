# Security and deployment notes

## Production checklist

- Run Node.js 20 or newer behind HTTPS.
- Keep `TMDB_BEARER_TOKEN` or `TMDB_API_KEY` in server environment variables.
- Do not add a generic server-side media proxy. It can create SSRF, bandwidth abuse, and access-control bypass risks.
- Keep one application instance unless room state is moved to a shared store and WebSocket messages are distributed through pub/sub.
- Put an upstream connection/request limit in front of public deployments.
- Review the allowed external domains in the Content Security Policy before adding integrations.
- Remember that shared direct media URLs are visible to room participants.

## Data retention

Room state is in memory only. Chat is capped at 200 messages per room. Empty rooms expire after 30 minutes and all rooms expire after 24 hours by default. Restarting the process clears all rooms.

## Reporting

When reporting a vulnerability, include the affected route or message type, reproduction steps, impact, and suggested mitigation. Do not include private media URLs, passwords, or host tokens in public reports.
