// What the engine REFUSES. The server Zod-parses everything at the socket
// boundary, so in a healthy system none of these paths fire — which is exactly
// why they need tests. They are the last line of defence if that parsing ever
// regresses, and an untested guard is indistinguishable from a missing one.
//
// Note the two return shapes: illegal *player* input is `{ ok: false, reason }`
// (a mistake — tell them and move on), while impossible *table* state throws
// EngineError (a bug — crash loudly). See engine.ts:550.
import { describe, expect, test } from 'vitest';
import type { Action, Chips, Seat } from '../src/index.js';
import { applyAction, chips, DEFAULT_RULES, EngineError, startHand } from '../src/index.js';
import { BLINDS_1_2, newHand, seatRow, testShuffle } from './helpers.js';

/** Bypass the Chips brand deliberately — the point is to feed the engine junk. */
const raw = (n: number): Chips => n as Chips;

const table = (seats: Seat[], button = 0) =>
  startHand({
    seats,
    button,
    blinds: BLINDS_1_2,
    deck: testShuffle(1),
    handNumber: 1,
    rules: DEFAULT_RULES,
  });

describe('startHand refuses a malformed table', () => {
  test('a big blind below one chip is not a stake', () => {
    expect(() =>
      startHand({
        seats: [seatRow(0, 100), seatRow(1, 100)],
        button: 0,
        blinds: { ...BLINDS_1_2, bigBlind: raw(0) },
        deck: testShuffle(1),
        handNumber: 1,
        rules: DEFAULT_RULES,
      }),
    ).toThrow(/bigBlind/);
  });

  test.each([
    ['a negative small blind', { smallBlind: raw(-1) }],
    ['a negative ante', { ante: raw(-5) }],
  ])('%s is rejected', (_label, override) => {
    expect(() =>
      startHand({
        seats: [seatRow(0, 100), seatRow(1, 100)],
        button: 0,
        blinds: { ...BLINDS_1_2, ...override },
        deck: testShuffle(1),
        handNumber: 1,
        rules: DEFAULT_RULES,
      }),
    ).toThrow(/negative blind or ante/);
  });

  test('a seat whose index does not match its position is rejected', () => {
    // Silent corruption here would misroute chips to the wrong player.
    const seats = [seatRow(0, 100), { ...seatRow(1, 100), index: 7 }];
    expect(() => table(seats)).toThrow(/mismatched index/);
  });

  test.each([
    ['a negative button', -1],
    ['a button past the last seat', 2],
  ])('%s is rejected', (_label, button) => {
    expect(() => table([seatRow(0, 100), seatRow(1, 100)], button)).toThrow(/button out of range/);
  });

  test('one player is not a hand', () => {
    expect(() => table([seatRow(0, 100), seatRow(1, 0)])).toThrow(/at least two players/);
  });

  test('the button may not sit on a player who is not dealt in', () => {
    // Seat 0 is sitting out, so the button has nowhere legitimate to be.
    const seats = [{ ...seatRow(0, 100), status: 'sittingOut' as const }, seatRow(1, 100), seatRow(2, 100)];
    expect(() => table(seats, 0)).toThrow(/button must be on a seat that is dealt in/);
  });

  test('empty, sitting-out and busted seats are classified, not dealt in', () => {
    const seats = [
      seatRow(0, 100),
      seatRow(1, 100),
      { ...seatRow(2, 100), status: 'sittingOut' as const },
      seatRow(3, 100, null), // nobody there
      seatRow(4, 0), // seated, but stacked out
    ];
    const { state } = table(seats, 0);
    expect(state.seats[2]?.status).toBe('sittingOut');
    expect(state.seats[3]?.status).toBe('empty');
    expect(state.seats[4]?.status).toBe('busted');
    // None of the three received cards.
    for (const i of [2, 3, 4]) expect(state.seats[i]?.holeCards).toHaveLength(0);
  });
});

