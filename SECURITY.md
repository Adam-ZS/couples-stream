# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| v2.x    | ✅ Active |
| v1.x    | ❌ Migrate to v2 |
| < 1.0   | ❌ Unsupported |

## Reporting a vulnerability

Please report vulnerabilities **privately** — do not open a public issue.

- GitHub private vulnerability reporting:
  https://github.com/Adam-ZS/couples-stream/security/advisories/new
- Or email the maintainer with a GitHub advisory-style summary.

Include:
- the affected route / WebSocket message type / file,
- the Node version and deployment setup,
- a minimal reproduction,
- the impact and a suggested mitigation.

Do **not** include private media URLs, room passwords, or host tokens in a
report.

## Response timeline

- Acknowledgement within 48 hours.
- Triage and risk assessment within 5 business days.
- Coordinated disclosure after a fix ships.

## Out of scope

- Abuse of the tool for unauthorized streaming.
- "Weak passwords" as a finding — the app has no user accounts by design.
- General web-hosting/MFA misconfigurations of surrounding infrastructure.

## Production / deployment notes

- Run Node.js 20 or newer behind HTTPS.
- Keep `TMDB_BEARER_TOKEN` or `TMDB_API_KEY` in server environment variables.
- Do not add a generic server-side media proxy. The stream proxy is strictly
  allowlisted and HLS segments are approved dynamically; a general proxy would
  create SSRF, bandwidth abuse, and access-control bypass risks.
- Review the allowed external domains in the Content Security Policy before
  adding integrations.
- Remember that shared direct media URLs are visible to room participants.

## Data retention

Room state is in memory only. Chat is capped at 200 messages per room. Empty rooms
expire after 30 minutes and all rooms expire after 24 hours by default.
Restarting the process clears all rooms, which is intentional for privacy.