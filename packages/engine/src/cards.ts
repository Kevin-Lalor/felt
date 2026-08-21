import type { Card, Deck, Rank, Suit } from './types.js';
import { EngineError } from './types.js';

export const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
export const SUITS: readonly Suit[] = ['s', 'h', 'd', 'c'];

const RANK_CHARS: Record<Rank, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

const CHAR_RANKS: Record<string, Rank> = Object.fromEntries(
  (Object.entries(RANK_CHARS) as [string, string][]).map(([r, c]) => [c, Number(r) as Rank]),
);

/** 'As', 'Td', '9c' — the wire and history format for a card. */
export function encodeCard(card: Card): string {
  return RANK_CHARS[card.rank] + card.suit;
}

export function decodeCard(s: string): Card {
  const rank = CHAR_RANKS[s[0] ?? ''];
  const suit = s[1] as Suit | undefined;
  if (rank === undefined || suit === undefined || !SUITS.includes(suit) || s.length !== 2) {
    throw new EngineError(`invalid card encoding: ${s}`);
  }
  return { rank, suit };
}

/** The canonical, UNSHUFFLED 52-card deck: 2s..As, 2h..Ah, 2d..Ad, 2c..Ac.
 *  The engine never shuffles — the shuffled deck arrives as a parameter. */
export function orderedDeck(): Deck {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push({ rank, suit });
  }
  return deck;
}

export function cardEquals(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit;
}

/** Throws EngineError unless `deck` is a full 52-card permutation with no duplicates. */
export function assertValidDeck(deck: Deck): void {
  if (deck.length !== 52) throw new EngineError(`deck has ${deck.length} cards, expected 52`);
  const seen = new Set<string>();
  for (const card of deck) seen.add(encodeCard(card));
  if (seen.size !== 52) throw new EngineError('deck contains duplicate cards');
}
