import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { assertValidDeck, encodeCard } from '@poker/engine';
import { commitOf, deriveDeck, generateServerSeed } from '../src/fairness.js';

describe('commit-reveal shuffle', () => {
  test('commit is SHA256 of the server seed', () => {
    const seed = generateServerSeed();
    expect(commitOf(seed)).toBe(createHash('sha256').update(seed, 'utf8').digest('hex'));
    expect(seed).toHaveLength(64);
  });

  test('deck derivation is deterministic: same seeds → same deck', () => {
    const seed = 'a'.repeat(64);
    const a = deriveDeck(seed, ['s1', 's2', 's3'], 7).map(encodeCard);
    const b = deriveDeck(seed, ['s1', 's2', 's3'], 7).map(encodeCard);
    expect(a).toEqual(b);
  });

  test('derived deck is always a valid 52-card permutation', () => {
    for (let hand = 1; hand <= 50; hand++) {
      const deck = deriveDeck(generateServerSeed(), ['x', 'y'], hand);
      assertValidDeck(deck);
    }
  });

  test('any single input changing changes the deck: server seed, client seed, hand number', () => {
    const seed = 'b'.repeat(64);
    const base = deriveDeck(seed, ['s1', 's2'], 1).map(encodeCard).join('');
    expect(deriveDeck('c'.repeat(64), ['s1', 's2'], 1).map(encodeCard).join('')).not.toBe(base);
    expect(deriveDeck(seed, ['s1', 'DIFFERENT'], 1).map(encodeCard).join('')).not.toBe(base);
    expect(deriveDeck(seed, ['s1', 's2'], 2).map(encodeCard).join('')).not.toBe(base);
  });

  test('a player changing their seed changes the deck — the host cannot precompute', () => {
    // The property that settles the "rigged" argument: without knowing every
    // player's seed, no deck order can be precomputed even with the server seed.
    const seed = generateServerSeed();
    const decks = new Set<string>();
    for (let i = 0; i < 20; i++) {
      decks.add(deriveDeck(seed, ['host', `player-${i}`], 1).map(encodeCard).join(''));
    }
    expect(decks.size).toBe(20);
  });
});
