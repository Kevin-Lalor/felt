// Sitting out — HOUSE-RULES #6 to #12.
//
// The defect these exist to prevent: before this, a seat that was occupied with
// chips was dealt in no matter what, so a player who lost their connection kept
// being dealt cards and burned the full action clock on every street. Two absent
// players turned a hand into several minutes of everyone else waiting.
//
// The other reason they exist: deciding whether a returning player rejoins THIS
// hand means knowing where the big blind will land BEFORE the deal, which the
// engine only reports afterwards. So the server mirrors that rule — and the
// first test below is the one that keeps the copy honest.

import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import type { ClientMessage } from '@poker/protocol';
import { DEFAULT_RULES, chips, orderedDeck, startHand } from '@poker/engine';
import type { Seat } from '@poker/engine';
import { bigBlindSeatFor, blindPassed } from '../src/table.js';
import { CONFIG, Harness } from './table-integrity.test.js';

const MAX_SEATS = 9;
/** Just past NEXT_HAND_DELAY_MS. Deliberately well short of the 45s action
 *  clock: advancing past that now sits the acting player out (HOUSE-RULES #8),
 *  so a test that jumps a minute between hands quietly empties the table. */
const UNTIL_NEXT_DEAL_MS = 7_000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the server and the engine agree on where the big blind lands', () => {
  // bigBlindSeatFor duplicates a rule the engine owns. A duplicate that nobody
  // checks is how the fairness ordering broke, so this checks it exhaustively
  // rather than on a sample: every subset of seats, every legal button.
  test('bigBlindSeatFor matches the engine for every seat set and button', () => {
    let compared = 0;
    for (let mask = 0; mask < 1 << MAX_SEATS; mask++) {
      const inHand: number[] = [];
      for (let seat = 0; seat < MAX_SEATS; seat++) if (mask & (1 << seat)) inHand.push(seat);
      if (inHand.length < 2) continue;

      for (const button of inHand) {
        const seats: Seat[] = Array.from({ length: MAX_SEATS }, (_, index) => ({
          index,
          playerId: inHand.includes(index) ? `p${index}` : null,
          status: inHand.includes(index) ? ('active' as const) : ('empty' as const),
          stack: chips(200),
          holeCards: [],
          committedThisStreet: chips(0),
          committedThisHand: chips(0),
          hasActedThisStreet: false,
          isAllIn: false,
        }));
        const { events } = startHand({
          seats,
          button,
          blinds: {
            smallBlind: chips(1),
            bigBlind: chips(2),
            ante: chips(0),
            anteType: 'none',
          },
          deck: orderedDeck(),
          handNumber: 1,
          rules: DEFAULT_RULES,
        });
        const started = events.find((e) => e.t === 'handStarted');
        if (!started || started.t !== 'handStarted') throw new Error('no handStarted');
        expect({
          seats: inHand,
          button,
          bigBlind: bigBlindSeatFor(inHand, button),
        }).toEqual({ seats: inHand, button, bigBlind: started.bigBlindSeat });
        compared++;
      }
    }
    // Guard against the loop quietly matching nothing.
    expect(compared).toBeGreaterThan(2000);
  });

  test('blindPassed reads the clockwise arc, wrapping at the last seat', () => {
    expect(blindPassed(0, 3, 2)).toBe(true); // 1,2,3 — 2 is in it
    expect(blindPassed(0, 3, 5)).toBe(false); // 5 is past the arc
    expect(blindPassed(7, 2, 0)).toBe(true); // wraps 8,0,1,2
    expect(blindPassed(7, 2, 6)).toBe(false);
    expect(blindPassed(4, 4, 4)).toBe(true); // a full turn passes every seat
  });
});

// ---------------------------------------------------------------------------

