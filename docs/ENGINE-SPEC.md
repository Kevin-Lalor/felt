# Engine spec — `packages/engine`

This is the spec Claude Code builds against in weeks 1–2. It is deliberately detailed, because
the engine is the one part of this project where a bug costs you a friendship rather than a
bug report.

**The engine is pure.** No I/O, no network, no `Date.now()`, no randomness, no console, no
dependencies. The deck arrives as a parameter. Time arrives as a parameter. Everything is a
function from state to state.

---

## 1. Types

```ts
// ---------- cards ----------
export type Rank = 2|3|4|5|6|7|8|9|10|11|12|13|14   // 11=J 12=Q 13=K 14=A
export type Suit = 's'|'h'|'d'|'c'
export type Card = { rank: Rank; suit: Suit }
export type Deck = readonly Card[]                   // always 52, always pre-shuffled by the caller

// ---------- money ----------
/** Chips are integers. Always. There are no fractional chips and no floats anywhere
 *  in this package. A float in chip arithmetic is a bug by definition. */
export type Chips = number & { readonly __brand: 'Chips' }

// ---------- table ----------
export type SeatIndex = number                       // 0..maxSeats-1, fixed physical position
export type SeatStatus = 'empty' | 'active' | 'folded' | 'allIn' | 'sittingOut' | 'busted'

export type Seat = {
  index: SeatIndex
  playerId: string | null
  status: SeatStatus
  stack: Chips
  holeCards: readonly Card[]            // [] when not dealt in
  committedThisStreet: Chips            // reset each street
  committedThisHand: Chips              // used to build side pots
  hasActedThisStreet: boolean
  isAllIn: boolean
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete'

export type Pot = {
  amount: Chips
  eligibleSeats: readonly SeatIndex[]   // seats that can win THIS pot
}

export type BlindStructure = {
  smallBlind: Chips
  bigBlind: Chips
  ante: Chips                           // 0 if none
  anteType: 'none' | 'perPlayer' | 'bigBlindAnte'
}

export type HandState = {
  handNumber: number
  seats: readonly Seat[]
  button: SeatIndex
  street: Street
  board: readonly Card[]                // 0, 3, 4, or 5
  deck: Deck                            // remaining, dealt from index 0 upward
  deckPointer: number                   // next card index. Only ever increments.
  pots: readonly Pot[]
  blinds: BlindStructure
  currentBet: Chips                     // highest committedThisStreet this street
  lastRaiseSize: Chips                  // for minimum re-raise calculation
  actingSeat: SeatIndex | null          // null when the street is complete
  lastAggressor: SeatIndex | null       // for showdown order
  rules: HouseRules
}

// ---------- actions ----------
export type Action =
  | { kind: 'fold' }
  | { kind: 'check' }
  | { kind: 'call' }
  | { kind: 'bet';   to: Chips }        // `to` is a TOTAL for this street, never a delta.
  | { kind: 'raise'; to: Chips }        // Deltas are where off-by-one bugs live.
  | { kind: 'allIn' }

export type PlayerAction = { seat: SeatIndex; action: Action }

// ---------- events (what the UI animates from) ----------
export type Event =
  | { t: 'handStarted'; handNumber: number; button: SeatIndex }
  | { t: 'blindPosted'; seat: SeatIndex; amount: Chips; blind: 'small'|'big'|'ante' }
  | { t: 'holeCardsDealt'; seat: SeatIndex }          // cards themselves come via redaction
  | { t: 'acted'; seat: SeatIndex; action: Action; amount: Chips }
  | { t: 'streetDealt'; street: Street; cards: readonly Card[] }
  | { t: 'potsFormed'; pots: readonly Pot[] }
  | { t: 'showdown'; reveals: readonly { seat: SeatIndex; cards: readonly Card[] }[] }
  | { t: 'potAwarded'; pot: number; seat: SeatIndex; amount: Chips; hand: HandRank | null }
  | { t: 'handComplete' }

// ---------- results ----------
export type ApplyResult =
  | { ok: true;  state: HandState; events: readonly Event[] }
  | { ok: false; reason: IllegalActionReason }        // player error — NOT a throw

export type IllegalActionReason =
  | 'notYourTurn' | 'seatNotActive' | 'cannotCheckFacingBet'
  | 'raiseTooSmall' | 'raiseTooLarge' | 'betNotAllowedFacingBet'
  | 'insufficientChips' | 'handComplete'
```

