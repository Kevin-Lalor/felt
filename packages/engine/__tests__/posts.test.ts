// Posts — a player returning from sitting out who buys back in mid-rotation
// rather than waiting for the big blind to reach them (HOUSE-RULES #7).
//
// The post is DEAD. It reaches the pot but is not a bet, so the poster still
// owes a call to see a flop. That is what stops sitting out from being a way to
// see cheap hands: you pay the blind either way, you only choose when.

import { describe, expect, test } from 'vitest';
import type { Event } from '../src/index.js';
import { DEFAULT_RULES, EngineError, chips, startHand } from '../src/index.js';
import { BLINDS_1_2, seatRow, testShuffle } from './helpers.js';

function deal(opts: {
  stacks: readonly number[];
  button?: number;
  posts?: readonly { seat: number; amount: number }[];
  sittingOut?: readonly number[];
}) {
  const seats = opts.stacks.map((stack, i) => {
    const row = seatRow(i, stack);
    return opts.sittingOut?.includes(i) ? { ...row, status: 'sittingOut' as const } : row;
  });
  return startHand({
    seats,
    button: opts.button ?? 0,
    blinds: BLINDS_1_2,
    deck: testShuffle(7),
    handNumber: 1,
    rules: DEFAULT_RULES,
    // `?? []` rather than letting it be undefined: exactOptionalPropertyTypes
    // treats an explicit undefined as a different thing from an absent key.
    posts: opts.posts?.map((p) => ({ seat: p.seat, amount: chips(p.amount) })) ?? [],
  });
}

const postsIn = (events: readonly Event[]) =>
  events.filter(
    (e): e is Extract<Event, { t: 'blindPosted' }> => e.t === 'blindPosted' && e.blind === 'post',
  );

describe('posting back in after sitting out', () => {
  // Four-handed, button 0 → small blind 1, big blind 2. Seats 0 and 3 are free
  // to post; the two blinds are not.
  test("a returning player's post goes into the pot without counting as their bet", () => {
    const { state, events } = deal({ stacks: [200, 200, 200, 200], posts: [{ seat: 3, amount: 2 }] });
    const poster = state.seats[3];

    expect(poster?.committedThisHand).toBe(2); // in the pot
    expect(poster?.committedThisStreet).toBe(0); // but not toward the bet
    expect(poster?.stack).toBe(198);
    // So the big blind is still live to them: they owe a full call, not nothing.
    expect(state.currentBet).toBe(2);
    expect(postsIn(events)).toHaveLength(1);
  });

  test('a post larger than the stack puts that seat all-in for what it has', () => {
    const { state, events } = deal({ stacks: [200, 200, 200, 1], posts: [{ seat: 3, amount: 2 }] });
    const poster = state.seats[3];

    expect(poster?.stack).toBe(0);
    expect(poster?.committedThisHand).toBe(1);
    expect(poster?.isAllIn).toBe(true);
    expect(poster?.status).toBe('allIn');
    expect(postsIn(events)[0]?.amount).toBe(1);
  });

  test('a post of zero is not an error and puts nothing in the pot', () => {
    const { state, events } = deal({ stacks: [200, 200, 200, 200], posts: [{ seat: 3, amount: 0 }] });

    expect(state.seats[3]?.committedThisHand).toBe(0);
    expect(state.seats[3]?.stack).toBe(200);
    expect(postsIn(events)).toHaveLength(0); // no event for a post of nothing
  });

  // The next three are server bugs, not player mistakes, so they throw rather
  // than returning a protocol error (CLAUDE.md style: EngineError = a bug).
  test('the big blind cannot also post — that would charge them twice over', () => {
    // Button 0 → small blind 1, big blind 2.
    expect(() => deal({ stacks: [200, 200, 200, 200], posts: [{ seat: 2, amount: 2 }] })).toThrow(
      EngineError,
    );
    expect(() => deal({ stacks: [200, 200, 200, 200], posts: [{ seat: 2, amount: 2 }] })).toThrow(
      /paying the big blind/,
    );
  });

  test('the small blind CAN also post — coming back costs a full orbit, never less', () => {
    // Returning after missing your blind, the next blind to reach you is the
    // small one. Charging only that would make sitting out the cheapest seat at
    // the table. Small blind live (1) plus the big blind dead (2) is 3 — what
    // everyone else pays per orbit.
    const { state } = deal({ stacks: [200, 200, 200, 200], posts: [{ seat: 1, amount: 2 }] });
    const smallBlind = state.seats[1];

    expect(smallBlind?.committedThisHand).toBe(3);
    expect(smallBlind?.committedThisStreet).toBe(1); // only the blind is a bet
    expect(smallBlind?.stack).toBe(197);
  });

  test('posting on a seat that is not dealt in is an engine error', () => {
    expect(() =>
      deal({ stacks: [200, 200, 200, 200], sittingOut: [3], posts: [{ seat: 3, amount: 2 }] }),
    ).toThrow(/not dealt in/);
  });

  test('a negative post cannot be expressed at all — Chips rejects it at construction', () => {
    // There is deliberately no negative-amount guard inside startHand: it could
    // never fire, because the only way to make a Chips is chips(), and that
    // throws first. Asserting the real boundary rather than a decorative one.
    expect(() => deal({ stacks: [200, 200, 200, 200], posts: [{ seat: 3, amount: -1 }] })).toThrow(
      /invalid chip amount/,
    );
  });

  test('several players can post in the same hand', () => {
    const { state, events } = deal({
      stacks: [200, 200, 200, 200],
      posts: [
        { seat: 0, amount: 2 },
        { seat: 3, amount: 2 },
      ],
    });

    expect(postsIn(events)).toHaveLength(2);
    expect(state.seats[0]?.committedThisHand).toBe(2);
    expect(state.seats[3]?.committedThisHand).toBe(2);
    // Two posts, a small blind and a big blind: 2 + 2 + 1 + 2.
    const committed = state.seats.reduce((sum, s) => sum + s.committedThisHand, 0);
    expect(committed).toBe(7);
  });

  test('a post is never dealt to a seat that is sitting out — they are not in the hand at all', () => {
    const { state } = deal({ stacks: [200, 200, 200, 200], sittingOut: [3] });

    expect(state.seats[3]?.status).toBe('sittingOut');
    expect(state.seats[3]?.holeCards).toHaveLength(0);
    expect(state.seats[3]?.committedThisHand).toBe(0);
    expect(state.seats[3]?.stack).toBe(200);
  });

  test('the blind seats are stated on handStarted, even when a short stack cannot cover them', () => {
    // Seat 1 has one chip and is the small blind; it posts what it has. Seat 2
    // is the big blind with nothing left after posting. The seats are still
    // named on the event — which is the point, since a blind that posts zero
    // emits no blindPosted event at all.
    const { events } = deal({ stacks: [200, 1, 200, 200], button: 0 });
    const opening = events.find((e) => e.t === 'handStarted');

    expect(opening).toMatchObject({ t: 'handStarted', smallBlindSeat: 1, bigBlindSeat: 2 });
  });
});
