import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import type { Action, Event, HandState, LegalActions } from '../src/index.js';
import { applyAction, chips, encodeCard, legalActions, startHand, DEFAULT_RULES } from '../src/index.js';
import { seatRow, testRng, testShuffle } from './helpers.js';

// ---------------------------------------------------------------------------
// A scenario is: 2-9 players with random stacks (including very short and
// exactly-blind-sized), a random button, optional antes, and a deterministic
// action policy driven by a seed. The policy only ever chooses from
// legalActions — which is itself the property under test: the engine must
// accept every action legalActions offers.
// ---------------------------------------------------------------------------

type Scenario = {
  stacks: number[];
  button: number;
  seed: number;
  ante: 0 | 1 | 2;
  anteType: 'none' | 'perPlayer' | 'bigBlindAnte';
  /** Seats that return from sitting out by posting rather than waiting for the
   *  big blind. Filtered down to the ones that may legally post — see playHand. */
  postSeats: number[];
};

const arbitraryScenario = fc.record({
  stacks: fc.array(fc.oneof(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 1, max: 400 })), {
    minLength: 2,
    maxLength: 9,
  }),
  button: fc.nat(8),
  seed: fc.integer({ min: 1, max: 2 ** 30 }),
  ante: fc.constantFrom(0, 1, 2) as fc.Arbitrary<0 | 1 | 2>,
  anteType: fc.constantFrom('none', 'perPlayer', 'bigBlindAnte') as fc.Arbitrary<
    'none' | 'perPlayer' | 'bigBlindAnte'
  >,
  postSeats: fc.array(fc.nat(8), { maxLength: 3 }),
}) satisfies fc.Arbitrary<Scenario>;

function pickAction(legal: LegalActions, rng: () => number): Action {
  const options: Action[] = [];
  // Weight sensible lines more heavily but keep every branch reachable.
  if (legal.canCheck) options.push({ kind: 'check' }, { kind: 'check' }, { kind: 'check' });
  if (legal.canCall) options.push({ kind: 'call' }, { kind: 'call' }, { kind: 'call' });
  if (legal.canFold) options.push({ kind: 'fold' });
  if (legal.canBet) {
    const to = legal.minBet + Math.floor(rng() * (legal.maxBet - legal.minBet + 1));
    options.push({ kind: 'bet', to: chips(to) });
  }
  if (legal.canRaise) {
    const to = legal.minRaise + Math.floor(rng() * (legal.maxRaise - legal.minRaise + 1));
    options.push({ kind: 'raise', to: chips(to) });
  }
  if (legal.canAllIn) options.push({ kind: 'allIn' });
  const choice = options[Math.floor(rng() * options.length)];
  if (!choice) throw new Error('legalActions offered nothing while a seat was acting');
  return choice;
}

type Played = { states: HandState[]; events: Event[]; initialTotal: number };

