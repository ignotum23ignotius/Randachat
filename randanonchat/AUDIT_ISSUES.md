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
| 3 | server/routes/messages.js | DELETE /expired protected by authenticate middleware — should be server-side cron, not user-triggered | ✅ Fixed |
| 4 | server/routes/matching.js | Fallback query orders by partner_id (UUID) not by last message timestamp — least recently seen logic broken | ✅ Fixed |
| 6 | server/routes/images.js | DELETE endpoint only allows uploader to delete — recipient cannot trigger deletion on self-destruct | ✅ Fixed |
| 9 | randanonchat/.gitignore | Missing critical entries — node_modules/, client/dist/, *.log, .DS_Store, coverage/ | ✅ Fixed |
| 10 | Randachat/.gitignore | Missing critical entries — outer gitignore only had randanonchat/.env | ✅ Fixed |

---

## Re-test Later:
- server/db/schema.sql — re-verify completely after dev agenda items 7, 8, and 9 are complete ✅ All three complete — schema.sql ready for re-verification

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
