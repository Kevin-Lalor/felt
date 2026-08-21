---
description: Prove no player can ever see information they aren't entitled to
---

Information-leakage audit. This is hard rule 2 and it is the one that kills the project if it fails.

1. Run `pnpm test:leak` (redaction fuzzer, 5000 random hands). Report any failure in full.
2. Read `apps/server/src/redact.ts`. Confirm redaction is applied at a single choke point that
   ALL outbound frames pass through. If any code path can serialize table state without going
   through it, that is a CRITICAL finding — name the file and line.
3. Enumerate every outbound message type in `packages/protocol`. For each, state exactly what a
   player at seat N receives and confirm it is a subset of what they're entitled to at that
   moment in the hand.
4. Check the edge cases specifically:
   - a player who has folded (must not see live hole cards)
   - a player sitting out or on a break
   - an observer / spectator (must see exactly what a folded player sees)
   - showdown ordering — cards revealed only in correct order, only for players who must show
   - the "show one card" feature — exactly one card, the one chosen, never both
   - hand-history replay — full reveal is fine ONLY for completed hands
   - error messages and stack traces (do they echo state?)
   - the admin panel (admins must not get live hole cards either — log an audit entry if any
     admin view could)
5. Check timing side channels: does the server take measurably longer to respond when a player
   holds a strong hand? Does any animation hint start before the reveal?
6. Report to `docs/audits/leak-YYYY-MM-DD.md`.
