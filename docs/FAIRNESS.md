# Fairness protocol — commit-reveal shuffle

This is the exact derivation the server uses. `tools/verify-hand.ts` re-implements it
independently. **Never change one without the other in the same PR** (CLAUDE.md).

## Per hand

1. **Commit.** The server generates `serverSeed` = 32 random bytes (CSPRNG, hex-encoded)
   and broadcasts `commit = SHA256(serverSeed)` to every player **before any card exists**.
2. **Derive.** The deck order is a Fisher–Yates shuffle of the canonical 52-card deck
   (`2s..As, 2h..Ah, 2d..Ad, 2c..Ac`), driven by a deterministic byte stream:

   ```
   message   = clientSeeds.join('|') + '+' + handNumber     // seeds in SEAT ORDER
   block[n]  = HMAC-SHA256(key = serverSeed, msg = message + ':' + n)
   ```

   Big-endian uint32s are read from the blocks; each Fisher–Yates index uses
   **rejection sampling** (`v < floor(2^32 / n) * n`, then `v % n`) so there is no
   modulo bias. Every seated player's `clientSeed` is in the message — players set
   their own seed (Fair tab), so the host cannot precompute a deck even in principle.
3. **Deal.** Two hole cards per seat, one card at a time, clockwise starting left of
   the button; then flop (3), turn (1), river (1) off the top. No burns, no re-shuffles,
   no card-selection logic anywhere in the codebase.
4. **Reveal.** When the hand completes, the server broadcasts `serverSeed`. Anyone checks:
   - `SHA256(revealedSeed) === commit` → the server committed before dealing;
   - re-run step 2–3 → the derived cards match the recorded hand history.

## Verifying

- In-app: Fair tab shows commit, every player's seed, and the revealed seed.
- Offline: `pnpm verify-hand <handNumber>` against `apps/server/data/history.jsonl`
  (or any exported copy from `/api/history`). The verifier shares no code with the server.

## Threat notes

- A player who distrusts the table changes their `clientSeed` right before a hand:
  the deck for that hand is then unpredictable to everyone else, including the host.
- Hand histories are public to all players, hole cards included, once a hand ends —
  transparency is the product.
