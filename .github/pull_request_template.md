## What does this PR do?

<!-- Short description of the change and why -->

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor
- [ ] Docs
- [ ] Test / CI

## Checklist

- [ ] Ran `npm run check` (node --check on server.js and public/app.js)
- [ ] Ran `npm test` — integration suite passes
- [ ] If I touched the Free sources / proxy layer, I verified a real
      resolve → stream playback flow locally
- [ ] Updated README tables / docs if behavior changed
- [ ] No new runtime npm dependencies
- [ ] Security constraints preserved (allowlist, CSP, rate limits, no generic proxy)

## Test evidence

```
# Paste the relevant test output here (run `npm test` and the check script)
```

## Authorized media / security note

This change keeps the app strictly usable for media participants are authorized
to access and does not weaken the security model.