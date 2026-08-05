# Contributing to Watch Together Sync

Thanks for considering a contribution to this project.

## Ground rules

- **Zero npm runtime dependencies** — the goal is a self-contained server with
  no production packages. New runtime deps are rejected unless unavoidable.
- **No unsafe features** — no generic media proxy, no torrent/indexer
  integration, no stream scraping added to the embed layer, no exposed
  credentials or API secrets.
- **Security-first** — any change touching the proxy, allowlist, CSP, or
  WebSocket rate limits must preserve the existing constraints.
- **Authorized media only** — the app must stay usable strictly for media
  participants are authorized to access.

## Reporting bugs

Open an issue with the bug template (or a PR). Include:

- exact command and how the server was started,
- the relevant terminal output,
- Node version (`node -v`),
- expected vs actual behavior.

## Requesting features

Use the feature request template. In your request, say what use case you're
solving, why it fits the project, and notes on the design. Features that add
runtime dependencies or weaken the security model need a strong justification.

## Development workflow

1. Fork the repository and create a branch.
2. Make your change, keep it small and focused.
3. Verify with the built-in checks:

```bash
npm run check    # node --check on server.js and public/app.js
npm test         # integration suite
```

4. If you touched the Free sources or proxy layer, also do a manual end-to-end
   resolve → stream playback check against the local server.
5. Update README tables/secrets if your change affects documented behavior.
6. Commit with a conventional prefix (`fix:`, `feat:`, `refactor:`, `docs:`,
   `test:`, `perf:`, `ci:`).
7. Open a PR via the template.

## Style

- Node 20+ JS, no build step, no bundling.
- Comments explain **why**, not what.
- Keep single-file core modules readable; split only when a module grows past
  reasonable scope.

## License

By contributing you agree that your contributions are licensed under the
project's MIT license (see [LICENSE](LICENSE)).