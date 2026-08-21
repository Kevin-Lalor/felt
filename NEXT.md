# Next session

**Where we are (2026-08-21):** the cash game is implemented, playable end to end,
and now on GitHub at **github.com/Kevin-Lalor/felt** (private). CI is green on `main`:
verify, fairness invariants, and the engine coverage gate all pass.

Engine: 106 tests, incl. fast-check property suites, a 200k-hand evaluator oracle,
and full guard/validation coverage (99.4% lines, 95.3% branches). Server: per-seat
redaction with a 5k-hand leak fuzzer, commit-reveal shuffle. Web: full table UI.
A live 3-player hand — including a split pot with the odd chip landing on the correct
seat — was played in the browser and re-derived offline with `pnpm verify-hand`.
See README.md "Status" for the exact map.

**Start here:**
1. Play a real game night over a quick tunnel:
   `cloudflared tunnel --url http://localhost:8090`. Dump feedback into FEEDBACK.md.
2. Next features by value: sit-out/return + rebuy UI polish → tournaments (blind
   clock, payouts) → cosmetics (fold styles, themes picker — tokens already ship 4
   themes) → passkeys + Cloudflare Access for a permanent deployment.
3. Decide the open HOUSE-RULES items (action clock is 45s auto-check/fold — tune it
   and write the decision down).

**Repo / CI notes:**
- Use `/new-feature <name>`: branch → plan → tests-first → draft PR. CI runs on every
  PR and push.
- **Branch protection is NOT active.** GitHub requires Pro for rulesets on private
  repos (403 on the free plan). Three ways out, in order of cost: make the repo public,
  upgrade to Pro, or add a `.husky/pre-push` hook running `pnpm typecheck && pnpm lint
  && pnpm test` (~30s) for a local equivalent. Until one of those, a red CI run does
  not physically block a merge — read the checks before merging.
- The PR reviewer job (`independent reviewer`) skips unless the `ANTHROPIC_API_KEY`
  repo secret is set. Add it with `gh secret set ANTHROPIC_API_KEY` to turn it on.
- pnpm's version lives ONLY in package.json `packageManager`. Setting it in the
  workflow too makes `pnpm/action-setup` fail outright.
- Commits go through commitlint via `.husky/commit-msg` — Conventional Commits or
  the commit is rejected.

**Known gaps / honest notes:**
- Auth is invite-code + host-code (env-configurable), not passkeys yet. Fine behind a
  tunnel for friends; do the passkey work before making the URL permanent.
- Hand history is JSONL (`apps/server/data/history.jsonl`, gitignored), not SQLite —
  plenty at this scale; migrate when stats dashboards land.
- Table state is in-memory: a server restart forgets seats and stacks (histories survive).
- `evaluate.ts` has 4 uncovered branches and `types.ts` 1 — all defensive, none worth
  contorting a test around. Left deliberately.
- Playwright is a devDependency but there are no e2e specs yet.

**Read first:** `CLAUDE.md`. It is the contract.
