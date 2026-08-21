import { describe, expect, test } from 'vitest';
import type { HandState } from '../src/index.js';
import { applyAction, chips } from '../src/index.js';
import { newHand } from './helpers.js';
import { riggedDeck } from './betting.test.js';

function act(state: HandState, seat: number, kind: 'fold' | 'check' | 'call' | 'allIn'): HandState {
  const result = applyAction(state, { seat, action: { kind } });
  if (!result.ok) throw new Error(`expected ${kind} by seat ${seat} to be legal: ${result.reason}`);
  return result.state;
}

describe('side pots', () => {
  test('three-way all-in at three different stack sizes builds and awards correct pots', () => {
    // Button seat 0 (200 chips, KK), SB seat 1 (100, QQ), BB seat 2 (50, AA).
    // Deal order is seat1, seat2, seat0, repeated; then the board.
    const deck = riggedDeck('Qs Ah Kd Qh As Kc 2s 7d 9c 3h 4d');
    let s = newHand({ stacks: [200, 100, 50], button: 0, deck }).state;

    s = act(s, 0, 'allIn'); // 200
    s = act(s, 1, 'allIn'); // 100
    const result = applyAction(s, { seat: 2, action: { kind: 'allIn' } }); // 50
    if (!result.ok) throw new Error(result.reason);
    s = result.state;

    expect(s.street).toBe('complete');
    // Main pot: 50 × 3 = 150 → AA (seat 2).
    // Side pot 1: 50 × 2 = 100 → KK beats QQ (seat 0).
    // Side pot 2: 100 uncalled → returned to seat 0.
    expect(s.seats[2]?.stack).toBe(150);
    expect(s.seats[0]?.stack).toBe(200);
    expect(s.seats[1]?.stack).toBe(0);
    expect(s.seats[1]?.status).toBe('busted');

    const awards = result.events.filter((e) => e.t === 'potAwarded');
    expect(awards).toHaveLength(3);
  });

  test('a folded seat’s chips stay in the pot but the seat is not eligible', () => {
    // 3 players, everyone 100. Seat 0 raises, seat 1 calls, seat 2 folds (loses blind).
    const deck = riggedDeck('4h Ah Kd 5h As Kc 2s 7d 9c 3h 8d');
    let s = newHand({ stacks: [100, 100, 100], button: 0, deck }).state;
    const r = applyAction(s, { seat: 0, action: { kind: 'raise', to: chips(10) } });
    if (!r.ok) throw new Error(r.reason);
    s = r.state;
    s = act(s, 1, 'call');
    s = act(s, 2, 'fold');
    // Pot after preflop: 10 + 10 + 2 = 22, eligible seats 0 and 1 only.
    expect(s.pots).toHaveLength(1);
    expect(s.pots[0]?.amount).toBe(22);
    expect(s.pots[0]?.eligibleSeats).toEqual([0, 1]);
  });

  test('split pot: the odd chip goes to the first eligible seat left of the button', () => {
    // Board plays for both remaining players. SB folds leaving an odd pot of 5.
    // Board: Broadway. Holes: rag cards that never play.
    const deck = riggedDeck('4h 2d 2h 5h 3s 3d As Kd Qh Jc Ts');
    let s = newHand({ stacks: [100, 100, 100], button: 0, deck }).state;
    s = act(s, 0, 'call');
    s = act(s, 1, 'fold'); // SB folds; pot now odd: 2 + 2 + 1 = 5
    s = act(s, 2, 'check');
    // Check it down to showdown.
    s = act(s, 2, 'check'); s = act(s, 0, 'check'); // flop
    s = act(s, 2, 'check'); s = act(s, 0, 'check'); // turn
    s = act(s, 2, 'check'); s = act(s, 0, 'check'); // river
    expect(s.street).toBe('complete');
    // Both play the board straight. Seat 2 is first eligible left of the button.
    expect(s.seats[2]?.stack).toBe(98 + 3); // 101
    expect(s.seats[0]?.stack).toBe(98 + 2); // 100
  });

  test('an uncalled bet is returned: betting into an all-in for less', () => {
    // Heads-up. Seat 1 has 30, seat 0 has 200. Seat 0 shoves, seat 1 calls all-in for 30.
    const deck = riggedDeck('Ah Kd As Kc 2s 7d 9c 3h 4d');
    let s = newHand({ stacks: [200, 30], button: 0, deck }).state;
    s = act(s, 0, 'allIn'); // 200 total
    const r = applyAction(s, { seat: 1, action: { kind: 'call' } });
    if (!r.ok) throw new Error(r.reason);
    s = r.state;
    expect(s.street).toBe('complete');
    // Seat 1 (AA) wins the 60 main pot; seat 0 (KK) gets the uncalled 170 back.
    expect(s.seats[1]?.stack).toBe(60);
    expect(s.seats[0]?.stack).toBe(170);
  });
});
