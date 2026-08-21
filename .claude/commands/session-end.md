---
description: Close out a coding session cleanly
---

Wrap up. It's the end of a session, so leave the repo somewhere I can pick up cold in three days.

1. Run `pnpm typecheck && pnpm test:engine`. If red, fix it or revert to green — **do not end a
   session on red.**
2. Commit anything outstanding with a proper Conventional Commit message. Push the branch.
3. If any architectural decision changed this session, update `CLAUDE.md` and add an ADR in
   `docs/adr/`.
4. If any poker rules decision was made, append it to `docs/HOUSE-RULES.md`.
5. Write `NEXT.md` at the repo root (overwrite): where we got to, what's half-done and exactly
   where, what to start with next session, and any open question I need to decide. Assume I've
   forgotten everything.
6. Give me a 5-line summary: what shipped, what's in flight, what's blocked.
