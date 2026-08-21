---
description: Audit the entire codebase for anything that could compromise shuffle fairness
---

Full fairness audit. Report findings ranked by severity; do not fix anything without asking first.

**1. RNG discipline**
- Grep the whole repo for `Math.random`, `crypto.pseudoRandomBytes`, `%` applied to random output
  (modulo bias), and any seeded PRNG imported outside test files.
- Confirm every deck shuffle uses Fisher–Yates with `randomInt` from `node:crypto`, iterating
  downward, full 52 cards, once per hand.

**2. Card-selection surface (hard rule 4)**
- Find every function that returns a `Card` or `Card[]`. For each, confirm its inputs cannot
  include player state, stack sizes, hand strength, or anything derived from them.
- Confirm cards are only ever taken from the top of the deck in order — no index arithmetic,
  no filtering, no "find a card such that…".

**3. Commit–reveal chain**
- `commit` is broadcast before the first card is dealt, never after.
- `serverSeed` is 32 bytes from CSPRNG, generated fresh per hand, never reused, never derived
  from anything predictable (time, hand number, player ids).
- Every seated player's `clientSeed` is included in the derivation.
- The reveal is unconditional — it happens on every hand ending, including folds, walkovers,
  and disconnects.
- `tools/verify-hand.ts` derives the deck by exactly the same code path as the server. If it
  has a second implementation that could drift, that is a HIGH severity finding.

**4. Statistical check**
- Run the χ² suite over recorded hand history. Report observed vs expected for pocket pairs,
  flopped sets, suited hands, and showdown hand-rank distribution, with p-values.
- A p-value < 0.01 is worth investigating; < 0.001 across multiple independent metrics is alarming.
  Note explicitly if the sample is too small to conclude anything (< ~2000 hands).

**5. Report**
Write findings to `docs/audits/fairness-YYYY-MM-DD.md`. For each: severity, file:line, what's
wrong, why it matters, suggested fix. End with a one-line verdict a non-technical friend
could read.