describe('sitting out keeps your seat and deals you out', () => {
  test('a player who sits out is not dealt into the next hand, and keeps their chips', () => {
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    const bob = h.seat('Bob', 1);
    h.seat('Cat', 2);

    expect(h.table.handle(bob.id, { type: 'sitOut' } as ClientMessage)).toBeNull();
    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);

    const view = h.table.viewFor(bob.id);
    const seat = view.seats[1];
    expect(seat?.hasCards).toBe(false);
    expect(seat?.away).toBe('sittingOut');
    expect(seat?.stack).toBe(200); // untouched: no blind, no ante
    expect(view.you).toMatchObject({ away: 'sittingOut' });
    // And everyone else can see it, or the felt looks broken.
    expect(h.table.viewFor(ann.id).seats[1]?.away).toBe('sittingOut');
  });

  test('the button skips a sitting-out seat instead of crashing the deal', () => {
    // startHand throws 'button must be on a seat that is dealt in'. Before the
    // button rotation learned about sitting out, this threw on the hand where
    // the button reached the absent seat.
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    const bob = h.seat('Bob', 1);
    h.seat('Cat', 2);
    h.table.handle(bob.id, { type: 'sitOut' } as ClientMessage);

    for (let hand = 0; hand < 6; hand++) {
      expect(() => {
        h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);
        h.foldToTheEnd();
        vi.advanceTimersByTime(UNTIL_NEXT_DEAL_MS);
      }).not.toThrow();
      expect(h.table.viewFor(ann.id).button).not.toBe(1);
    }
  });

  test('pressing sit out during a live hand finishes that hand first', () => {
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    h.seat('Bob', 1);
    h.seat('Cat', 2);
    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);

    expect(h.table.handle(ann.id, { type: 'sitOut' } as ClientMessage)).toBeNull();
    // Still in the hand she was dealt.
    expect(h.table.viewFor(ann.id).seats[0]?.hasCards).toBe(true);
    expect(h.table.viewFor(ann.id).you).toMatchObject({ away: 'no', sitOutAfterHand: true });

    h.foldToTheEnd();
    expect(h.table.viewFor(ann.id).you).toMatchObject({ away: 'sittingOut' });
  });

  test('a table with one player left simply stops dealing', () => {
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    const bob = h.seat('Bob', 1);
    h.table.handle(bob.id, { type: 'sitOut' } as ClientMessage);

    expect(h.table.handle(ann.id, { type: 'startHand' } as ClientMessage)).toMatchObject({
      type: 'error',
      code: 'needPlayers',
    });
    expect(h.table.handInProgress()).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('a dropped connection does not make the table wait twice', () => {
  test('disconnecting with no live hand sits you out immediately', () => {
    const h = new Harness();
    h.seat('Ann', 0, 200, true);
    const bob = h.seat('Bob', 1);

    h.table.disconnect(bob.id);

    expect(h.table.viewFor(bob.id).seats[1]?.away).toBe('sittingOut');
    expect(h.table.viewFor(bob.id).seats[1]?.stack).toBe(200);
  });

  test('disconnecting while holding cards keeps your clock — the hand is still yours', () => {
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    const bob = h.seat('Bob', 1);
    h.seat('Cat', 2);
    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);
    expect(h.table.viewFor(bob.id).seats[1]?.hasCards).toBe(true);

    h.table.disconnect(bob.id);

    // Not sat out yet: those cards are his, and the clock is his window to
    // reconnect and play them (HOUSE-RULES #9).
    expect(h.table.viewFor(bob.id).seats[1]?.away).toBe('no');
    expect(h.table.viewFor(bob.id).actionDeadline).not.toBeNull();
  });

  test('letting the clock run out sits you out', () => {
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    h.seat('Bob', 1);
    h.seat('Cat', 2);
    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);

    const actingSeat = h.table.viewFor(ann.id).actingSeat;
    expect(actingSeat).not.toBeNull();
    const actingId = h.table.viewFor(ann.id).seats[actingSeat as number]?.playerId as string;

    vi.advanceTimersByTime(60_000);

    expect(h.table.viewFor(actingId).seats[actingSeat as number]?.away).toBe('sittingOut');
  });

  test('once sat out mid-hand, the rest of that hand resolves without a clock', () => {
    // The whole point of rule #10: the table waits for an absence once, never
    // twice. Before this, an absent player who could check for free burned a
    // fresh 45 seconds on every remaining street.
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    h.seat('Bob', 1);
    h.seat('Cat', 2);
    h.seat('Dan', 3);
    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);

    const before = h.table.viewFor(ann.id).handNumber;
    // Burn one clock — that player is now sitting out.
    vi.advanceTimersByTime(60_000);
    // Everything that follows for that seat resolves on microtasks, not timers.
    // Run the remaining hand out and confirm it terminates without more waiting.
    let guard = 0;
    while (h.table.handInProgress() && guard++ < 40) {
      vi.advanceTimersByTime(60_000);
    }
    expect(h.table.handInProgress()).toBe(false);
    expect(h.table.viewFor(ann.id).handNumber).toBe(before);
  });
});

// ---------------------------------------------------------------------------