describe('applyAction refuses illegal input', () => {
  test('nobody can act once the hand is complete', () => {
    let s = newHand({ stacks: [100, 100, 100], button: 0 }).state;
    for (const seat of [0, 1]) {
      const r = applyAction(s, { seat, action: { kind: 'fold' } });
      if (!r.ok) throw new Error('fold should be legal');
      s = r.state;
    }
    expect(s.street).toBe('complete');
    expect(applyAction(s, { seat: 2, action: { kind: 'check' } })).toEqual({
      ok: false,
      reason: 'handComplete',
    });
  });

  test('a seat that is not active cannot act even when the clock points at it', () => {
    // Corrupt state on purpose: seat 0 folds, then we aim actingSeat back at it.
    const s = newHand({ stacks: [100, 100, 100], button: 0 }).state;
    const folded = applyAction(s, { seat: 0, action: { kind: 'fold' } });
    if (!folded.ok) throw new Error('fold should be legal');
    const corrupt = { ...folded.state, actingSeat: 0 };
    expect(applyAction(corrupt, { seat: 0, action: { kind: 'check' } })).toEqual({
      ok: false,
      reason: 'seatNotActive',
    });
  });

  test('you cannot call when nothing is owed — that is a check', () => {
    let s = newHand({ stacks: [100, 100], button: 0 }).state;
    for (const [seat, kind] of [[0, 'call'], [1, 'check']] as const) {
      const r = applyAction(s, { seat, action: { kind } });
      if (!r.ok) throw new Error(`${kind} should be legal`);
      s = r.state;
    }
    expect(s.street).toBe('flop');
    expect(applyAction(s, { seat: 1, action: { kind: 'call' } })).toEqual({
      ok: false,
      reason: 'nothingToCall',
    });
  });

  describe('bet sizing', () => {
    /** Heads-up, on the flop, no bet yet — seat 1 is first to act. */
    function onFlop() {
      let s = newHand({ stacks: [100, 100], button: 0 }).state;
      for (const [seat, kind] of [[0, 'call'], [1, 'check']] as const) {
        const r = applyAction(s, { seat, action: { kind } });
        if (!r.ok) throw new Error(`${kind} should be legal`);
        s = r.state;
      }
      return s;
    }

    test.each([
      ['zero', 0],
      ['negative', -10],
      ['fractional', 2.5],
    ])('a %s bet is not a bet', (_label, to) => {
      expect(applyAction(onFlop(), { seat: 1, action: { kind: 'bet', to: raw(to) } })).toEqual({
        ok: false,
        reason: 'raiseTooSmall',
      });
    });

    test('you cannot bet chips you do not have', () => {
      expect(applyAction(onFlop(), { seat: 1, action: { kind: 'bet', to: raw(5000) } })).toEqual({
        ok: false,
        reason: 'insufficientChips',
      });
    });

    test('raising is not a legal way to open a street', () => {
      expect(applyAction(onFlop(), { seat: 1, action: { kind: 'raise', to: raw(10) } })).toEqual({
        ok: false,
        reason: 'betNotAllowedFacingBet',
      });
    });
  });

  describe('raise sizing', () => {
    test.each([
      ['below the current bet', 1],
      ['exactly the current bet', 2],
      ['fractional', 4.5],
    ])('a raise %s is rejected', (_label, to) => {
      const s = newHand({ stacks: [100, 100, 100], button: 0 }).state;
      expect(applyAction(s, { seat: 0, action: { kind: 'raise', to: raw(to) } })).toEqual({
        ok: false,
        reason: 'raiseTooSmall',
      });
    });

    test('you cannot raise past your stack', () => {
      const s = newHand({ stacks: [100, 100, 100], button: 0 }).state;
      expect(applyAction(s, { seat: 0, action: { kind: 'raise', to: raw(101) } })).toEqual({
        ok: false,
        reason: 'insufficientChips',
      });
    });
  });

  test('going all-in is refused when it would be an illegal raise', () => {
    // House rule 3: seat 4's short shove did not reopen the action, so seat 3 —
    // who already acted — may only call or fold. Shoving is a raise by another
    // name, and legalActions already says canAllIn is false; this proves the
    // engine enforces it rather than merely advertising it.
    let s = newHand({ stacks: [1000, 1000, 1000, 1000, 150, 1000], button: 0 }).state;
    for (const [seat, action] of [
      [3, { kind: 'raise', to: chips(100) }],
      [4, { kind: 'allIn' }],
      [5, { kind: 'call' }],
      [0, { kind: 'fold' }],
      [1, { kind: 'fold' }],
      [2, { kind: 'fold' }],
    ] as const) {
      const r = applyAction(s, { seat, action });
      if (!r.ok) throw new Error(`seat ${seat} ${action.kind} should be legal: ${r.reason}`);
      s = r.state;
    }
    expect(s.actingSeat).toBe(3);
    expect(applyAction(s, { seat: 3, action: { kind: 'allIn' } })).toEqual({
      ok: false,
      reason: 'raiseNotAllowed',
    });
  });

  test('an action kind the engine does not know is a bug, and throws', () => {
    const s = newHand({ stacks: [100, 100, 100], button: 0 }).state;
    const bogus = { kind: 'muck' } as unknown as Action;
    expect(() => applyAction(s, { seat: 0, action: bogus })).toThrow(EngineError);
  });
});
