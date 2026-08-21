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
  const start = startHand({
    seats,
    button,
    blinds: {
      smallBlind: chips(1),
      bigBlind: chips(2),
      ante: chips(sc.ante),
      anteType: sc.ante === 0 ? 'none' : sc.anteType,
    },
    deck: testShuffle(sc.seed),
    handNumber: 1,
    rules: DEFAULT_RULES,
  });
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
});
