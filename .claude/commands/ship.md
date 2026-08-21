---
description: Full pre-deploy gate, tag, deploy, verify
---

Ship to production. **Abort at the first failure** and tell me what broke — never continue past red.

Pre-flight:
1. Working tree clean, on `main`, up to date with origin.
2. `pnpm typecheck`
3. `pnpm lint`
4. `pnpm test`
5. `pnpm test:property`
6. `pnpm test:leak`
7. `pnpm test:e2e`
8. `pnpm build`
9. Confirm no game is currently in progress (check the server's active-tables endpoint).
   **If a game is live, STOP.** Never deploy on a game night.

Deploy:
10. Take a DB snapshot: `pnpm db:snapshot`.
11. Bump version, tag `v<major>.<minor>.<patch>`, push tag.
12. Deploy.
13. Smoke test: `/healthz` returns 200; log in; create a table; deal one hand against a bot seat;
    confirm the commit–reveal verifies via `pnpm verify-hand`.
14. Report the tag, what shipped (from the Conventional Commits since the last tag), and the
    rollback command from `ROLLBACK.md` — so it's in the transcript if I need it at 1am.