function playHand(sc: Scenario): Played {
  const stacks = sc.stacks;
  const seats = stacks.map((stack, i) => seatRow(i, stack));
  const button = sc.button % stacks.length;
  // The button must be on a live seat; every seat here is live.
  const rng = testRng(sc.seed);
  const blinds = {
    smallBlind: chips(1),
    bigBlind: chips(2),
    ante: chips(sc.ante),
    anteType: sc.ante === 0 ? ('none' as const) : sc.anteType,
  };
  const deal = {
    seats,
    button,
    blinds,
    deck: testShuffle(sc.seed),
    handNumber: 1,
    rules: DEFAULT_RULES,
  };

  // Which seats are paying blinds depends on the button and who is dealt in.
  // Rather than reimplement that here — a second copy that could drift from the
  // engine — deal once and read the blind seats straight off handStarted, then
  // deal again with posts on seats that are allowed to post. Reading them from
  // blindPosted events instead is wrong: a blind a short stack cannot cover
  // posts nothing and emits no event.
  const opening = startHand(deal).events.find((e) => e.t === 'handStarted');
  if (!opening || opening.t !== 'handStarted') throw new Error('no handStarted event');
  // Only the BIG blind is barred from posting. The small blind may post as
  // well — a returning player owes a full orbit — so it stays in the space.
  const blindSeats = new Set([opening.bigBlindSeat]);
  const posts = [...new Set(sc.postSeats)]
    .filter((seat) => seat < stacks.length && !blindSeats.has(seat))
    .map((seat) => ({ seat, amount: chips(2) }));

  const start = startHand({ ...deal, seats: stacks.map((stack, i) => seatRow(i, stack)), posts });
  const initialTotal = stacks.reduce((a, b) => a + b, 0);
  const states: HandState[] = [start.state];
  const events: Event[] = [...start.events];

  let state = start.state;
  let guard = 0;
  while (state.street !== 'complete') {
    if (++guard > 500) throw new Error('hand did not terminate within 500 actions');
    const seat = state.actingSeat;
    if (seat === null) throw new Error(`street ${state.street} incomplete but no acting seat`);
    const legal = legalActions(state, seat);
    const action = pickAction(legal, rng);
    const result = applyAction(state, { seat, action });
    if (!result.ok) {
      throw new Error(
        `legalActions offered ${action.kind}${'to' in action ? ` to ${action.to}` : ''} ` +
          `but applyAction rejected it: ${result.reason}`,
      );
    }
    state = result.state;
    states.push(state);
    events.push(...result.events);
  }
  return { states, events, initialTotal };
}

const RUNS = process.env['PROPERTY'] ? 20_000 : 1_500;

