# RandAnonChat — My Dev Workflow

## The Golden Rule
**One task. Verify with Claude (claude.ai). Commit in GitKraken. Then next task.**

---

## Every Claude Code Session Starts With:
Paste this before every single prompt you send to Claude Code:
```
Read SPEC.md before doing anything.
```

---

## Task Order

| # | Task | File(s) | Committed |
|---|------|---------|-----------|
| 1 | Project scaffold | folder structure + placeholders | ⬜ |
| 2 | Database schema | server/db/schema.sql | ⬜ |
| 3 | Auth system | server/routes/auth.js, server/middleware/auth.js | ⬜ |
| 4 | Encryption layer | client/src/utils/encryption.js, server/utils/encryption.js | ⬜ |
| 5 | Image pipeline | client/src/utils/imageProcessor.js | ⬜ |
| 6 | Chat system | server/routes/messages.js + client chat UI | ⬜ |
| 7 | Matching algorithm | server/routes/matching.js | ⬜ |
| 8 | Friends system | server/routes/friends.js | ⬜ |
| 9 | Groups system | server/routes/groups.js | ⬜ |
| 10 | Payments + diamonds | server/routes/payments.js | ⬜ |
| 11 | PWA manifest + service worker | client/vite.config.js + manifest | ⬜ |
| 12 | Play Store TWA wrapper | PWABuilder output | ⬜ |

---

## After Every Task:
1. Paste Claude Code output into claude.ai chat
2. Wait for claude.ai to verify it is correct
3. Only after claude.ai says it is good — open GitKraken
4. Stage all changes
5. Commit with message: `completed: [task name]`
6. Then ask claude.ai for the next task prompt

---

## If VS Code Crashes:
1. Reopen VS Code
2. Open terminal, navigate to project:
```bash
cd "C:\Users\ignot\OneDrive\Desktop\randanon dev\randanonchat"
```
3. Start Claude Code:
```bash
claude
```
4. Paste this (fill in the filename that was being worked on):
```
Read SPEC.md before doing anything. VS Code crashed while working on [FILENAME]. Open that file and verify it is complete and matches the spec exactly. List anything wrong or missing. Do not touch any other files.
```
5. Paste output into claude.ai for verification
6. Fix if needed, then commit

---

## If Claude Code Hits Usage Limit:
1. Note exactly which task was in progress
2. Wait for limit to reset
3. Start new Claude Code session
4. Paste the standard task prompt again from claude.ai

---

## Never:
- Send a big combined prompt covering multiple tasks
- Commit without verifying with claude.ai first
- Skip the verification step even if it looks right
- Let Claude Code touch files outside the current task
