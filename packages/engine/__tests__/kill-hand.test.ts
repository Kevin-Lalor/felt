// killHand: the host removed a player mid-hand (HOUSE-RULES #13). Their hand is
// dead at once — not when the action reaches them, and not on a clock — and
// every chip they already put in stays in the pot. Everything else carries on
// exactly as if they had folded.
//
// The property tests replay the same random hands as property.test.ts, but
// kill a random live seat at a random moment, and hold the usual invariants:
// chips conserved, no negative stack, pots sum to contributions, every pot has
// a live seat to win it. Hard rule 8: a change to betting or pots ships with
// property tests, not only examples.

import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import type { Action, Event, HandState, LegalActions } from '../src/index.js';
import {
  DEFAULT_RULES,
  applyAction,
  chips,
  killHand,
  legalActions,
  startHand,
} from '../src/index.js';
import { BLINDS_1_2, newHand, seatRow, testRng, testShuffle } from './helpers.js';

function act(state: HandState, action: Action): HandState {
  const seat = state.actingSeat;
  if (seat === null) throw new Error('nobody to act');
  const result = applyAction(state, { seat, action });
  if (!result.ok) throw new Error(`rejected: ${result.reason}`);
  return result.state;
}

function kill(state: HandState, seat: number): { state: HandState; events: readonly Event[] } {
  const result = killHand(state, seat);
  if (!result.ok) throw new Error(`kill rejected: ${result.reason}`);
  return result;
}

const total = (state: HandState) =>
  state.seats.reduce((sum, s) => sum + s.stack + (state.street === 'complete' ? 0 : s.committedThisHand), 0);

