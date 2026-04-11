# RandAnonChat — Dev Workflow

## The Golden Rules
- SPEC.md is always updated before building anything
- One task at a time to Claude Code
- Every Claude Code prompt starts with "Read SPEC.md before doing anything"
- Never fix issues mid-audit — log them and continue
- Slow. Methodical. Repeatable.

---

## Every Claude Code Prompt Starts With:
```
Read SPEC.md before doing anything. Confirm you have read it. Then do ONE thing only: [task]
```

---

## Building a Feature:

1. Design feature thoroughly with claude.ai — full detail, no guessing
2. Update SPEC.md with complete design before touching any code
3. Download updated SPEC.md, replace in project folder
4. **GitKraken commit: `completed: updated SPEC - [feature name]`**
5. Give Claude Code one task at a time
6. Claude Code finishes — paste output into claude.ai
7. claude.ai verifies output against spec carefully
8. If issues found — log them in AUDIT_ISSUES.md, continue
9. If clean — **GitKraken commit and push: `completed: [task name]`**
10. Move to next task

---

## After Every Task:
1. Paste Claude Code output into claude.ai
2. Wait for claude.ai to verify it is correct
3. Only after claude.ai says it is good — open GitKraken
4. Stage all changes
5. Commit and push with message: `completed: [task name]`
6. Ask claude.ai for the next task prompt

---

## Audit Process:

1. Run full file list in VS Code terminal:
```powershell
Get-ChildItem -Recurse -File | Where-Object { $_.FullName -notmatch 'node_modules|\.git|dist' } | Select-Object -ExpandProperty FullName
```
2. Organize files into stages (foundation → features → client → config)
3. Paste each file into claude.ai one at a time
4. claude.ai verifies against spec — logs any issues found in AUDIT_ISSUES.md
5. Complete full stage before fixing anything
6. After each stage — fix ALL issues in ONE Claude Code prompt
7. Verify each fix individually with claude.ai
8. Update AUDIT_ISSUES.md — mark issues fixed, increment version number
9. Download updated issues log — replace in project folder
10. **GitKraken commit: `completed: audit issues log - stage [X]`**
11. Fix prompt runs — paste output into claude.ai
12. claude.ai verifies each fix one by one
13. Update AUDIT_ISSUES.md — confirm all fixed
14. Download updated issues log — replace in project folder
15. **GitKraken commit and push: `completed: audit stage [X] fixes`**
16. Move to next stage

---

## Issues Log Rules:
- Every new issue gets a number — never reuse numbers
- Every delivery of AUDIT_ISSUES.md includes a commit message
- Version increments every time issues are found or fixed
- Deferred issues (waiting on dev agenda) go in Re-test Later section
- Schema re-tested when relevant dev agenda items complete

---

## If VS Code Crashes:
1. Reopen VS Code
2. Open terminal, navigate to project:
```bash
cd "C:\Users\ignot\OneDrive\Desktop\randanon dev\Randachat\randanonchat"
```
3. Start Claude Code:
```bash
claude
```
4. Paste this (fill in the filename being worked on):
```
Read SPEC.md before doing anything. Confirm you have read it. VS Code crashed while working on [FILENAME]. Open that file and verify it is complete and matches the spec exactly. List anything wrong or missing. Do not touch any other files.
```
5. Paste output into claude.ai for verification
6. Fix if needed, then commit

---

## If Claude Code Hits Usage Limit:
1. Note exactly which task was in progress
2. Wait for limit to reset
3. Start new Claude Code session: `claude`
4. Paste the standard task prompt again from claude.ai
5. Continue from where it stopped

---

## Commit Message Format:
- Feature build: `completed: [feature name]`
- Spec update: `completed: updated SPEC - [feature name]`
- Audit log: `completed: audit issues log - stage [X]`
- Audit fixes: `completed: audit stage [X] fixes`
- Bug fix: `completed: fix - [description]`
- Config change: `completed: [description]`

---

## Dev Agenda Task Order:
| # | Task | Status |
|---|------|--------|
| 1 | Wire landing page in server/index.js | ✅ Done |
| 2 | Fix landing page bugs | ✅ Done |
| 3 | Update vite.config.js for /app subpath | ✅ Done |
| 4 | Update server/index.js to serve React at /app | ✅ Done |
| 5 | Build server/public/tos.html | ✅ Done |
| 6 | Build server/public/privacy.html | ✅ Done |
| 7 | Push notification infrastructure | ⬜ |
| 8 | Subscription key system | ⬜ |
| 9 | Bio column on users table | ⬜ |
| 10 | Build all React app screens | ⬜ |
| 11 | Deploy to GCP via Dokku | ⬜ |
| 12 | Test everything | ⬜ |
| 13 | Set up legal@randanonchat.com email | ⬜ |
| 14 | Get Louisiana LLC | ⬜ |
| 15 | TWA wrapper via PWABuilder | ⬜ |
| 16 | Google Play developer account | ⬜ |
| 17 | Enable real billing | ⬜ |
| 18 | Public launch | ⬜ |
