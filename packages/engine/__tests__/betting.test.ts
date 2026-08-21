import { describe, expect, test } from 'vitest';
import type { Card, Deck, HandState } from '../src/index.js';
import { applyAction, chips, decodeCard, encodeCard, legalActions, orderedDeck } from '../src/index.js';
import { newHand, seatRow, totalChips } from './helpers.js';
import { startHand } from '../src/index.js';
import { DEFAULT_RULES } from '../src/index.js';

/** A deck with specific cards up front (deal order), the rest of the 52 after. */
export function riggedDeck(front: string): Deck {
  const frontCards = front.split(' ').map(decodeCard);
  const used = new Set(frontCards.map(encodeCard));
  const rest = orderedDeck().filter((card: Card) => !used.has(encodeCard(card)));
  return [...frontCards, ...rest];
}

function act(state: HandState, seat: number, kind: 'fold' | 'check' | 'call' | 'allIn'): HandState;
function act(state: HandState, seat: number, kind: 'bet' | 'raise', to: number): HandState;
function act(
  state: HandState,
  seat: number,
  kind: 'fold' | 'check' | 'call' | 'allIn' | 'bet' | 'raise',
  to?: number,
): HandState {
  const action =
    kind === 'bet' || kind === 'raise' ? { kind, to: chips(to ?? 0) } : ({ kind } as const);
  const result = applyAction(state, { seat, action });
  if (!result.ok) throw new Error(`expected ${kind} by seat ${seat} to be legal: ${result.reason}`);
  return result.state;
}

describe('blinds and action order', () => {
  test('three-handed: small blind is left of the button, big blind next, UTG acts first', () => {
    const { state } = newHand({ stacks: [100, 100, 100], button: 0 });
    expect(state.seats[1]?.committedThisStreet).toBe(1);
    expect(state.seats[2]?.committedThisStreet).toBe(2);
    expect(state.actingSeat).toBe(0); // 3-handed: button is UTG pre-flop
  });

  test('heads-up: the button posts the small blind and acts FIRST pre-flop', () => {
    const { state } = newHand({ stacks: [100, 100], button: 0 });
    expect(state.seats[0]?.committedThisStreet).toBe(1); // button = small blind
    expect(state.seats[1]?.committedThisStreet).toBe(2);
    expect(state.actingSeat).toBe(0);
  });

  test('heads-up: the button acts LAST post-flop', () => {
    let s = newHand({ stacks: [100, 100], button: 0 }).state;
    s = act(s, 0, 'call');
    s = act(s, 1, 'check');
    expect(s.street).toBe('flop');
    expect(s.actingSeat).toBe(1); // big blind first, button last
  });

  test('a stack smaller than the blind posts what it has and is all-in; it does not owe the rest', () => {
    const { state } = newHand({ stacks: [100, 100, 1], button: 0 });
    const bb = state.seats[2];
    expect(bb?.committedThisStreet).toBe(1);
    expect(bb?.isAllIn).toBe(true);
    expect(bb?.stack).toBe(0);
    // The betting level stays at the full big blind.
    expect(state.currentBet).toBe(2);
  });

  test('everyone all-in from the blinds: the board runs out with no betting', () => {
    const { state } = newHand({ stacks: [2, 1, 2], button: 0, deck: riggedDeck(
      // deal order: seat1, seat2, seat0, seat1, seat2, seat0, then board
      '2h 3d Ah 2d 3c As 7s 8d 9c Jh Qd',
    ) });
    // seat 0 still has chips (stack 2, blinds not owed by button 3-handed)... seat 0 must call.
    // With stacks [2,1,2]: SB seat1 all-in for 1, BB seat2 all-in for 2, button acts.
    expect(state.actingSeat).toBe(0);
    const next = act(state, 0, 'call');
    expect(next.street).toBe('complete');
  });
});

