// killHand: the host removed a player mid-hand (HOUSE-RULES #14, #19, #20).
// Their hand is dead at once — not when the action reaches them, and not on a
// clock — and the hand carries on exactly as if they had folded: their bet
// still has to be called. What nobody still holding cards ever matches goes
// back to whoever put it in (#19), so nobody wins more than they risked.
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

  test('killing everyone but one ends the hand; the part of the raise nobody called goes back (#19)', () => {
    const { state } = newHand({ stacks: [100, 100], button: 0 });
    // Heads-up: button (seat 0) is the small blind and raises to 20. Seat 1
    // has only its big blind (2) in when seat 0 is removed.
    const raised = act(state, { kind: 'raise', to: chips(20) });
    const { state: after, events } = kill(raised, 0);
    expect(after.street).toBe('complete');
    // Seat 1 wins what it matched: 2 from seat 0. The other 18 nobody called,
    // so it goes back to seat 0 — and leaves the table with them.
    expect(events).toContainEqual({ t: 'betReturned', seat: 0, amount: 18 });
    expect(after.seats[1]?.stack).toBe(102);
    expect(after.seats[0]?.stack).toBe(98);
    expect(total(after)).toBe(200);
  });

  test('Kevin’s case: a short all-in wins only what it matched; the folder and the removed player get the rest back', () => {
    // HOUSE-RULES #19, decided 11 Oct 2026. Button 0, blinds 1/2.
    // X (seat 0) is all-in for 20 pre-flop; Y (seat 1) and Z (seat 2) call.
    // Flop: Y bets 30, Z raises to 100 and is removed; Y folds to Z's bet.
    // Nobody still holding cards matched anything above X's 20, so:
    //   X wins 60 — 20 from each of the three, never more than X risked;
    //   Y gets its 30 back; Z gets its 100 back, which leaves with Z.
    const { state } = newHand({ stacks: [20, 200, 200], button: 0 });
    let s = act(state, { kind: 'allIn' }); // X
    s = act(s, { kind: 'call' }); // Y
    s = act(s, { kind: 'call' }); // Z (big blind)
    expect(s.street).toBe('flop');
    expect(s.actingSeat).toBe(1);
    s = act(s, { kind: 'bet', to: chips(30) }); // Y
    s = act(s, { kind: 'raise', to: chips(100) }); // Z
    const killed = kill(s, 2);
    expect(killed.state.actingSeat).toBe(1); // Y still faces Z's bet (#20)
    expect(legalActions(killed.state, 1).callAmount).toBe(70);
    const folded = applyAction(killed.state, { seat: 1, action: { kind: 'fold' } });
    if (!folded.ok) throw new Error(folded.reason);
    const done = folded.state;
    expect(done.street).toBe('complete');
    expect(folded.events).toContainEqual({ t: 'betReturned', seat: 1, amount: 30 });
    expect(folded.events).toContainEqual({ t: 'betReturned', seat: 2, amount: 100 });
    expect(done.seats[0]?.stack).toBe(60);
    expect(done.seats[1]?.stack).toBe(180);
    expect(done.seats[2]?.stack).toBe(180);
  });

  test('#19 covers every unmatched chip in the hand, not only the removed player’s: a folded ante and blind go back too', () => {
    // Found by the review of the first #19 build, which only handed back chips
    // at levels the removed player had reached. Blinds 5/10, ante 5 each,
    // button 0. B (seat 2) has 1 chip and is all-in on the ante. U (seat 0)
    // is removed with its ante in; S (seat 1, small blind) folds. B risked 1,
    // so B wins 1 from each of the others — 3 — and everything else goes back.
    const blinds = { smallBlind: chips(5), bigBlind: chips(10), ante: chips(5), anteType: 'perPlayer' as const };
    const { state } = newHand({ stacks: [200, 200, 1], button: 0, blinds });
    expect(state.actingSeat).toBe(0);
    let s = kill(state, 0).state;
    const folded = applyAction(s, { seat: s.actingSeat ?? -1, action: { kind: 'fold' } });
    if (!folded.ok) throw new Error(folded.reason);
    s = folded.state;
    expect(s.street).toBe('complete');
    expect(s.seats[2]?.stack).toBe(3);
    expect(s.seats[1]?.stack).toBe(199);
    expect(s.seats[0]?.stack).toBe(199);
    expect(folded.events).toContainEqual({ t: 'betReturned', seat: 1, amount: 9 });
    expect(folded.events).toContainEqual({ t: 'betReturned', seat: 0, amount: 4 });
  });

  test('#19 is worked out when the hand ends: a later live bet matches an earlier folder’s chips, so they stay in', () => {
    // Blinds 1/2 with a big-blind ante of 5, button 0: the big blind (seat 2)
    // has 7 in. Seat 3 is removed before acting; seat 0 raises to 4, seat 1
    // calls, and the big blind folds with 7 in — more than either live player
    // at that moment. On the flop they bet 10 and call, so the live stakes
    // pass 7: every chip the big blind put in IS matched, and none goes back.
    // Handing chips back at the end of each street would have returned 3.
    const blinds = { smallBlind: chips(1), bigBlind: chips(2), ante: chips(5), anteType: 'bigBlindAnte' as const };
    const { state } = newHand({ stacks: [100, 100, 100, 100], button: 0, blinds });
    expect(state.seats[2]?.committedThisHand).toBe(7);
    expect(state.actingSeat).toBe(3);
    let s = kill(state, 3).state;
    const events: Event[] = [];
    const step = (action: Action) => {
      const result = applyAction(s, { seat: s.actingSeat ?? -1, action });
      if (!result.ok) throw new Error(result.reason);
      s = result.state;
      events.push(...result.events);
    };
    step({ kind: 'raise', to: chips(4) }); // seat 0
    step({ kind: 'call' }); // seat 1
    step({ kind: 'fold' }); // seat 2, the big blind, with 7 in
    expect(s.street).toBe('flop');
    step({ kind: 'bet', to: chips(10) }); // seat 1
    step({ kind: 'call' }); // seat 0
    while (s.street !== 'complete') step({ kind: 'check' });
    expect(events.some((e) => e.t === 'betReturned')).toBe(false);
    expect(total(s)).toBe(400);
  });

  test('a removed bet that IS called stays in the pot (#20)', () => {
    // Same start, but Y calls Z's 100 instead of folding. A call is a match:
    // nothing goes back, and Y — the only live seat in that side pot — wins it.
    const { state } = newHand({ stacks: [20, 200, 200], button: 0 });
    let s = act(state, { kind: 'allIn' });
    s = act(s, { kind: 'call' });
    s = act(s, { kind: 'call' });
    s = act(s, { kind: 'bet', to: chips(30) });
    s = act(s, { kind: 'raise', to: chips(100) });
    let after = kill(s, 2).state;
    const events: Event[] = [];
    while (after.street !== 'complete') {
      const legal = legalActions(after, after.actingSeat ?? -1);
      const result = applyAction(after, {
        seat: after.actingSeat ?? -1,
        action: legal.canCheck ? { kind: 'check' } : { kind: 'call' },
      });
      if (!result.ok) throw new Error(result.reason);
      after = result.state;
      events.push(...result.events);
    }
    expect(events.some((e) => e.t === 'betReturned')).toBe(false);
    // Z's 120 is all in the pot; Y won at least the side pot of Z's money.
    expect(after.seats[2]?.stack).toBe(80);
    expect(total(after)).toBe(420);
  });

  test('when every chip in the middle is from removed hands, it all goes back and nobody wins it', () => {
    // 4-handed, button 0: blinds on 1 and 2, seat 3 to act. Remove the blinds
    // and seat 3. The button has put nothing in, so it wins nothing; the
    // blinds go back to the removed players (#19). This used to throw, then
    // used to hand the button 3 chips it never risked.
    const { state } = newHand({ stacks: [100, 100, 100, 100], button: 0 });
    let s = kill(state, 1).state;
    s = kill(s, 2).state;
    const { state: done, events } = kill(s, 3);
    expect(done.street).toBe('complete');
    expect(done.seats[0]?.stack).toBe(100);
    expect(done.seats[1]?.stack).toBe(100);
    expect(done.seats[2]?.stack).toBe(100);
    expect(events).toContainEqual({ t: 'betReturned', seat: 2, amount: 2 });
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

  test('a killed last aggressor: the showdown starts left of the button, as with no aggressor', () => {
    // 4-handed, button 0. Checked to the river; seat 2 bets and is killed;
    // seats 3, 0 and 1 call. Rule: last aggressor first, otherwise the first
    // seat left of the button — the dead aggressor is not in the showdown.
    const { state } = newHand({ stacks: [100, 100, 100, 100], button: 0 });
    let s = act(state, { kind: 'call' }); // 3
    s = act(s, { kind: 'call' }); // 0
    s = act(s, { kind: 'call' }); // 1
    s = act(s, { kind: 'check' }); // 2
    while (s.street !== 'river') s = act(s, { kind: 'check' });
    expect(s.actingSeat).toBe(1);
    s = act(s, { kind: 'check' }); // 1
    s = act(s, { kind: 'bet', to: chips(10) }); // 2
    const killed = kill(s, 2);
    let after = killed.state;
    const collected: Event[] = [...killed.events];
    while (after.street !== 'complete') {
      const result = applyAction(after, { seat: after.actingSeat ?? -1, action: { kind: 'call' } });
      if (!result.ok) throw new Error(result.reason);
      after = result.state;
      collected.push(...result.events);
    }
    const showdown = collected.find((e) => e.t === 'showdown');
    if (!showdown || showdown.t !== 'showdown') throw new Error('no showdown');
    expect(showdown.reveals.map((r) => r.seat)).toEqual([1, 3, 0]);
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
  /** Antes and returning players' dead posts: chips that are in the pot
   *  without being anyone's bet — exactly what #19 has to get right. */
  ante: 0 | 1 | 2;
  anteType: 'none' | 'perPlayer' | 'bigBlindAnte';
  postSeats: number[];
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
  ante: fc.constantFrom(0, 1, 2) as fc.Arbitrary<0 | 1 | 2>,
  anteType: fc.constantFrom('none', 'perPlayer', 'bigBlindAnte') as fc.Arbitrary<
    'none' | 'perPlayer' | 'bigBlindAnte'
  >,
  postSeats: fc.array(fc.nat(8), { maxLength: 3 }),
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

/** Chips handed back to each seat over the hand (betReturned events). */
function returnedBySeat(events: readonly Event[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const e of events) if (e.t === 'betReturned') out.set(e.seat, (out.get(e.seat) ?? 0) + e.amount);
  return out;
}

function playWithKills(sc: KillScenario): Played {
  const deal = {
    seats: sc.stacks.map((stack, i) => seatRow(i, stack)),
    button: sc.button % sc.stacks.length,
    blinds: {
      ...BLINDS_1_2,
      ante: chips(sc.ante),
      anteType: sc.ante === 0 ? ('none' as const) : sc.anteType,
    },
    deck: testShuffle(sc.seed),
    handNumber: 1,
    rules: DEFAULT_RULES,
  };
  // As in property.test.ts: only the big blind may not also post, and which
  // seat that is comes off the engine's own handStarted event.
  const opening = startHand(deal).events.find((e) => e.t === 'handStarted');
  if (!opening || opening.t !== 'handStarted') throw new Error('no handStarted event');
  const posts = [...new Set(sc.postSeats)]
    .filter((seat) => seat < sc.stacks.length && seat !== opening.bigBlindSeat)
    .map((seat) => ({ seat, amount: chips(2) }));
  const start = startHand({ ...deal, seats: sc.stacks.map((stack, i) => seatRow(i, stack)), posts });
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

  test('property: no stack or commitment goes negative, and a killed seat gets back only its own unmatched chips', () => {
    fc.assert(
      fc.property(arbitraryKillScenario, (sc) => {
        const { states, events, killed, stackWhenKilled } = playWithKills(sc);
        const final = states[states.length - 1] as HandState;
        for (const state of states) {
          for (const seat of state.seats) {
            expect(seat.stack).toBeGreaterThanOrEqual(0);
            expect(seat.committedThisHand).toBeGreaterThanOrEqual(0);
          }
        }
        const returned = returnedBySeat(events);
        for (const seat of killed) {
          // Never a pot — only what it put in that nobody live matched.
          expect(final.seats[seat]?.stack).toBe(
            (stackWhenKilled.get(seat) ?? 0) + (returned.get(seat) ?? 0),
          );
        }
      }),
      { numRuns: Math.ceil(RUNS / 2) },
    );
  });

  test('property: after a kill, nobody wins chips that no live player matched (#19)', () => {
    // At the end of the hand, no seat may have more in the pot than the
    // largest stake of a seat still holding cards: anything above that was
    // matched by nobody who could win it, and went back to whoever put it in —
    // antes and dead posts included, in a hand with a removal.
    fc.assert(
      fc.property(arbitraryKillScenario, (sc) => {
        const { states, initialStacks, killed } = playWithKills(sc);
        // A hand can end before its scheduled removal. Then nobody was removed,
        // and a folded ante is ordinary dead money that rightly goes to the
        // winner — #19 has nothing to say about it.
        if (killed.size === 0) return;
        const final = states[states.length - 1] as HandState;
        const live = final.seats.filter((s) => s.holeCards.length === 2 && s.status !== 'folded');
        // finishHand relabels a broke seat 'busted'; the kill marked it dead.
        const stillIn = live.filter((s) => !final.deadHands.includes(s.index));
        const biggestLiveStake = Math.max(0, ...stillIn.map((s) => s.committedThisHand));
        for (const seat of final.seats) {
          expect(seat.committedThisHand).toBeLessThanOrEqual(biggestLiveStake);
        }
        // And the corollary Kevin asked for: a winner's profit is bounded by
        // what it risked against each opponent.
        for (const seat of stillIn) {
          const start = initialStacks[seat.index] ?? 0;
          const opponents = final.seats.filter((o) => o.index !== seat.index && o.holeCards.length === 2);
          const maxWin = opponents.reduce((sum, o) => sum + Math.min(o.committedThisHand, seat.committedThisHand), 0);
          expect(seat.stack - (start - seat.committedThisHand)).toBeLessThanOrEqual(
            seat.committedThisHand + maxWin,
          );
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