describe('killHand — examples', () => {
  test('killing the seat to act folds it and passes the action on', () => {
    // 3-handed, button 0: SB 1, BB 2, seat 0 acts first preflop.
    const { state } = newHand({ stacks: [100, 100, 100], button: 0 });
    expect(state.actingSeat).toBe(0);
    const { state: after, events } = kill(state, 0);
    expect(after.seats[0]?.status).toBe('folded');
    expect(after.actingSeat).toBe(1);
    expect(events).toContainEqual({ t: 'handKilled', seat: 0 });
  });

  test('killing a seat that is not to act folds it and leaves the action where it was', () => {
    const { state } = newHand({ stacks: [100, 100, 100, 100], button: 0 });
    const acting = state.actingSeat;
    const victim = acting === 2 ? 1 : 2;
    const { state: after } = kill(state, victim);
    expect(after.seats[victim]?.status).toBe('folded');
    expect(after.actingSeat).toBe(acting);
  });

  test('chips the killed seat put in stay in the pot', () => {
    const { state } = newHand({ stacks: [100, 100, 100], button: 0 });
    // Seat 0 raises to 10, then is killed while seat 1 decides.
    const raised = act(state, { kind: 'raise', to: chips(10) });
    const { state: after } = kill(raised, 0);
    expect(after.seats[0]?.committedThisHand).toBe(10);
    expect(after.seats[0]?.stack).toBe(90);
    expect(total(after)).toBe(300);
  });

  test('the killed seat’s bet still stands: the next to act faces it', () => {
    const { state } = newHand({ stacks: [100, 100, 100], button: 0 });
    const raised = act(state, { kind: 'raise', to: chips(10) });
    const { state: after } = kill(raised, 0);
    const legal = legalActions(after, after.actingSeat ?? -1);
    expect(after.currentBet).toBe(10);
    expect(legal.canCheck).toBe(false);
    expect(legal.callAmount).toBe(9); // small blind already has 1 in
  });

  test('killing everyone but one ends the hand and the last seat takes every pot', () => {
    const { state } = newHand({ stacks: [100, 100], button: 0 });
    // Heads-up: button (seat 0) is the small blind and acts first.
    const raised = act(state, { kind: 'raise', to: chips(20) });
    const { state: after, events } = kill(raised, 0);
    expect(after.street).toBe('complete');
    // Seat 1 wins everything in the middle, including the part of the raise
    // nobody called — it was in the pot, and it stays there.
    expect(after.seats[1]?.stack).toBe(120);
    expect(after.seats[0]?.stack).toBe(80);
    expect(events.some((e) => e.t === 'potAwarded' && e.seat === 1)).toBe(true);
  });

  test('when every chip in the middle is from dead hands, the seats still in play for it', () => {
    // 4-handed, button 0: blinds on 1 and 2, seat 3 to act. Kill the blinds
    // and seat 3 — the button has put nothing in, and wins the 3 chips.
    // Found by the property test below: this used to throw.
    const { state } = newHand({ stacks: [100, 100, 100, 100], button: 0 });
    let s = kill(state, 1).state;
    s = kill(s, 2).state;
    const { state: done } = kill(s, 3);
    expect(done.street).toBe('complete');
    expect(done.seats[0]?.stack).toBe(103);
    expect(total(done)).toBe(400);
  });

  test('an all-in seat can be killed: it leaves every pot and its chips stay', () => {
    const { state } = newHand({ stacks: [30, 100, 100], button: 0 });
    const shoved = act(state, { kind: 'allIn' });
    expect(shoved.seats[0]?.status).toBe('allIn');
    const { state: after } = kill(shoved, 0);
    expect(after.seats[0]?.status).toBe('folded');
    expect(total(after)).toBe(230);
    // Play it out; the killed seat must never be paid.
    let s = after;
    for (let guard = 0; s.street !== 'complete' && guard < 50; guard++) {
      const legal = legalActions(s, s.actingSeat ?? -1);
      s = act(s, legal.canCheck ? { kind: 'check' } : { kind: 'call' });
    }
    expect(s.street).toBe('complete');
    expect(s.seats[0]?.stack).toBe(0);
    expect(s.seats[1]!.stack + s.seats[2]!.stack).toBe(230);
  });

  test('killing the only other seat that can bet runs out the board', () => {
    // Seat 0 all-in preflop; seats 1 and 2 call. Flop: seat 1 is killed before
    // anyone acts, leaving seat 2 as the only seat with chips — nobody left to
    // bet against, so the board runs out to showdown.
    const { state } = newHand({ stacks: [10, 100, 100], button: 0 });
    let s = act(state, { kind: 'allIn' });
    s = act(s, { kind: 'call' });
    s = act(s, { kind: 'call' });
    expect(s.street).toBe('flop');
    const { state: after } = kill(s, 1);
    expect(after.street).toBe('complete');
    expect(after.board).toHaveLength(5);
  });

  test('refuses a seat that is not in the hand, already folded, or a finished hand', () => {
    const { state } = newHand({ stacks: [100, 100, 100], button: 0 });
    expect(killHand(state, 5)).toEqual({ ok: false, reason: 'seatNotActive' });
    const folded = act(state, { kind: 'fold' });
    expect(killHand(folded, 0)).toEqual({ ok: false, reason: 'seatNotActive' });
    // Seat 0 is out; killing seat 1 leaves seat 2 alone, which ends the hand.
    const { state: done } = kill(folded, 1);
    expect(done.street).toBe('complete');
    expect(killHand(done, 2)).toEqual({ ok: false, reason: 'handComplete' });
  });

  test('a killed seat is not shown down', () => {
    // Check it down 3-handed, killing seat 0 on the river.
    const { state } = newHand({ stacks: [100, 100, 100], button: 0 });
    let s = act(state, { kind: 'call' });
    s = act(s, { kind: 'call' });
    s = act(s, { kind: 'check' });
    while (s.street !== 'river') s = act(s, { kind: 'check' });
    const { state: killed, events: killEvents } = kill(s, 0);
    let events: Event[] = [...killEvents];
    let current = killed;
    while (current.street !== 'complete') {
      const result = applyAction(current, { seat: current.actingSeat ?? -1, action: { kind: 'check' } });
      if (!result.ok) throw new Error(result.reason);
      current = result.state;
      events = [...events, ...result.events];
    }
    const showdown = events.find((e) => e.t === 'showdown');
    expect(showdown && showdown.t === 'showdown' && showdown.reveals.map((r) => r.seat)).not.toContain(0);
  });
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

type KillScenario = {
  stacks: number[];
  button: number;
  seed: number;
  /** Each entry: after this many actions, kill the n-th live seat (mod count). */
  kills: { afterActions: number; pick: number }[];
};

const arbitraryKillScenario = fc.record({
  stacks: fc.array(fc.oneof(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 1, max: 400 })), {
    minLength: 2,
    maxLength: 9,
  }),
  button: fc.nat(8),
  seed: fc.integer({ min: 1, max: 2 ** 30 }),
  kills: fc.array(fc.record({ afterActions: fc.nat(20), pick: fc.nat(8) }), {
    minLength: 1,
    maxLength: 4,
  }),
}) satisfies fc.Arbitrary<KillScenario>;

function pickAction(legal: LegalActions, rng: () => number): Action {
  const options: Action[] = [];
  if (legal.canCheck) options.push({ kind: 'check' }, { kind: 'check' });
  if (legal.canCall) options.push({ kind: 'call' }, { kind: 'call' });
  if (legal.canFold) options.push({ kind: 'fold' });
  if (legal.canBet) {
    options.push({ kind: 'bet', to: chips(legal.minBet + Math.floor(rng() * (legal.maxBet - legal.minBet + 1))) });
  }
  if (legal.canRaise) {
    options.push({
      kind: 'raise',
      to: chips(legal.minRaise + Math.floor(rng() * (legal.maxRaise - legal.minRaise + 1))),
    });
  }
  if (legal.canAllIn) options.push({ kind: 'allIn' });
  const choice = options[Math.floor(rng() * options.length)];
  if (!choice) throw new Error('legalActions offered nothing while a seat was acting');
  return choice;
}

type Played = {
  states: HandState[];
  events: Event[];
  initialTotal: number;
  initialStacks: number[];
  killed: Set<number>;
  /** Each killed seat's stack at the moment it was killed. */
  stackWhenKilled: Map<number, number>;
};