describe('big blind option', () => {
  test('the round is not over until the big blind has acted, even when everyone just calls', () => {
    let s = newHand({ stacks: [100, 100, 100], button: 0 }).state;
    s = act(s, 0, 'call');
    s = act(s, 1, 'call');
    expect(s.street).toBe('preflop');
    expect(s.actingSeat).toBe(2);
    const legal = legalActions(s, 2);
    expect(legal.canCheck).toBe(true);
    expect(legal.canRaise).toBe(true); // the option
    s = act(s, 2, 'raise', 4);
    expect(s.street).toBe('preflop'); // callers must respond to the option raise
    expect(s.actingSeat).toBe(0);
  });

  test('big blind checks the option and the flop comes', () => {
    let s = newHand({ stacks: [100, 100, 100], button: 0 }).state;
    s = act(s, 0, 'call');
    s = act(s, 1, 'call');
    s = act(s, 2, 'check');
    expect(s.street).toBe('flop');
    expect(s.board).toHaveLength(3);
    expect(s.actingSeat).toBe(1); // first active left of the button
  });
});

describe('bet and raise sizing', () => {
  test('minimum opening bet post-flop is the big blind', () => {
    let s = newHand({ stacks: [100, 100], button: 0 }).state;
    s = act(s, 0, 'call');
    s = act(s, 1, 'check');
    const legal = legalActions(s, 1);
    expect(legal.canBet).toBe(true);
    expect(legal.minBet).toBe(2);
    const tooSmall = applyAction(s, { seat: 1, action: { kind: 'bet', to: chips(1) } });
    expect(tooSmall).toEqual({ ok: false, reason: 'raiseTooSmall' });
  });

  test('minimum raise is the size of the last bet or raise', () => {
    let s = newHand({ stacks: [500, 500, 500], button: 0 }).state;
    s = act(s, 0, 'raise', 10); // raise of 8 over the 2 blind
    const legal = legalActions(s, 1);
    expect(legal.minRaise).toBe(18); // 10 + 8
    const tooSmall = applyAction(s, { seat: 1, action: { kind: 'raise', to: chips(15) } });
    expect(tooSmall).toEqual({ ok: false, reason: 'raiseTooSmall' });
    s = act(s, 1, 'raise', 18);
    expect(legalActions(s, 2).minRaise).toBe(26); // 18 + 8
  });

  test('cannot check facing a bet; cannot bet when a bet already stands', () => {
    const s = newHand({ stacks: [100, 100, 100], button: 0 }).state;
    expect(applyAction(s, { seat: 0, action: { kind: 'check' } })).toEqual({
      ok: false,
      reason: 'cannotCheckFacingBet',
    });
    expect(applyAction(s, { seat: 0, action: { kind: 'bet', to: chips(10) } })).toEqual({
      ok: false,
      reason: 'betNotAllowedFacingBet',
    });
  });

  test('acting out of turn is rejected', () => {
    const s = newHand({ stacks: [100, 100, 100], button: 0 }).state;
    expect(applyAction(s, { seat: 1, action: { kind: 'fold' } })).toEqual({
      ok: false,
      reason: 'notYourTurn',
    });
  });
});

describe('all-in for less than a full raise (house rule 3)', () => {
  // Six seats: 0 button, 1 SB, 2 BB, 3 raises to 100, 4 shoves 150 (short of the
  // 198 minimum), 5 calls. Action back on 3: call or fold ONLY.
  function scenario() {
    let s = newHand({ stacks: [1000, 1000, 1000, 1000, 150, 1000], button: 0 }).state;
    s = act(s, 3, 'raise', 100);
    s = act(s, 4, 'allIn'); // 150 total — a raise of 50, less than the full 98
    return s;
  }

  test('a player who has NOT yet acted may still raise', () => {
    const s = scenario();
    expect(s.actingSeat).toBe(5);
    const legal = legalActions(s, 5);
    expect(legal.canRaise).toBe(true);
    expect(legal.minRaise).toBe(248); // 150 + the last FULL raise of 98
  });

  test('a player who already acted may only call or fold — the action is not reopened', () => {
    let s = scenario();
    s = act(s, 5, 'call');
    s = act(s, 0, 'fold');
    s = act(s, 1, 'fold');
    s = act(s, 2, 'fold');
    expect(s.actingSeat).toBe(3);
    const legal = legalActions(s, 3);
    expect(legal.canCall).toBe(true);
    expect(legal.callAmount).toBe(50);
    expect(legal.canRaise).toBe(false);
    expect(legal.canAllIn).toBe(false); // an all-in here would be an illegal raise
    expect(applyAction(s, { seat: 3, action: { kind: 'raise', to: chips(300) } })).toEqual({
      ok: false,
      reason: 'raiseNotAllowed',
    });
  });

  test('a full raise after the short all-in reopens the action for everyone', () => {
    let s = scenario();
    s = act(s, 5, 'raise', 250); // full raise (min was 248)
    s = act(s, 0, 'fold');
    s = act(s, 1, 'fold');
    s = act(s, 2, 'fold');
    expect(legalActions(s, 3).canRaise).toBe(true);
  });
});