Note the split: **illegal player input returns `ok:false`; impossible internal state throws
`EngineError`.** The first is normal (a client sent a stale action); the second is a bug and
should crash loudly in tests. Never conflate them.

---

## 2. Public API

```ts
/** Begin a hand. `deck` must be a pre-shuffled 52-card deck — the engine never shuffles,
 *  because the engine has no randomness. */
export function startHand(input: {
  seats: readonly Seat[]
  button: SeatIndex
  blinds: BlindStructure
  deck: Deck
  handNumber: number
  rules: HouseRules
}): { state: HandState; events: readonly Event[] }

/** Apply one player action. The ONLY way state advances. */
export function applyAction(state: HandState, action: PlayerAction): ApplyResult

/** What can this seat legally do right now? Drives the UI, and is the same code the
 *  validator uses — so the UI can never offer an action the engine will reject. */
export function legalActions(state: HandState, seat: SeatIndex): {
  canFold: boolean
  canCheck: boolean
  canCall: boolean;  callAmount: Chips
  canBet: boolean;   minBet: Chips;   maxBet: Chips
  canRaise: boolean; minRaise: Chips; maxRaise: Chips
  canAllIn: boolean; allInAmount: Chips
}

/** Best 5-card hand from 7. Pure, fast, exhaustively tested. */
export function evaluate7(cards: readonly Card[]): HandRank

/** Total ordering for comparing hands. Higher wins; equal means a genuine chop. */
export type HandRank = {
  category: 1|2|3|4|5|6|7|8|9   // 1 high card … 9 straight flush
  value: number                  // single comparable integer, kickers included
  cards: readonly Card[]         // the best five, for display
  label: string                  // "Flush, King high" — for the UI and hand histories
}
```

---

## 3. Betting rules — the exact behaviour to implement

Implement these literally. Each maps to at least one test.

**Action order**
- Pre-flop: first to act is left of the big blind.
- Post-flop: first to act is the first active seat left of the button.
- **Heads-up (2 players):** the button posts the small blind, acts **first** pre-flop and
  **last** post-flop. This is the single most commonly-wrong rule in amateur implementations.

**Betting round completion**
The street ends when either all active seats have acted and matched `currentBet`, or all but one
have folded. The big blind pre-flop has the **option** to raise even when everyone has only
called — the round is not over until they have acted.

**Raise sizing**
- Minimum bet (no bet yet) = `bigBlind`.
- Minimum raise = `currentBet + lastRaiseSize`.
- After a raise, `lastRaiseSize = newBet - previousBet`.
- Maximum = the seat's full stack (no limit).

**All-in for less than a full raise**
If a player goes all-in for more than `currentBet` but less than a full raise, `currentBet`
increases to their amount but `lastRaiseSize` does **not** change, and **players who have already
acted this street may only call or fold — the action is not reopened for them.** Players who have
not yet acted may still raise. Test this explicitly with a three-way scenario.

**Blinds**
- A stack smaller than the blind posts what it has and is all-in. It does not owe the remainder.
- Antes are posted before the blinds and go into the main pot.
- `bigBlindAnte`: one player (the big blind) posts the ante for the table.

**Side pots**
Build them at the end of each street, from `committedThisHand` across all seats:

1. Sort distinct non-zero `committedThisHand` values ascending → these are the levels.
2. For each level *L* (with previous level *P*): pot amount = `(L - P) × (count of seats with
   committedThisHand ≥ L)`. Eligible seats = all **non-folded** seats with `committedThisHand ≥ L`.
