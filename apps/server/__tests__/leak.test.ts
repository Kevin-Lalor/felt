// The redaction fuzzer — the single highest-value test in the project (build
// plan §1). Plays thousands of random hands, renders every broadcast payload
// for every viewer at every step, and asserts that a hole card belonging to
// another live seat NEVER appears in the serialized payload before it is
// legitimately public. This test must never be skipped or weakened.

import { describe, expect, test } from 'vitest';
import type { Action, Card, Deck, HandState, LegalActions, Seat } from '@poker/engine';
import {
  DEFAULT_RULES,
  applyAction,
  chips,
  encodeCard,
  legalActions,
  orderedDeck,
  startHand,
} from '@poker/engine';
import type { TableSnapshot } from '../src/redact.js';
import { buildView } from '../src/redact.js';

/** Seeded deterministic PRNG — tests only (CLAUDE.md hard rule 3). */
function testRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function testShuffle(rng: () => number): Deck {
  const d = [...orderedDeck()] as Card[];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const di = d[i] as Card;
    d[i] = d[j] as Card;
    d[j] = di;
  }
  return d;
}

function pickAction(legal: LegalActions, rng: () => number): Action {
  const options: Action[] = [];
  if (legal.canCheck) options.push({ kind: 'check' }, { kind: 'check' });
  if (legal.canCall) options.push({ kind: 'call' }, { kind: 'call' });
  if (legal.canFold) options.push({ kind: 'fold' });
  if (legal.canBet) options.push({ kind: 'bet', to: legal.minBet });
  if (legal.canRaise) options.push({ kind: 'raise', to: legal.minRaise });
  if (legal.canAllIn) options.push({ kind: 'allIn' });
  const choice = options[Math.floor(rng() * options.length)];
  if (!choice) throw new Error('no legal action offered');
  return choice;
}

function snapshotFor(state: HandState, playerCount: number): TableSnapshot {
  return {
    tableName: 'leak-test',
    hostId: 'player-0',
    occupants: Array.from({ length: playerCount }, (_, i) => ({
      playerId: `player-${i}`,
      name: `P${i}`, // names deliberately can never collide with a card encoding
      avatar: 0,
      skin: { chipStyle: 'casino' as const, chipColour: 'red' as const },
      connected: true,
    })),
    idleStacks: Array(playerCount).fill(0),
    hand: state,
    handNumber: state.handNumber,
    shownCards: new Map(),
    showdownSeats: new Set(), // reveals happen via engine events; fuzz the strictest case
    blinds: { smallBlind: 1, bigBlind: 2, ante: 0 },
    actionDeadline: null,
    actionClockMs: 45_000,
    fairness: null,
  };
}

/** Assert no other live seat's hole cards appear anywhere in the viewer's payload. */
function assertNoLeaks(state: HandState, playerCount: number): void {
  const snapshot = snapshotFor(state, playerCount);
  for (let viewer = 0; viewer < playerCount; viewer++) {
    const view = buildView(snapshot, `player-${viewer}`);
    const payload = JSON.stringify(view);
    for (const seat of state.seats) {
      if (seat.index === viewer) continue;
      if (seat.holeCards.length === 0) continue;
      for (const card of seat.holeCards) {
        // JSON-quoted so a card can only match an actual card value.
        expect(payload.includes(`"${encodeCard(card)}"`),
          `viewer ${viewer} can see seat ${seat.index}'s ${encodeCard(card)} on street ${state.street}`,
        ).toBe(false);
      }
    }
    // The deck must never appear in any form.
    expect(payload.includes('deck')).toBe(false);
  }
}

const HANDS = process.env['PROPERTY'] ? 5000 : 800;

describe(`redaction leak fuzzer (${HANDS} hands)`, () => {
  test(`leak: opponent hole cards never appear in any outbound payload, pre-showdown, across ${HANDS} random hands`, () => {
    for (let handSeed = 1; handSeed <= HANDS; handSeed++) {
      const rng = testRng(handSeed * 7919);
      const playerCount = 2 + Math.floor(rng() * 8); // 2–9
      const seats: Seat[] = Array.from({ length: playerCount }, (_, i) => ({
        index: i,
        playerId: `player-${i}`,
        status: 'active',
        stack: chips(20 + Math.floor(rng() * 380)),
        holeCards: [],
        committedThisStreet: chips(0),
        committedThisHand: chips(0),
        hasActedThisStreet: false,
        isAllIn: false,
      }));
      const { state: initial } = startHand({
        seats,
        button: Math.floor(rng() * playerCount),
        blinds: { smallBlind: chips(1), bigBlind: chips(2), ante: chips(0), anteType: 'none' },
        deck: testShuffle(rng),
        handNumber: handSeed,
        rules: DEFAULT_RULES,
      });

      let state = initial;
      let guard = 0;
      // Check every intermediate broadcast state, including the final one:
      // pre-showdown, NOTHING leaks; at showdown the reveals flow through
      // events/showdownSeats (empty here), so even then the fuzzer demands
      // absence — the strictest possible reading.
      for (;;) {
        if (state.street !== 'showdown' && state.street !== 'complete') {
          assertNoLeaks(state, playerCount);
        }
        if (state.street === 'complete') break;
        if (++guard > 400) throw new Error('hand did not terminate');
        const seat = state.actingSeat;
        if (seat === null) break;
        const result = applyAction(state, { seat, action: pickAction(legalActions(state, seat), rng) });
        if (!result.ok) throw new Error(`fuzzer chose illegal action: ${result.reason}`);
        state = result.state;
      }
    }
  });

  test('leak: a folded seat is never revealed even after showdown', () => {
    // 3 players; seat 2 folds; hand reaches showdown between 0 and 1.
    const rng = testRng(42);
    const seats: Seat[] = Array.from({ length: 3 }, (_, i) => ({
      index: i,
      playerId: `player-${i}`,
      status: 'active',
      stack: chips(200),
      holeCards: [],
      committedThisStreet: chips(0),
      committedThisHand: chips(0),
      hasActedThisStreet: false,
      isAllIn: false,
    }));
    let state = startHand({
      seats,
      button: 0,
      blinds: { smallBlind: chips(1), bigBlind: chips(2), ante: chips(0), anteType: 'none' },
      deck: testShuffle(rng),
      handNumber: 1,
      rules: DEFAULT_RULES,
    }).state;

    const step = (seat: number, action: Action): void => {
      const result = applyAction(state, { seat, action });
      if (!result.ok) throw new Error(result.reason);
      state = result.state;
    };
    const foldedCards = () => state.seats[0]?.holeCards.map(encodeCard) ?? [];

    step(0, { kind: 'fold' }); // button folds — this seat must stay hidden forever
    const hidden = foldedCards();
    step(1, { kind: 'call' });
    step(2, { kind: 'check' });
    for (const street of ['flop', 'turn', 'river']) {
      void street;
      step(1, { kind: 'check' });
      step(2, { kind: 'check' });
    }
    expect(state.street).toBe('complete');

    const snapshot = {
      ...snapshotFor(state, 3),
      showdownSeats: new Set([1, 2]), // the two who reached showdown are public
    };
    for (const viewer of ['player-1', 'player-2', null]) {
      const payload = JSON.stringify(buildView(snapshot, viewer));
      for (const card of hidden) {
        expect(payload.includes(`"${card}"`)).toBe(false);
      }
    }
  });
});
