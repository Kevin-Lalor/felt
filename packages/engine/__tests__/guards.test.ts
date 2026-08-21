// The engine's guard rails. Every throw in here is an "this cannot happen"
// assertion protecting the rest of the codebase from a malformed deck, a
// fractional chip, or a corrupt card string. They are cheap to test and they
// are exactly the paths nobody exercises by playing poker — so they rot
// silently unless something pins them down.
import { describe, expect, test } from 'vitest';
import {
  assertValidDeck,
  cardEquals,
  chips,
  decodeCard,
  encodeCard,
  EngineError,
  evaluate7,
  orderedDeck,
} from '../src/index.js';
import type { Card, Deck } from '../src/index.js';

const card = (s: string): Card => decodeCard(s);
const hand = (s: string): Card[] => s.split(' ').map(card);

describe('chips() rejects anything that is not a whole, non-negative number', () => {
  test.each([
    ['a fraction', 1.5],
    ['a negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['beyond safe-integer range', Number.MAX_SAFE_INTEGER + 1],
  ])('%s is not a chip amount', (_label, value) => {
    expect(() => chips(value)).toThrow(EngineError);
  });

  test('zero and positive integers are fine', () => {
    expect(chips(0)).toBe(0);
    expect(chips(200)).toBe(200);
  });
});

describe('card encoding round-trips and rejects garbage', () => {
  test('every card in the deck survives encode → decode unchanged', () => {
    for (const c of orderedDeck()) {
      expect(cardEquals(decodeCard(encodeCard(c)), c)).toBe(true);
    }
  });

  test('the ten is T, and face cards are J/Q/K/A', () => {
    expect(encodeCard({ rank: 10, suit: 'd' })).toBe('Td');
    expect(encodeCard({ rank: 11, suit: 's' })).toBe('Js');
    expect(encodeCard({ rank: 14, suit: 'c' })).toBe('Ac');
  });

  test.each([
    ['an unknown rank char', 'Xs'],
    ['an unknown suit char', 'Ax'],
    ['a lone rank', 'A'],
    ['an empty string', ''],
    ['three characters', 'As2'],
    ['a lowercase ten', 'ts'],
  ])('%s is rejected', (_label, encoded) => {
    expect(() => decodeCard(encoded)).toThrow(EngineError);
  });

  test('cardEquals distinguishes rank and suit independently', () => {
    expect(cardEquals(card('As'), card('As'))).toBe(true);
    expect(cardEquals(card('As'), card('Ah'))).toBe(false); // same rank, different suit
    expect(cardEquals(card('As'), card('Ks'))).toBe(false); // same suit, different rank
  });
});

describe('assertValidDeck', () => {
  test('accepts the canonical deck', () => {
    expect(() => assertValidDeck(orderedDeck())).not.toThrow();
  });

  test('rejects a short deck', () => {
    expect(() => assertValidDeck(orderedDeck().slice(0, 51))).toThrow(/51 cards/);
  });

  test('rejects a long deck', () => {
    const tooMany = [...orderedDeck(), card('As')] as Deck;
    expect(() => assertValidDeck(tooMany)).toThrow(/53 cards/);
  });

  test('rejects 52 cards containing a duplicate', () => {
    // Right length, wrong contents: the ace of spades twice, no king of spades.
    const rigged = orderedDeck().map((c) => (encodeCard(c) === 'Ks' ? card('As') : c));
    expect(() => assertValidDeck(rigged)).toThrow(/duplicate/);
  });
});

describe('evaluate7 accepts 5, 6, or 7 cards', () => {
  // The engine deals 7 at showdown, so the 5- and 6-card paths exist for
  // callers like equity tools and the hand-history viewer. They must agree
  // with the 7-card path, not merely run.
  const STRAIGHT = 5;
  const FULL_HOUSE = 7;
  const STRAIGHT_FLUSH = 9;

  test('five cards evaluate to exactly that hand', () => {
    expect(evaluate7(hand('As Ks Qs Js Ts')).category).toBe(STRAIGHT_FLUSH);
  });

  test('six cards pick the best five — the ace plays low in a wheel', () => {
    const wheel = evaluate7(hand('Ah 2d 3c 4s 5h Kd'));
    expect(wheel.category).toBe(STRAIGHT);
    // Five-high is the weakest straight there is: a six-high beats it.
    expect(wheel.value).toBeLessThan(evaluate7(hand('2h 3d 4c 5s 6h Kd')).value);
  });

  test('the 6- and 7-card paths agree when they share a best five', () => {
    const six = evaluate7(hand('As Ac Ad Kh Kd 7c'));
    const seven = evaluate7(hand('As Ac Ad Kh Kd 7c 2s')); // the deuce cannot improve it
    expect(six.category).toBe(FULL_HOUSE);
    expect(seven.value).toBe(six.value);
    expect(seven.cards.map(encodeCard).sort()).toEqual(six.cards.map(encodeCard).sort());
  });

  test.each([
    ['four cards', 'As Ks Qs Js'],
    ['eight cards', 'As Ks Qs Js Ts 9s 8s 7s'],
  ])('%s is rejected', (_label, cards) => {
    expect(() => evaluate7(hand(cards))).toThrow(EngineError);
  });

  test('an empty hand is rejected rather than scoring as nothing', () => {
    expect(() => evaluate7([])).toThrow(EngineError);
  });
});