describe(`property-based invariants (${RUNS} random hands)`, () => {
  test('property: chips are conserved across every possible hand', () => {
    fc.assert(
      fc.property(arbitraryScenario, (sc) => {
        const { states, initialTotal } = playHand(sc);
        const final = states[states.length - 1];
        if (!final) throw new Error('no final state');
        const finalTotal = final.seats.reduce((sum, s) => sum + s.stack, 0);
        expect(finalTotal).toBe(initialTotal);
      }),
      { numRuns: RUNS },
    );
  });

  test('property: mid-hand, stacks plus commitments always equal the starting total, and no stack is negative', () => {
    fc.assert(
      fc.property(arbitraryScenario, (sc) => {
        const { states, initialTotal } = playHand(sc);
        for (const state of states) {
          let total = 0;
          for (const seat of state.seats) {
            expect(seat.stack).toBeGreaterThanOrEqual(0);
            total += seat.stack;
            if (state.street !== 'complete') total += seat.committedThisHand;
          }
          expect(total).toBe(initialTotal);
        }
      }),
      { numRuns: Math.ceil(RUNS / 3) },
    );
  });

  test('property: side pots sum exactly to total contributions, and every pot has an eligible seat', () => {
    fc.assert(
      fc.property(arbitraryScenario, (sc) => {
        const { states } = playHand(sc);
        // Pots are rebuilt at the END of each street, so mid-street they lag the
        // running commitments. The exact-sum invariant holds at hand completion;
        // eligibility must hold everywhere.
        for (const state of states) {
          for (const pot of state.pots) {
            expect(pot.eligibleSeats.length).toBeGreaterThan(0);
          }
        }
        const final = states[states.length - 1];
        if (!final) throw new Error('no final state');
        const potTotal = final.pots.reduce((sum, p) => sum + p.amount, 0);
        const committed = final.seats.reduce((sum, s) => sum + s.committedThisHand, 0);
        expect(potTotal).toBe(committed);
      }),
      { numRuns: Math.ceil(RUNS / 3) },
    );
  });

  test('property: awarded pots are paid only to eligible, non-folded seats', () => {
    fc.assert(
      fc.property(arbitraryScenario, (sc) => {
        const { states, events } = playHand(sc);
        const final = states[states.length - 1];
        if (!final) throw new Error('no final state');
        for (const e of events) {
          if (e.t !== 'potAwarded') continue;
          const seat = final.seats[e.seat];
          expect(seat?.status).not.toBe('folded');
          const pot = final.pots[e.pot];
          if (pot) expect(pot.eligibleSeats).toContain(e.seat);
        }
      }),
      { numRuns: Math.ceil(RUNS / 3) },
    );
  });

  test('property: deckPointer only increases and never exceeds 52; no card appears twice', () => {
    fc.assert(
      fc.property(arbitraryScenario, (sc) => {
        const { states } = playHand(sc);
        let pointer = 0;
        for (const state of states) {
          expect(state.deckPointer).toBeGreaterThanOrEqual(pointer);
          expect(state.deckPointer).toBeLessThanOrEqual(52);
          pointer = state.deckPointer;
        }
        const final = states[states.length - 1];
        if (!final) throw new Error('no final state');
        const seen = new Set<string>();
        for (const seat of final.seats) {
          for (const card of seat.holeCards) {
            const enc = encodeCard(card);
            expect(seen.has(enc)).toBe(false);
            seen.add(enc);
          }
        }
        for (const card of final.board) {
          const enc = encodeCard(card);
          expect(seen.has(enc)).toBe(false);
          seen.add(enc);
        }
      }),
      { numRuns: Math.ceil(RUNS / 3) },
    );
  });

  test('property: exactly one seat acts at a time and it is always the acting seat', () => {
    fc.assert(
      fc.property(arbitraryScenario, (sc) => {
        const { states } = playHand(sc);
        for (const state of states) {
          if (state.actingSeat === null) continue;
          // every OTHER seat must have nothing legal to do
          for (const seat of state.seats) {
            if (seat.index === state.actingSeat) continue;
            const legal = legalActions(state, seat.index);
            expect(legal.canFold || legal.canCheck || legal.canCall || legal.canBet).toBe(false);
          }
        }
      }),
      { numRuns: Math.ceil(RUNS / 5) },
    );
  });

  // buildPots adds all dead money to `lastPot` — the highest LIVE pot — on the
  // stated rule that dead money belongs to the nearest live pot below it. That
  // is only correct if a dead level can never sit BELOW a live one, which holds
  // because contributors at a higher level are always a subset of those at a
  // lower one: if every contributor at level L folded, everyone above L folded
  // too. That reasoning lived in a comment and nothing checked it. Now it does.
  test('property: a dead contribution level never sits below a live one, so dead money lands in the nearest live pot', () => {
    fc.assert(
      fc.property(arbitraryScenario, (sc) => {
        const { states } = playHand(sc);
        for (const state of states) {
          const seats = state.seats;
          const levels = [
            ...new Set(seats.map((s) => s.committedThisHand).filter((v) => v > 0)),
          ].sort((a, b) => a - b);
          const live = levels.map((level) =>
            seats.filter((s) => s.committedThisHand >= level).some((s) => s.status !== 'folded'),
          );
          const firstDead = live.indexOf(false);
          if (firstDead === -1) continue;
          // Every level above the first dead one must also be dead.
          expect(live.slice(firstDead).some((isLive) => isLive)).toBe(false);
        }
      }),
      { numRuns: Math.ceil(RUNS / 3) },
    );
  });

  test('property: a post is dead money — it reaches the pot but never counts as the poster\'s bet', () => {
    fc.assert(
      fc.property(arbitraryScenario, (sc) => {
        const { states, events } = playHand(sc);
        const posted = new Map<number, number>();
        for (const e of events) {
          if (e.t === 'blindPosted' && e.blind === 'post') {
            posted.set(e.seat, (posted.get(e.seat) ?? 0) + e.amount);
          }
        }
        if (posted.size === 0) return;
        const first = states[0];
        if (!first) throw new Error('no opening state');
        for (const [seat, amount] of posted) {
          const row = first.seats[seat];
          if (!row) throw new Error(`no seat ${seat}`);
          // In the pot...
          expect(row.committedThisHand).toBeGreaterThanOrEqual(amount);
          // ...and none of it toward the current bet, so the poster still owes
          // a call. Stated as a difference rather than "committedThisStreet is
          // zero", because a returning player who lands on the small blind has
          // that blind in front of them as a real bet — on TOP of the post.
          expect(row.committedThisHand - row.committedThisStreet).toBeGreaterThanOrEqual(amount);
        }
      }),
      { numRuns: Math.ceil(RUNS / 3) },
    );
  });
});