3. A folded seat's chips remain in the pots they contributed to; they are simply not eligible.

**Awarding**
Award pots main-first. Within each pot, compare `evaluate7` among eligible seats; split equally on
ties; the odd chip goes to the first eligible seat left of the button (house rule 2).

---

## 4. Hand evaluator

Correctness first; speed is a non-issue at nine players. Straightforward approach: generate all
21 five-card combinations from seven, score each, take the max.

Must handle:
- **The wheel:** A-2-3-4-5 is a straight, ace low, ranked below 6-5-4-3-2.
- **A-K-Q-J-10** is the top straight (Broadway).
- Steel wheel (A-2-3-4-5 suited) is a straight flush.
- Board plays: when the best five cards are all on the board, everyone still in chops.
- Counterfeited two pair — kickers must be compared correctly.
- Full-house comparison: trips rank first, then the pair.
- Flush comparison: all five cards, in order.

**Validation:** test against a known-good oracle. Either import `poker-evaluator` /
`pokersolver` *in the test file only* (never in `src`) and assert agreement across a few hundred
thousand random 7-card hands, or generate the canonical ranking table once and check against it.
Either way, the oracle lives in tests and the engine stays dependency-free.

---

## 5. Test plan

This is the deliverable of weeks 1–2 — the tests *are* the milestone.

**Unit (examples)** — one test per rule above, named in poker language so a non-programmer can
read the test list and check it describes real poker. e.g.
`'all-in for less than a full raise does not reopen action for a player who already called'`.

**Property-based (`fast-check`), the important ones:**

```ts
// Generate an arbitrary legal scenario: 2-9 seats, random stacks (including very short
// and exactly-blind-sized), random blind structure, random legal action sequences.

test('chips are conserved', () => {
  fc.assert(fc.property(arbitraryHand(), h => {
    expect(totalChips(after(h))).toBe(totalChips(before(h)))
  }), { numRuns: 20_000 })
})

test('no stack is ever negative', ...)
test('side pots sum exactly to total contributions', ...)
test('every pot has at least one eligible seat', ...)
test('exactly one player acts at a time, and only when actingSeat === them', ...)
test('deckPointer only ever increases, and never exceeds 52', ...)
test('no card appears twice across hole cards and board', ...)
test('a hand always terminates within a bounded number of actions', ...)
test('legalActions never offers an action that applyAction rejects', ...)   // the UI contract
```

That last one is quietly one of the most valuable: it makes it structurally impossible for the
UI to show a button that doesn't work.

**Golden replay tests** — take real hands from your own play-money history, encode them as
fixtures, assert the engine produces the exact same result. Grow this file every time a hand
looks wrong at the table. It becomes a regression suite made of your own arguments.

**Coverage gate:** 95% lines / 90% branches on `packages/engine`, enforced in CI. It only goes up.

---

## 6. Build order (weeks 1–2)

| Order | What | Done when |
|---|---|---|
| 1 | Types, `Chips` branding, card encode/decode | Typecheck clean |
| 2 | `evaluate7` + oracle validation | Agrees with oracle on 200k random hands |
| 3 | `startHand`: seats, button, blinds, antes, deal | Hole cards dealt correctly for 2–9 seats |
| 4 | `legalActions` | Every branch tested |
| 5 | `applyAction`: fold/check/call | Simple hands play to the river |
| 6 | `applyAction`: bet/raise + sizing rules | Min-raise and all-in-for-less tests green |
| 7 | Street progression, board dealing | Full hand reaches showdown |
| 8 | Side pot construction | Three-way all-in at different levels correct |
| 9 | Awarding + splits + odd chips | Property tests green at 20k runs |
| 10 | Event stream | Events fully describe a hand for replay |

**When step 10 is done you have a poker game with no screen.** That is the correct and slightly
unsatisfying state to be in at the end of week 2. Week 3 puts a face on it.