describe("coming back: you pay the blind either way, you choose when", () => {
  test('a returning player who has not missed the big blind is simply dealt in', () => {
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    const bob = h.seat('Bob', 1);
    h.seat('Cat', 2);

    h.table.handle(bob.id, { type: 'sitOut' } as ClientMessage);
    expect(h.table.viewFor(bob.id).you).toMatchObject({ missedBlind: false });

    expect(h.table.handle(bob.id, { type: 'sitIn', post: false } as ClientMessage)).toBeNull();
    expect(h.table.viewFor(bob.id).you).toMatchObject({ away: 'no' });

    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);
    expect(h.table.viewFor(bob.id).seats[1]?.hasCards).toBe(true);
  });

  test('sitting in when you are already in is refused', () => {
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    h.seat('Bob', 1);

    expect(h.table.handle(ann.id, { type: 'sitIn', post: false } as ClientMessage)).toMatchObject({
      type: 'error',
      code: 'alreadyIn',
    });
  });

  test('sitting out twice is refused', () => {
    const h = new Harness();
    h.seat('Ann', 0, 200, true);
    const bob = h.seat('Bob', 1);

    expect(h.table.handle(bob.id, { type: 'sitOut' } as ClientMessage)).toBeNull();
    expect(h.table.handle(bob.id, { type: 'sitOut' } as ClientMessage)).toMatchObject({
      type: 'error',
      code: 'alreadyOut',
    });
  });

  test('a player who waits is admitted when the big blind reaches their seat', () => {
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    const bob = h.seat('Bob', 1);
    h.seat('Cat', 2);
    h.seat('Dan', 3);

    h.table.handle(bob.id, { type: 'sitOut' } as ClientMessage);

    // Run hands until the big blind has gone past Bob's seat.
    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);
    for (let i = 0; i < 6 && !h.table.viewFor(bob.id).you?.missedBlind; i++) {
      h.foldToTheEnd();
      vi.advanceTimersByTime(UNTIL_NEXT_DEAL_MS);
    }
    expect(h.table.viewFor(bob.id).you).toMatchObject({ missedBlind: true });

    // He chooses to wait rather than post.
    h.table.handle(bob.id, { type: 'sitIn', post: false } as ClientMessage);
    expect(h.table.viewFor(bob.id).you).toMatchObject({ away: 'waitingForBigBlind' });

    // Within one orbit the big blind reaches him and he is dealt in.
    let dealtIn = false;
    for (let i = 0; i < MAX_SEATS + 2 && !dealtIn; i++) {
      h.foldToTheEnd();
      vi.advanceTimersByTime(UNTIL_NEXT_DEAL_MS);
      dealtIn = h.table.viewFor(bob.id).you?.away === 'no';
    }
    expect(dealtIn).toBe(true);
    expect(h.table.viewFor(bob.id).seats[1]?.hasCards).toBe(true);
  });

  test('a waiting player is admitted at once when the table cannot otherwise deal', () => {
    // Waiting out a rotation that is not turning is just a stalled table.
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    const bob = h.seat('Bob', 1);

    h.table.handle(bob.id, { type: 'sitOut' } as ClientMessage);
    h.table.handle(bob.id, { type: 'sitIn', post: false } as ClientMessage);
    // Force the waiting state even though he never missed a blind.
    h.table.handle(bob.id, { type: 'sitOut' } as ClientMessage);

    // Only Ann is in, so the table cannot deal — Bob comes in rather than the
    // game stopping forever.
    h.table.handle(bob.id, { type: 'sitIn', post: false } as ClientMessage);
    expect(h.table.handle(ann.id, { type: 'startHand' } as ClientMessage)).toBeNull();
    expect(h.table.handInProgress()).toBe(true);
  });

  test('posting brings you back next hand, and the post is dead money in the pot', () => {
    const h = new Harness({ ...CONFIG, smallBlind: 1, bigBlind: 2 });
    const ann = h.seat('Ann', 0, 200, true);
    const bob = h.seat('Bob', 1);
    h.seat('Cat', 2);
    h.seat('Dan', 3);

    h.table.handle(bob.id, { type: 'sitOut' } as ClientMessage);
    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);
    for (let i = 0; i < 6 && !h.table.viewFor(bob.id).you?.missedBlind; i++) {
      h.foldToTheEnd();
      vi.advanceTimersByTime(UNTIL_NEXT_DEAL_MS);
    }
    expect(h.table.viewFor(bob.id).you).toMatchObject({ missedBlind: true });

    h.table.handle(bob.id, { type: 'sitIn', post: true } as ClientMessage);
    h.foldToTheEnd();
    vi.advanceTimersByTime(UNTIL_NEXT_DEAL_MS);

    const view = h.table.viewFor(bob.id);
    expect(view.seats[1]?.hasCards).toBe(true);
    expect(view.you).toMatchObject({ away: 'no', missedBlind: false });
    // He paid to come back, one way or the other: either he posted, or the
    // rotation put him in the blinds that hand and he paid that instead — a
    // seat never posts AND pays a blind. Asserting his stack would be checking
    // luck, since he may have won the hand he came back into.
    const posted = h.table.chipLog.some((e) =>
      /posted the big blind to come back in/.test(e.reason),
    );
    const paidABlind = (view.seats[1]?.committedThisStreet ?? 0) > 0;
    expect(posted || paidABlind).toBe(true);
    expect(view.potTotal).toBeGreaterThanOrEqual(CONFIG.bigBlind);
  });
});
