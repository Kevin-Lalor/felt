# Next session

**Where we are (2026-09-19):** Phase 0 is done and committed on
`fix/fairness-ordering-and-seat-leak`. **The branch is not pushed yet** — push it
from Windows (`git push -u origin fix/fairness-ordering-and-seat-leak`). The Linux
side of the Claude session has no GitHub credentials.

Three defects fixed, each of which broke a promise this app makes to its players:

1. **Commit-reveal ran backwards.** `startNextHand()` generated the server seed
   after it already held every client seed, so a modified server could grind
   decks and still pass `SHA256(revealed) === commit` and the offline verifier.
   Commitments are now chained one hand ahead. Clients rotate their seed
   automatically as each new commitment appears; a pinned seed opts out, and
   every seat carries a `postCommit` flag saying which.
2. **Hole cards leaked through seat reuse.** A folded or all-in seat could vacate
   mid-hand and hand its cards to whoever sat down next. Guards added in `sit`,
   `standUp`, `leave` and `buildSeatView`. This also stops an all-in player
   silently forfeiting their winnings by leaving.
3. **Records were unverifiable after a rename.** Seeds are positional now, names
   are frozen for the duration of a hand, and every hand carries a stable
   `handId`. `pnpm verify-hand 7` used to throw; it passes.

Also in that commit: the history routes require the invite code; the conditional
hook in `Table.tsx` is fixed; `chipsSchema` is bounded so a legal-looking 1e21
bet can no longer kill the process; `HandRecord.blinds` no longer spreads the
whole `TableConfig`.

**Tests: 123 pass, up from 113.** `apps/server/__tests__/table-integrity.test.ts`
drives the real `Table` and shells out to `tools/verify-hand.ts`, so the server
and the verifier cannot drift apart unnoticed. Typecheck, lint and build clean.

**Start here:**
1. Push the branch and open the PR. Turn the reviewer on first:
   `gh secret set ANTHROPIC_API_KEY`.
2. Make the repo public (decided 19 Sep). It unlocks branch protection rulesets
   for free — today a red CI run cannot physically block a merge.
3. Phase 1, in this order: theme picker (**default: Midnight**, decided 19 Sep),
   then the action clock surfaced in `tableViewSchema`, then the chips/BB toggle.

**Decisions taken 2026-09-19:**
- Default theme: **Midnight**.
- Hosting: **Cloudflare Tunnel on a named tunnel + a domain (~€10/yr)**, not a
  quick tunnel. Needs heartbeat + reconnect-with-resync before a permanent URL —
  Cloudflare closes idle sockets and restarts servers mid-connection.
- Repo: **public**.

**Known gaps / honest notes:**
- Table state is still in memory: a restart forgets seats and stacks. SQLite is
  Phase 2. `ARCHITECTURE.md` and `ROLLBACK.md` still describe that system as if
  it exists — `CLAUDE.md` now carries a warning, those two do not.
- CI's skipped-test guard greps `apps/server/src/__tests__`, which does not
  exist (tests are at `apps/server/__tests__`). `grep` on a missing path exits
  non-zero, the `if` is false, and the step passes. It has never inspected a
  server test.
- `turbo.json` has no `tokens` task and `apps/web` reaches into
  `packages/tokens/dist/` by relative path, so a clean clone fails unless you
  run `pnpm tokens` first.
- `db:migrate` and `db:snapshot` still point at scripts nobody wrote; `/ship`
  step 10 and `ROLLBACK.md` both depend on `db:snapshot`.
- The wireframe kit (24 frames) is still outside the repo in
  `G:\Poker App Wireframe Kit-handoff`, while `CLAUDE.md` imports an empty
  `docs/design/WIREFRAMES.md` index and tells every session to read it first.
  Moving it in is the highest-value hour in the repo.
- `.husky/pre-push` still not added, so nothing local blocks pushing red code.
- Playwright is a devDependency with no specs; `pnpm test:e2e` and `/ship` step 7
  both run against nothing.
- Four review agents and six slash commands in `.claude/` have still never been
  run. `docs/adr/`, `docs/audits/`, `docs/progress/` and `reviews/` are empty.
  `/fairness-audit` and `/leak-check` were written to catch exactly defects 1
  and 2 above.

**Read first:** `CLAUDE.md`. It is the contract, and it is now accurate about
persistence and the fairness derivation.
