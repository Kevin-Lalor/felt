# Next session

**Where we are (2026-07-26):** the cash game is IMPLEMENTED and playable end-to-end.
Engine (58 tests green, property suites + 200k-hand oracle), protocol, server with
redaction + commit-reveal fairness + leak fuzzer, web table UI, verify-hand tool.
A live 3-player hand (including a split pot with the odd-chip rule) was played in the
browser and verified with `pnpm verify-hand`. See README.md "Status" for the exact map.

**Start here:**
1. `git init` + first commit + private GitHub repo push (still not done — the repo has
   no git history yet; CI and branch protection activate on push).
2. Play a real game night over a quick tunnel: `cloudflared tunnel --url http://localhost:8090`.
   Dump feedback into FEEDBACK.md.
3. Next features by value: sit-out/return + rebuy UI polish → tournaments (blind clock,
   payouts) → cosmetics (fold styles, themes picker — tokens already support 4 themes)
   → passkeys + Cloudflare Access for the permanent deployment.
4. Decide the open HOUSE-RULES items before week 4 (action clock is currently 45s
   auto-check/fold — tune it and write it down).

**Known gaps / honest notes:**
- Auth is invite-code + host-code (env-configurable), not passkeys yet. Fine behind a
  tunnel for friends; do the passkey work before making the URL permanent.
- Hand history is JSONL (`apps/server/data/history.jsonl`), not SQLite — plenty at this
  scale; migrate when stats dashboards land.
- Table state is in-memory: a server restart forgets seats/stacks (histories survive).
- The show-one-card window is 8s; showdown reveals show both cards to everyone.

**Read first:** `CLAUDE.md`. It is the contract.