describe('street progression and hand completion', () => {
  test('checked-down hand reaches showdown and awards the pot', () => {
    let s = newHand({ stacks: [100, 100], button: 0 }).state;
    const before = totalChips(s);
    s = act(s, 0, 'call');
    s = act(s, 1, 'check'); // flop
    s = act(s, 1, 'check');
    s = act(s, 0, 'check'); // turn
    s = act(s, 1, 'check');
    s = act(s, 0, 'check'); // river
    s = act(s, 1, 'check');
    s = act(s, 0, 'check');
    expect(s.street).toBe('complete');
    expect(s.board).toHaveLength(5);
    expect(totalChips(s)).toBe(before);
    expect(s.seats.reduce((sum, x) => sum + x.stack, 0)).toBe(200);
  });

  test('when everyone folds, the last player standing wins without a showdown', () => {
    let s = newHand({ stacks: [100, 100, 100], button: 0 }).state;
    const result = applyAction(s, { seat: 0, action: { kind: 'raise', to: chips(10) } });
    if (!result.ok) throw new Error('raise should be legal');
    s = result.state;
    s = act(s, 1, 'fold');
    const final = applyAction(s, { seat: 2, action: { kind: 'fold' } });
    if (!final.ok) throw new Error('fold should be legal');
    expect(final.state.street).toBe('complete');
    // Winner gets the blinds plus their own raise back: 100 - 10 + 13 = 103.
    expect(final.state.seats[0]?.stack).toBe(103);
    expect(final.events.some((e) => e.t === 'potAwarded' && e.seat === 0)).toBe(true);
    expect(final.events.some((e) => e.t === 'showdown')).toBe(false);
  });

  test('big blind ante is posted by the big blind for the table, before the blinds', () => {
    const seats = [seatRow(0, 100), seatRow(1, 100), seatRow(2, 100)];
    const { state, events } = startHand({
      seats,
      button: 0,
      blinds: { smallBlind: chips(1), bigBlind: chips(2), ante: chips(2), anteType: 'bigBlindAnte' },
      deck: riggedDeck('2h 3d 4h 2d 3c 4s'),
      handNumber: 1,
      rules: DEFAULT_RULES,
    });
    const bb = state.seats[2];
    expect(bb?.committedThisHand).toBe(4); // 2 ante + 2 big blind
    expect(bb?.committedThisStreet).toBe(2); // the ante does NOT count toward calling
    const anteEvents = events.filter((e) => e.t === 'blindPosted' && e.blind === 'ante');
    expect(anteEvents).toHaveLength(1);
  });

  test('per-player antes go into the pot from every dealt-in seat', () => {
    const seats = [seatRow(0, 100), seatRow(1, 100), seatRow(2, 100)];
    const { state } = startHand({
      seats,
      button: 0,
      blinds: { smallBlind: chips(1), bigBlind: chips(2), ante: chips(1), anteType: 'perPlayer' },
      deck: riggedDeck('2h 3d 4h 2d 3c 4s'),
      handNumber: 1,
      rules: DEFAULT_RULES,
    });
    expect(state.seats[0]?.committedThisHand).toBe(1);
    expect(state.seats[1]?.committedThisHand).toBe(2); // 1 ante + 1 small blind
    expect(state.seats[2]?.committedThisHand).toBe(3); // 1 ante + 2 big blind
  });
});
