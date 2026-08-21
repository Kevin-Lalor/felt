// Test-only helpers. The deterministic PRNG lives HERE, not in src/ — the engine
// itself has no randomness (CLAUDE.md hard rules 3 and 5). This is explicitly
// named testRng so it can never be confused with the real CSPRNG in the server.

import type { BlindStructure, Card, Chips, Deck, HandState, Seat, SeatIndex } from '../src/index.js';
import { DEFAULT_RULES, chips, orderedDeck, startHand } from '../src/index.js';

/** Mulberry32 — small, seeded, deterministic. Test use only. */
export function testRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic Fisher–Yates for tests. */
export function testShuffle(seed: number): Deck {
  const rng = testRng(seed);
  const d = [...orderedDeck()] as Card[];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const di = d[i] as Card;
    d[i] = d[j] as Card;
    d[j] = di;
  }
  return d;
}

export function seatRow(index: SeatIndex, stack: number, playerId: string | null = `p${index}`): Seat {
  return {
    index,
    playerId,
    status: playerId === null ? 'empty' : 'active',
    stack: chips(stack),
    holeCards: [],
    committedThisStreet: chips(0),
    committedThisHand: chips(0),
    hasActedThisStreet: false,
    isAllIn: false,
  };
}

export const BLINDS_1_2: BlindStructure = {
  smallBlind: chips(1),
  bigBlind: chips(2),
  ante: chips(0),
  anteType: 'none',
};

export function newHand(opts: {
  stacks: readonly number[];
  button?: SeatIndex;
  blinds?: BlindStructure;
  seed?: number;
  deck?: Deck;
}) {
  const seats = opts.stacks.map((stack, i) => seatRow(i, stack));
  return startHand({
    seats,
    button: opts.button ?? 0,
    blinds: opts.blinds ?? BLINDS_1_2,
    deck: opts.deck ?? testShuffle(opts.seed ?? 1),
    handNumber: 1,
    rules: DEFAULT_RULES,
  });
}

export function totalChips(state: HandState): number {
  const inStacks = state.seats.reduce((sum, s) => sum + s.stack, 0);
  const committed = state.seats.reduce((sum, s) => sum + s.committedThisHand, 0);
  // Once pots are awarded (street complete) committed chips have moved to stacks;
  // before that they are still "in front of" the seats. Pots are formed FROM
  // committedThisHand, so counting both would double-count.
  return state.street === 'complete' ? inStacks : inStacks + committed;
}

export function sumCommitted(state: HandState): number {
  return state.seats.reduce((sum, s) => sum + s.committedThisHand, 0);
}

export const asChips = (n: number): Chips => chips(n);
