import { describe, expect, test } from 'vitest';
import { Hand as Oracle } from 'pokersolver';
import { decodeCard, encodeCard, evaluate7 } from '../src/index.js';
import { testShuffle } from './helpers.js';

const cards = (s: string) => s.split(' ').map(decodeCard);

describe('evaluate7 — named cases from the spec', () => {
  test('the wheel: A-2-3-4-5 is a straight, ace low, below 6-5-4-3-2', () => {
    const wheel = evaluate7(cards('As 2d 3c 4h 5s 9d Jh'));
    const sixHigh = evaluate7(cards('2s 3d 4c 5h 6s 9d Jh'));
    expect(wheel.category).toBe(5);
    expect(wheel.label).toBe('Straight, Five high');
    expect(sixHigh.category).toBe(5);
    expect(sixHigh.value).toBeGreaterThan(wheel.value);
  });

  test('A-K-Q-J-10 is the top straight (Broadway)', () => {
    const broadway = evaluate7(cards('As Kd Qc Jh Ts 2d 3h'));
    expect(broadway.category).toBe(5);
    expect(broadway.label).toBe('Straight, Ace high');
  });

  test('steel wheel (A-2-3-4-5 suited) is a straight flush', () => {
    const steel = evaluate7(cards('As 2s 3s 4s 5s 9d Jh'));
    expect(steel.category).toBe(9);
    expect(steel.label).toBe('Straight Flush, Five high');
  });

  test('royal flush', () => {
    const royal = evaluate7(cards('As Ks Qs Js Ts 9d 2h'));
    expect(royal.category).toBe(9);
    expect(royal.label).toBe('Royal Flush');
  });

  test('board plays: best five on the board means identical ranks for both players', () => {
    const board = 'As Ks Qs Js Ts';
    const p1 = evaluate7(cards(`${board} 2d 3h`));
    const p2 = evaluate7(cards(`${board} 9c 4d`));
    expect(p1.value).toBe(p2.value);
  });

  test('counterfeited two pair: the board double-pairs and kickers decide', () => {
    // Board KK QQ 9. P1 holds 22 (two pair KK QQ, kicker 9 beaten by ace).
    const board = 'Kd Kc Qh Qs 9d';
    const p1 = evaluate7(cards(`${board} 2s 2h`));
    const p2 = evaluate7(cards(`${board} As 3h`));
    expect(p2.value).toBeGreaterThan(p1.value);
  });

  test('full house comparison: trips rank first, then the pair', () => {
    const treysFullOfAces = evaluate7(cards('3s 3d 3c Ah Ad 7s 2c'));
    const acesFullOfTreys = evaluate7(cards('As Ad Ac 3h 3d 7s 2c'));
    expect(acesFullOfTreys.value).toBeGreaterThan(treysFullOfAces.value);
    expect(acesFullOfTreys.label).toBe('Full House, Aces full of Threes');
  });

  test('flush comparison uses all five cards in order', () => {
    const a = evaluate7(cards('As Ks 9s 8s 2s 3d 4h'));
    const b = evaluate7(cards('As Ks 9s 7s 6s 3d 4h'));
    expect(a.value).toBeGreaterThan(b.value); // A K 9 8 2 beats A K 9 7 6
  });

  test('quads beat a full house; kicker breaks quad ties from the board', () => {
    const board = '7s 7d 7c 7h 2d';
    const p1 = evaluate7(cards(`${board} As 3h`));
    const p2 = evaluate7(cards(`${board} Ks 3c`));
    expect(p1.category).toBe(8);
    expect(p1.value).toBeGreaterThan(p2.value);
  });

  test('two pair picks the best two pairs from three', () => {
    const r = evaluate7(cards('As Ad Ks Kd 2s 2d 9h'));
    expect(r.label).toBe('Two Pair, Aces and Kings');
  });
});

describe('evaluate7 — oracle agreement', () => {
  function playersAgree(seed: number, runs: number): void {
    for (let i = 0; i < runs; i++) {
      const deck = testShuffle(seed + i);
      const p1 = deck.slice(0, 2);
      const p2 = deck.slice(2, 4);
      const board = deck.slice(4, 9);
      const mine1 = evaluate7([...p1, ...board]);
      const mine2 = evaluate7([...p2, ...board]);
      const myOutcome = mine1.value > mine2.value ? 'p1' : mine2.value > mine1.value ? 'p2' : 'tie';

      const o1 = Oracle.solve([...p1, ...board].map(encodeCard));
      const o2 = Oracle.solve([...p2, ...board].map(encodeCard));
      const winners = Oracle.winners([o1, o2]);
      const oracleOutcome = winners.length === 2 ? 'tie' : winners[0] === o1 ? 'p1' : 'p2';

      if (myOutcome !== oracleOutcome) {
        throw new Error(
          `disagreement at seed ${seed + i}: ` +
            `p1=${p1.map(encodeCard).join('')} p2=${p2.map(encodeCard).join('')} ` +
            `board=${board.map(encodeCard).join('')} mine=${myOutcome} oracle=${oracleOutcome}`,
        );
      }
    }
  }

  test('agrees with pokersolver across 20,000 random matchups', () => {
    playersAgree(1000, 20_000);
  });

  test('property: agrees with pokersolver across 200,000 random matchups', () => {
    playersAgree(500_000, 200_000);
  });
});
