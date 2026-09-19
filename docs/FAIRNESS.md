# Fairness protocol — commit-reveal shuffle

This is the exact derivation the server uses. `tools/verify-hand.ts` re-implements it
independently. **Never change one without the other in the same PR** (CLAUDE.md).

## The ordering that makes it binding

Commit-reveal constrains the server only if the server commits **before** it can know the client
seeds that commitment will be mixed with. Commitments are therefore **chained one hand ahead**:

- The commitment for hand 1 is minted in the `Table` constructor — before anyone has joined.
- The commitment for hand N+1 is minted and broadcast the moment hand N starts.
- `startNextHand()` *consumes* a commitment that was already public. It never mints the one it
  is about to use.

A server that generated its seed at deal time, after reading `player.clientSeed`, could loop
generate → derive → evaluate until it found a deck it liked, and then commit to that one.
`SHA256(revealed) === commit` would still pass, and the verifier would still print its success
banner. That was the shape of this code before the chaining fix, and the ordering above is what
prevents it. There is a regression test for exactly this in
`apps/server/__tests__/table-integrity.test.ts`.

Clients rotate their seed automatically whenever a new commitment appears, so in normal play
every seed is chosen after the commitment it enters. A player who pins a seed of their own opts
out of that guarantee — the Fair tab and the hand record both say so per seat, via
`clientSeeds[].postCommit`.

## Per hand

1. **Commit.** `commit = SHA256(serverSeed)`, where `serverSeed` is 32 CSPRNG bytes, hex-encoded.
   Both were generated one hand earlier and broadcast then.
2. **Derive.** The deck is a Fisher–Yates shuffle of the canonical 52-card deck
   (`2s..As, 2h..Ah, 2d..Ad, 2c..Ac`), driven by a deterministic byte stream:

   ```
   message   = clientSeeds.join('|') + '+' + handNumber     // seeds in SEAT ORDER
   block[n]  = HMAC-SHA256(key = serverSeed, msg = message + ':' + n)
   ```

   Big-endian uint32s are read from the blocks; each Fisher–Yates index uses **rejection
   sampling** (`v < floor(2^32 / n) * n`, then `v % n`) so there is no modulo bias.
3. **Deal.** Two hole cards per seat, one card at a time, clockwise starting left of the button;
   then flop (3), turn (1), river (1) off the top. No burns, no re-shuffles, no card-selection
   logic anywhere in the codebase.
4. **Reveal.** When the hand completes the server broadcasts `serverSeed`. Anyone checks
   `SHA256(revealedSeed) === commit`, then re-runs steps 2–3 and compares against the recorded
   hand history.

One list decides both who is dealt in and whose seed enters the shuffle
(`Table.participatingSeats()`), so the two can never drift apart.

## What a record contains

Seeds are recorded **positionally** — `[{ seat, name, seed, postCommit }]`, ordered by seat.
They used to be a `Record<name, seed>` map, which broke the moment a player renamed on reconnect:
the hand stayed honest but its record became unverifiable, and the verifier threw. Player names
are now frozen for the duration of a hand.

Every record also carries a stable `handId` of the form `${sessionId}-${handNumber}`, because
`handNumber` restarts at 1 with the server while `history.jsonl` persists. Pass a `handId` to
verify one hand exactly; a bare number verifies the most recent hand with that number and says so.

The verifier still reads older, name-keyed records — it falls back to the recorded order and
prints a note saying the record predates commit chaining.

## Verifying

- In-app: the Fair tab shows the commitment for the next hand, the commitment for the current
  one, every seat's seed and whether it was set after that commitment, and the revealed seed.
- Offline: `pnpm verify-hand <handId>` against `apps/server/data/history.jsonl`, or any copy
  exported from `/api/history`. The verifier shares no code with the server, and a test drives a
  real hand through `Table` and shells out to it, so the two implementations cannot drift apart
  unnoticed.

## Threat notes

- A player who distrusts the table can pin their own seed — but a pinned seed was known to the
  server before it committed, so it constrains nothing. Leaving rotation on is the stronger
  choice, and the per-seat `postCommit` flag is there so nobody has to take that on trust.
- Hand histories are public to everyone at the table, hole cards included, once a hand ends —
  transparency is the product. They are **not** public to the internet: `/api/history` and
  `/api/fairness` require the invite code, because the app is meant to sit behind a tunnel.
- Commit-reveal proves the server did not change the deck after committing. It does not make the
  server blind to the cards — the host still holds every hole card. Removing the trusted dealer
  entirely needs mental poker, which is far more complexity than a play-money home game warrants.
