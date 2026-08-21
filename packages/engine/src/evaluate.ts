import type { Card, HandCategory, HandRank, Rank } from './types.js';
import { EngineError } from './types.js';

// Correctness first; speed is a non-issue at nine players (see docs/ENGINE-SPEC.md §4).
// evaluate7 scores all 21 five-card combinations from seven and takes the best.

const RANK_NAMES: Record<Rank, string> = {
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight',
  9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace',
};

const RANK_PLURALS: Record<Rank, string> = {
  2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens', 8: 'Eights',
  9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces',
};

type Scored = { category: HandCategory; tiebreaks: readonly number[]; label: string };

/** Straight high card for 5 distinct ranks sorted descending, or null.
 *  Handles the wheel: A-2-3-4-5 is a straight with high card 5, below 6-5-4-3-2. */
function straightHigh(ranksDesc: readonly number[]): number | null {
  if (ranksDesc.length !== 5) return null;
  const isRunDown = ranksDesc.every((r, i) => i === 0 || ranksDesc[i - 1] === r + 1);
  if (isRunDown) return ranksDesc[0] ?? null;
  // wheel: A,5,4,3,2
  if (
    ranksDesc[0] === 14 && ranksDesc[1] === 5 && ranksDesc[2] === 4 &&
    ranksDesc[3] === 3 && ranksDesc[4] === 2
  ) {
    return 5;
  }
  return null;
}

function score5(cards: readonly Card[]): Scored {
  const ranks = cards.map((c) => c.rank as number).sort((a, b) => b - a);
  const isFlush = cards.every((c) => c.suit === cards[0]?.suit);

  // count ranks: entries [rank, count] sorted by count desc, then rank desc.
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  const name = (r: number): string => RANK_NAMES[r as Rank];
  const plural = (r: number): string => RANK_PLURALS[r as Rank];

  const distinct = groups.map(([r]) => r);
  const sHigh = counts.size === 5 ? straightHigh(ranks) : null;

  if (isFlush && sHigh !== null) {
    return {
      category: 9,
      tiebreaks: [sHigh],
      label: sHigh === 14 ? 'Royal Flush' : `Straight Flush, ${name(sHigh)} high`,
    };
  }
  if (groups[0]?.[1] === 4) {
    const quad = must0(distinct[0]);
    const kicker = must0(distinct[1]);
    return { category: 8, tiebreaks: [quad, kicker], label: `Four of a Kind, ${plural(quad)}` };
  }
  if (groups[0]?.[1] === 3 && groups[1]?.[1] === 2) {
    const trips = must0(distinct[0]);
    const pair = must0(distinct[1]);
    return {
      category: 7,
      tiebreaks: [trips, pair],
      label: `Full House, ${plural(trips)} full of ${plural(pair)}`,
    };
  }
  if (isFlush) {
    return { category: 6, tiebreaks: ranks, label: `Flush, ${name(must0(ranks[0]))} high` };
  }
  if (sHigh !== null) {
    return { category: 5, tiebreaks: [sHigh], label: `Straight, ${name(sHigh)} high` };
  }
  if (groups[0]?.[1] === 3) {
    const trips = must0(distinct[0]);
    const kickers = distinct.slice(1);
    return {
      category: 4,
      tiebreaks: [trips, ...kickers],
      label: `Three of a Kind, ${plural(trips)}`,
    };
  }
  if (groups[0]?.[1] === 2 && groups[1]?.[1] === 2) {
    const hi = must0(distinct[0]);
    const lo = must0(distinct[1]);
    const kicker = must0(distinct[2]);
    return {
      category: 3,
      tiebreaks: [hi, lo, kicker],
      label: `Two Pair, ${plural(hi)} and ${plural(lo)}`,
    };
  }
  if (groups[0]?.[1] === 2) {
    const pair = must0(distinct[0]);
    return {
      category: 2,
      tiebreaks: [pair, ...distinct.slice(1)],
      label: `Pair of ${plural(pair)}`,
    };
  }
  return { category: 1, tiebreaks: ranks, label: `High Card, ${name(must0(ranks[0]))}` };
}

function must0(x: number | undefined): number {
  if (x === undefined) throw new EngineError('rank group missing');
  return x;
}

/** Pack category + up to five tiebreak ranks into one comparable integer (base 15). */
function packValue(s: Scored): number {
  let v = s.category;
  for (let i = 0; i < 5; i++) v = v * 15 + (s.tiebreaks[i] ?? 0);
  return v;
}

const COMBOS_7C5: readonly (readonly number[])[] = (() => {
  const combos: number[][] = [];
  for (let a = 0; a < 3; a++)
    for (let b = a + 1; b < 4; b++)
      for (let c = b + 1; c < 5; c++)
        for (let d = c + 1; d < 6; d++)
          for (let e = d + 1; e < 7; e++) combos.push([a, b, c, d, e]);
  return combos;
})();

/** Best 5-card hand from exactly 5, 6, or 7 cards. Pure, exhaustively tested. */
export function evaluate7(cards: readonly Card[]): HandRank {
  if (cards.length < 5 || cards.length > 7) {
    throw new EngineError(`evaluate7 needs 5-7 cards, got ${cards.length}`);
  }
  let best: { scored: Scored; value: number; five: readonly Card[] } | null = null;

  const pick = (idxs: readonly number[]): readonly Card[] =>
    idxs.map((i) => {
      const c = cards[i];
      if (c === undefined) throw new EngineError('combo index out of range');
      return c;
    });

  const candidates: (readonly Card[])[] =
    cards.length === 5
      ? [cards]
      : cards.length === 6
        ? [0, 1, 2, 3, 4, 5].map((skip) => cards.filter((_, i) => i !== skip))
        : COMBOS_7C5.map(pick);

  for (const five of candidates) {
    const scored = score5(five);
    const value = packValue(scored);
    if (best === null || value > best.value) best = { scored, value, five };
  }
  if (best === null) throw new EngineError('no combination evaluated');
  return {
    category: best.scored.category,
    value: best.value,
    cards: best.five,
    label: best.scored.label,
  };
}