function playWithKills(sc: KillScenario): Played {
  const seats = sc.stacks.map((stack, i) => seatRow(i, stack));
  const start = startHand({
    seats,
    button: sc.button % sc.stacks.length,
    blinds: BLINDS_1_2,
    deck: testShuffle(sc.seed),
    handNumber: 1,
    rules: DEFAULT_RULES,
  });
  const rng = testRng(sc.seed);
  const states: HandState[] = [start.state];
  const events: Event[] = [...start.events];
  const killed = new Set<number>();
  const stackWhenKilled = new Map<number, number>();
  const pending = [...sc.kills].sort((a, b) => a.afterActions - b.afterActions);
  let state = start.state;
  let actions = 0;

  for (let guard = 0; state.street !== 'complete'; guard++) {
    if (guard > 600) throw new Error('hand did not terminate');
    const due = pending[0];
    if (due && due.afterActions <= actions) {
      pending.shift();
      const live = state.seats.filter(
        (s) => s.holeCards.length === 2 && s.status !== 'folded',
      );
      const victim = live[due.pick % live.length];
      if (!victim) throw new Error('no live seat in an unfinished hand');
      const result = killHand(state, victim.index);
      if (!result.ok) throw new Error(`killHand refused a live seat: ${result.reason}`);
      killed.add(victim.index);
      stackWhenKilled.set(victim.index, victim.stack);
      state = result.state;
      states.push(state);
      events.push(...result.events);
      continue;
    }
    const seat = state.actingSeat;
    if (seat === null) throw new Error(`street ${state.street} incomplete but no acting seat`);
    const result = applyAction(state, { seat, action: pickAction(legalActions(state, seat), rng) });
    if (!result.ok) throw new Error(`legal action rejected: ${result.reason}`);
    state = result.state;
    states.push(state);
    events.push(...result.events);
    actions += 1;
  }
  return {
    states,
    events,
    initialTotal: sc.stacks.reduce((a, b) => a + b, 0),
    initialStacks: [...sc.stacks],
    killed,
    stackWhenKilled,
  };
}

const RUNS = process.env['PROPERTY'] ? 20_000 : 1_500;

describe(`killHand property-based invariants (${RUNS} random hands)`, () => {
  test('property: chips are conserved when hands are killed at random moments', () => {
    fc.assert(
      fc.property(arbitraryKillScenario, (sc) => {
        const { states, initialTotal } = playWithKills(sc);
        for (const state of states) expect(total(state)).toBe(initialTotal);
      }),
      { numRuns: RUNS },
    );
  });

  test('property: no stack goes negative, and a killed seat never gets a chip back', () => {
    fc.assert(
      fc.property(arbitraryKillScenario, (sc) => {
        const { states, killed, stackWhenKilled } = playWithKills(sc);
        const final = states[states.length - 1] as HandState;
        for (const state of states) {
          for (const seat of state.seats) expect(seat.stack).toBeGreaterThanOrEqual(0);
        }
        for (const seat of killed) {
          expect(final.seats[seat]?.stack).toBe(stackWhenKilled.get(seat));
        }
      }),
      { numRuns: Math.ceil(RUNS / 2) },
    );
  });

  test('property: after a kill, side pots sum to contributions and every pot has a live seat to win it', () => {
    fc.assert(
      fc.property(arbitraryKillScenario, (sc) => {
        const { states, killed } = playWithKills(sc);
        const final = states[states.length - 1] as HandState;
        const potTotal = final.pots.reduce((sum, p) => sum + p.amount, 0);
        const committed = final.seats.reduce((sum, s) => sum + s.committedThisHand, 0);
        expect(potTotal).toBe(committed);
        for (const pot of final.pots) {
          expect(pot.eligibleSeats.length).toBeGreaterThan(0);
          for (const seat of pot.eligibleSeats) expect(killed.has(seat)).toBe(false);
        }
      }),
      { numRuns: Math.ceil(RUNS / 2) },
    );
  });

  test('property: a killed seat is never paid and never shown down', () => {
    fc.assert(
      fc.property(arbitraryKillScenario, (sc) => {
        const { events, killed } = playWithKills(sc);
        for (const e of events) {
          if (e.t === 'potAwarded') expect(killed.has(e.seat)).toBe(false);
          if (e.t === 'showdown') for (const r of e.reveals) expect(killed.has(r.seat)).toBe(false);
        }
      }),
      { numRuns: Math.ceil(RUNS / 2) },
    );
  });

  test('property: mid-hand there is always exactly one seat to act, and it can act', () => {
    fc.assert(
      fc.property(arbitraryKillScenario, (sc) => {
        const { states } = playWithKills(sc);
        for (const state of states) {
          if (state.street === 'complete') continue;
          const seat = state.actingSeat;
          expect(seat).not.toBeNull();
          const acting = state.seats[seat as number];
          expect(acting?.status).toBe('active');
          expect(acting?.isAllIn).toBe(false);
        }
      }),
      { numRuns: Math.ceil(RUNS / 2) },
    );
  });
});
