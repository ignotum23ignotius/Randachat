# RandAnonChat — Audit Issues Log

## Status Key:
- ⚠️ Open — needs fixing
- ✅ Fixed — verified
- 🔄 Deferred — waiting on dev agenda item

---

## Open Issues:

| # | File | Issue | Status |
|---|------|-------|--------|
| 1 | client/vite.config.js | navigateFallback '/index.html' should be '/app/index.html' | ✅ Fixed |
| 2 | server/routes/auth.js | Shadow ban JWT includes shadow_banned: true — detectable by user | ✅ Fixed |

---

## Re-test Later:
- server/db/schema.sql — re-verify completely after dev agenda items 7 and 9 are complete

---

## Files Verified Clean:
- server/db/schema.sql (pending deferred fixes)
- server/middleware/auth.js
- server/db/index.js
- server/index.js
- package.json (root)
- server/package.json
- client/package.json
- Procfile
- server/routes/auth.js (pending fix #2)
