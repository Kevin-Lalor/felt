import type {
  ApplyResult,
  BlindStructure,
  Card,
  Chips,
  Deck,
  Event,
  HandState,
  HouseRules,
  LegalActions,
  PlayerAction,
  Pot,
  Seat,
  SeatIndex,
  Street,
} from './types.js';
import { EngineError, ZERO, must } from './types.js';
import { assertValidDeck } from './cards.js';
import { evaluate7 } from './evaluate.js';

// ---------------------------------------------------------------------------
// Internal mutable working state. The public API is immutable: we deep-copy in,
// mutate the draft, and freeze out. Callers never observe mutation.
// ---------------------------------------------------------------------------

type DraftSeat = {
  index: SeatIndex;
  playerId: string | null;
  status: Seat['status'];
  stack: number;
  holeCards: Card[];
  committedThisStreet: number;
  committedThisHand: number;
  hasActedThisStreet: boolean;
  isAllIn: boolean;
};

type Draft = {
  handNumber: number;
  seats: DraftSeat[];
  button: SeatIndex;
  street: Street;
  board: Card[];
  deck: Deck;
  deckPointer: number;
  pots: Pot[];
  blinds: BlindStructure;
  currentBet: number;
  lastRaiseSize: number;
  actingSeat: SeatIndex | null;
  lastAggressor: SeatIndex | null;
  noRaiseSeats: SeatIndex[];
  rules: HouseRules;
};

function toDraft(state: HandState): Draft {
  return {
    ...state,
    seats: state.seats.map((s) => ({ ...s, holeCards: [...s.holeCards] })),
    board: [...state.board],
    pots: state.pots.map((p) => ({ amount: p.amount, eligibleSeats: [...p.eligibleSeats] })),
    noRaiseSeats: [...state.noRaiseSeats],
  };
}

function freeze(d: Draft): HandState {
  return {
    handNumber: d.handNumber,
    seats: d.seats.map((s) => ({
      index: s.index,
      playerId: s.playerId,
      status: s.status,
      stack: s.stack as Chips,
      holeCards: s.holeCards,
      committedThisStreet: s.committedThisStreet as Chips,
      committedThisHand: s.committedThisHand as Chips,
      hasActedThisStreet: s.hasActedThisStreet,
      isAllIn: s.isAllIn,
    })),
    button: d.button,
    street: d.street,
    board: d.board,
    deck: d.deck,
    deckPointer: d.deckPointer,
    pots: d.pots,
    blinds: d.blinds,
    currentBet: d.currentBet as Chips,
    lastRaiseSize: d.lastRaiseSize as Chips,
    actingSeat: d.actingSeat,
    lastAggressor: d.lastAggressor,
    noRaiseSeats: d.noRaiseSeats,
    rules: d.rules,
  };
}

const c = (n: number): Chips => n as Chips;

// ---------------------------------------------------------------------------
// Seat ring helpers
// ---------------------------------------------------------------------------

/** Was this seat dealt into the current hand? */
function dealtIn(seat: DraftSeat): boolean {
  return seat.holeCards.length === 2;
}

function notFolded(seat: DraftSeat): boolean {
  return dealtIn(seat) && seat.status !== 'folded';
}

/** Can this seat still wager chips on this street? */
function canWager(seat: DraftSeat): boolean {
  return seat.status === 'active' && !seat.isAllIn;
}

/** Scan clockwise starting at `from + 1`, wrapping, returning the first seat
 *  matching the predicate, or null after a full lap. */
function nextSeatWhere(
  d: Draft,
  from: SeatIndex,
  pred: (s: DraftSeat) => boolean,
): DraftSeat | null {
  const n = d.seats.length;
  for (let step = 1; step <= n; step++) {
    const seat = must(d.seats[(from + step) % n], 'seat');
    if (pred(seat)) return seat;
  }
  return null;
}

/** Seats ordered clockwise starting left of the button — the order used for
 *  odd-chip awards (house rule 2) and showdown reveals. */
function fromLeftOfButton(d: Draft): DraftSeat[] {
  const n = d.seats.length;
  const out: DraftSeat[] = [];
  for (let step = 1; step <= n; step++) out.push(must(d.seats[(d.button + step) % n], 'seat'));
  return out;
}

// ---------------------------------------------------------------------------
// Dealing
// ---------------------------------------------------------------------------

function dealCards(d: Draft, count: number): Card[] {
  if (d.deckPointer + count > d.deck.length) {
    throw new EngineError('deck exhausted — this is a bug, a hand never needs more than 52 cards');
  }
  const cards: Card[] = [];
  for (let i = 0; i < count; i++) cards.push(must(d.deck[d.deckPointer++], 'card'));
  return cards;
}

// ---------------------------------------------------------------------------
// Betting-round bookkeeping
// ---------------------------------------------------------------------------

/** Does this seat still owe an action on this street?
 *  A seat must act when it faces an unmatched bet, or when it has not yet acted
 *  and at least two seats can still wager (betting with no possible caller is
 *  meaningless — e.g. the big blind when every opponent is all-in for less). */
function needsToAct(d: Draft, seat: DraftSeat): boolean {
  if (!canWager(seat)) return false;
  if (seat.committedThisStreet < d.currentBet) return true;
  if (!seat.hasActedThisStreet) {
    const wagerers = d.seats.filter(canWager).length;
    return wagerers >= 2;
  }
  return false;
}

/** Commit chips from a seat's stack toward this street. Handles the all-in transition. */
function commit(d: Draft, seat: DraftSeat, amount: number): number {
  const pay = Math.min(amount, seat.stack);
  if (pay < 0) throw new EngineError('negative commit');
  seat.stack -= pay;
  seat.committedThisStreet += pay;
  seat.committedThisHand += pay;
  // Blinds are posted BEFORE cards are dealt, so this must not depend on
  // holeCards: a seat that posts its whole stack as a blind is all-in already.
  if (seat.stack === 0) {
    seat.isAllIn = true;
    seat.status = 'allIn';
  }
  return pay;
}

/** A full bet/raise reopens the action: everyone else must act again with all options. */
function reopenAction(d: Draft, aggressor: SeatIndex): void {
  d.noRaiseSeats = [];
  for (const s of d.seats) {
    if (s.index !== aggressor && canWager(s)) s.hasActedThisStreet = false;
  }
  d.lastAggressor = aggressor;
}

/** A short all-in raised the bet without a full raise: seats that already acted
 *  must respond to the new amount but may only call or fold (house rule 3). */
function shortRaise(d: Draft, aggressor: SeatIndex): void {
  for (const s of d.seats) {
    if (s.index !== aggressor && canWager(s) && s.hasActedThisStreet) {
      if (!d.noRaiseSeats.includes(s.index)) d.noRaiseSeats.push(s.index);
      s.hasActedThisStreet = false;
    }
  }
  d.lastAggressor = aggressor;
}

// ---------------------------------------------------------------------------
// Side pots
// ---------------------------------------------------------------------------

/** Build pots from committedThisHand across all seats (docs/ENGINE-SPEC.md §3).
 *  Folded seats' chips stay in the pots they contributed to; they are simply not
 *  eligible. Uncalled bets fall out naturally as a final pot with one eligible seat. */
function buildPots(d: Draft): Pot[] {
  const levels = [...new Set(d.seats.map((s) => s.committedThisHand).filter((v) => v > 0))].sort(
    (a, b) => a - b,
  );
  const pots: { amount: number; eligibleSeats: SeatIndex[] }[] = [];
  let prev = 0;
  let deadMoney = 0; // contribution levels where every contributor folded (e.g. a folded big-blind ante)
  for (const level of levels) {
    const contributors = d.seats.filter((s) => s.committedThisHand >= level);
    const amount = (level - prev) * contributors.length;
    prev = level;
    const eligibleSeats = contributors.filter(notFolded).map((s) => s.index);
    if (eligibleSeats.length === 0) {
      // Dead money belongs to whoever wins the nearest live pot below it.
      deadMoney += amount;
      continue;
    }
    const last = pots[pots.length - 1];
    if (last && sameSeats(last.eligibleSeats, eligibleSeats)) {
      last.amount += amount; // merge pots with identical eligibility — cleaner for the UI
    } else {
      pots.push({ amount, eligibleSeats });
    }
  }
  const lastPot = pots[pots.length - 1];
  if (!lastPot) throw new EngineError('no pot with an eligible winner — chip accounting bug');
  lastPot.amount += deadMoney;
  return pots.map((p) => ({ amount: c(p.amount), eligibleSeats: p.eligibleSeats }));
}

function sameSeats(a: readonly SeatIndex[], b: readonly SeatIndex[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ---------------------------------------------------------------------------
// Street progression, showdown, awarding
// ---------------------------------------------------------------------------

const NEXT_STREET: Partial<Record<Street, Street>> = {
  preflop: 'flop',
  flop: 'turn',
  turn: 'river',
};

const STREET_CARDS: Partial<Record<Street, number>> = { flop: 3, turn: 1, river: 1 };

/** The current betting round is over. Form pots, then either deal the next street
 *  (running out the board when fewer than two seats can still wager) or show down. */
function completeStreet(d: Draft, events: Event[]): void {
  d.pots = buildPots(d);
  events.push({ t: 'potsFormed', pots: d.pots });

  for (;;) {
    if (d.street === 'river') {
      showdown(d, events);
      return;
    }
    const next = must(NEXT_STREET[d.street], 'next street');
    d.street = next;
    const cards = dealCards(d, must(STREET_CARDS[next], 'street card count'));
    d.board.push(...cards);
    events.push({ t: 'streetDealt', street: next, cards });

    // reset the betting round
    d.currentBet = 0;
    d.lastRaiseSize = d.blinds.bigBlind;
    d.noRaiseSeats = [];
    d.lastAggressor = null;
    for (const s of d.seats) {
      s.committedThisStreet = 0;
      s.hasActedThisStreet = false;
    }

    const first = nextSeatWhere(d, d.button, (s) => needsToAct(d, s));
    if (first) {
      d.actingSeat = first.index;
      return;
    }
    // Fewer than two seats can wager — keep dealing. (Pots are already formed.)
    d.actingSeat = null;
  }
}

function showdown(d: Draft, events: Event[]): void {
  d.street = 'showdown';
  d.actingSeat = null;
  if (d.board.length !== 5) throw new EngineError(`showdown with ${d.board.length} board cards`);

  // Reveal order: last aggressor first, otherwise first seat left of the button.
  const start = d.lastAggressor ?? ((d.button + 1) % d.seats.length);
  const n = d.seats.length;
  const reveals: { seat: SeatIndex; cards: readonly Card[] }[] = [];
  for (let step = 0; step < n; step++) {
    const seat = must(d.seats[(start + step) % n], 'seat');
    if (notFolded(seat)) reveals.push({ seat: seat.index, cards: seat.holeCards });
  }
  events.push({ t: 'showdown', reveals });

  // Award pots main-first. Split ties equally; odd chips go one each to the
  // first eligible winners left of the button (house rule 2).
  const ranks = new Map<SeatIndex, ReturnType<typeof evaluate7>>();
  for (const seat of d.seats) {
    if (notFolded(seat)) ranks.set(seat.index, evaluate7([...seat.holeCards, ...d.board]));
  }
  const buttonOrder = fromLeftOfButton(d).map((s) => s.index);

  d.pots.forEach((pot, potIndex) => {
    const contenders = pot.eligibleSeats.map((i) => ({ seat: i, rank: must(ranks.get(i), 'rank') }));
    const best = Math.max(...contenders.map((x) => x.rank.value));
    const winners = buttonOrder.filter((i) =>
      contenders.some((x) => x.seat === i && x.rank.value === best),
    );
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    for (const w of winners) {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      const amount = share + extra;
      if (amount === 0) continue;
      const seat = must(d.seats[w], 'seat');
      seat.stack += amount;
      events.push({
        t: 'potAwarded',
        pot: potIndex,
        seat: w,
        amount: c(amount),
        hand: must(ranks.get(w), 'rank'),
      });
    }
  });

  finishHand(d, events);
}

/** Everyone folded to one seat: award every pot to them without a showdown. */
function foldWin(d: Draft, events: Event[]): void {
  d.pots = buildPots(d);
  events.push({ t: 'potsFormed', pots: d.pots });
  const winner = d.seats.find(notFolded);
  if (!winner) throw new EngineError('fold win with no remaining seat');
  d.actingSeat = null;
  d.pots.forEach((pot, potIndex) => {
    if (!pot.eligibleSeats.includes(winner.index)) {
      throw new EngineError('fold win pot not winnable by last remaining seat');
    }
    winner.stack += pot.amount;
    events.push({ t: 'potAwarded', pot: potIndex, seat: winner.index, amount: pot.amount, hand: null });
  });
  finishHand(d, events);
}

function finishHand(d: Draft, events: Event[]): void {
  d.street = 'complete';
  d.actingSeat = null;
  for (const s of d.seats) {
    if (dealtIn(s) && s.stack === 0) s.status = 'busted';
  }
  events.push({ t: 'handComplete' });
  const total = d.seats.reduce((sum, s) => sum + s.stack, 0);
  void total; // chip conservation is asserted by tests against the pre-hand total
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Begin a hand. `deck` must be a pre-shuffled 52-card deck — the engine never
 *  shuffles, because the engine has no randomness. */
export function startHand(input: {
  seats: readonly Seat[];
  button: SeatIndex;
  blinds: BlindStructure;
  deck: Deck;
  handNumber: number;
  rules: HouseRules;
}): { state: HandState; events: readonly Event[] } {
  assertValidDeck(input.deck);
  if (input.blinds.bigBlind < 1) throw new EngineError('bigBlind must be at least 1');
  if (input.blinds.smallBlind < 0 || input.blinds.ante < 0) {
    throw new EngineError('negative blind or ante');
  }
  input.seats.forEach((s, i) => {
    if (s.index !== i) throw new EngineError(`seat ${i} has mismatched index ${s.index}`);
  });
  if (input.button < 0 || input.button >= input.seats.length) {
    throw new EngineError('button out of range');
  }

  const d: Draft = {
    handNumber: input.handNumber,
    seats: input.seats.map((s) => {
      const playing =
        s.playerId !== null && s.stack > 0 && s.status !== 'sittingOut' && s.status !== 'empty';
      return {
        index: s.index,
        playerId: s.playerId,
        status: playing ? 'active' : s.playerId === null ? 'empty' : s.status === 'sittingOut' ? 'sittingOut' : 'busted',
        stack: s.stack,
        holeCards: [],
        committedThisStreet: 0,
        committedThisHand: 0,
        hasActedThisStreet: false,
        isAllIn: false,
      } satisfies DraftSeat;
    }),
    button: input.button,
    street: 'preflop',
    board: [],
    deck: input.deck,
    deckPointer: 0,
    pots: [],
    blinds: input.blinds,
    currentBet: 0,
    lastRaiseSize: 0,
    actingSeat: null,
    lastAggressor: null,
    noRaiseSeats: [],
    rules: input.rules,
  };

  const players = d.seats.filter((s) => s.status === 'active');
  if (players.length < 2) throw new EngineError('a hand needs at least two players');
  if (must(d.seats[d.button], 'button seat').status !== 'active') {
    throw new EngineError('button must be on a seat that is dealt in');
  }

  const events: Event[] = [{ t: 'handStarted', handNumber: d.handNumber, button: d.button }];
  const isActive = (s: DraftSeat) => s.status === 'active' || s.status === 'allIn';

  // Heads-up: the button posts the small blind (house rule 4). Otherwise the
  // small blind is the first player left of the button.
  const headsUp = players.length === 2;
  const sbSeat = headsUp
    ? must(d.seats[d.button], 'button seat')
    : must(nextSeatWhere(d, d.button, isActive), 'small blind seat');
  const bbSeat = must(nextSeatWhere(d, sbSeat.index, isActive), 'big blind seat');

  // Antes first, then blinds (docs/ENGINE-SPEC.md §3). Antes go straight into
  // the pot: committedThisHand only, never committedThisStreet — they don't
  // count toward calling a bet.
  if (input.blinds.ante > 0 && input.blinds.anteType !== 'none') {
    const antePosters = input.blinds.anteType === 'bigBlindAnte' ? [bbSeat] : players;
    for (const seat of antePosters) {
      const pay = Math.min(input.blinds.ante, seat.stack);
      if (pay > 0) {
        seat.stack -= pay;
        seat.committedThisHand += pay;
        if (seat.stack === 0) {
          seat.isAllIn = true;
          seat.status = 'allIn';
        }
        events.push({ t: 'blindPosted', seat: seat.index, amount: c(pay), blind: 'ante' });
      }
    }
  }

  const sbPaid = commit(d, sbSeat, input.blinds.smallBlind);
  if (sbPaid > 0) events.push({ t: 'blindPosted', seat: sbSeat.index, amount: c(sbPaid), blind: 'small' });
  const bbPaid = commit(d, bbSeat, input.blinds.bigBlind);
  if (bbPaid > 0) events.push({ t: 'blindPosted', seat: bbSeat.index, amount: c(bbPaid), blind: 'big' });

  // The blinds set the betting level regardless of short stacks: even when the
  // big blind is all-in for less, the amount to call is the full big blind.
  d.currentBet = input.blinds.bigBlind;
  d.lastRaiseSize = input.blinds.bigBlind;

  // Deal two cards each, one at a time, starting left of the button.
  for (let round = 0; round < 2; round++) {
    for (const seat of fromLeftOfButton(d)) {
      if (isActive(seat)) seat.holeCards.push(...dealCards(d, 1));
    }
  }
  for (const seat of d.seats) {
    if (isActive(seat)) events.push({ t: 'holeCardsDealt', seat: seat.index });
  }

  // First to act pre-flop: left of the big blind. (In heads-up that is the
  // button/small blind — no special case needed once blinds are seated right.)
  const first = nextSeatWhere(d, bbSeat.index, (s) => needsToAct(d, s));
  if (first) {
    d.actingSeat = first.index;
  } else {
    completeStreet(d, events); // everyone is all-in from the blinds — run it out
  }

  return { state: freeze(d), events };
}

/** What can this seat legally do right now? Drives the UI, and is the same code
 *  the validator uses — so the UI can never offer an action the engine rejects. */
export function legalActions(state: HandState, seatIndex: SeatIndex): LegalActions {
  const none: LegalActions = {
    canFold: false,
    canCheck: false,
    canCall: false, callAmount: ZERO,
    canBet: false, minBet: ZERO, maxBet: ZERO,
    canRaise: false, minRaise: ZERO, maxRaise: ZERO,
    canAllIn: false, allInAmount: ZERO,
  };
  const seat = state.seats[seatIndex];
  if (!seat || state.actingSeat !== seatIndex || seat.status !== 'active' || seat.isAllIn) {
    return none;
  }

  const toCall = state.currentBet - seat.committedThisStreet;
  const maxTotal = seat.committedThisStreet + seat.stack;
  const fullMinRaise = state.currentBet + state.lastRaiseSize;
  const noRaise = state.noRaiseSeats.includes(seatIndex);

  const canCheck = toCall <= 0;
  const canCall = toCall > 0 && seat.stack > 0;
  const callAmount = c(Math.min(toCall, seat.stack));

  const canBet = state.currentBet === 0 && seat.stack > 0;
  const minBet = c(Math.min(state.blinds.bigBlind, seat.stack));
  const maxBet = c(seat.stack);

  // You can raise if you can put in more than a call, and the action is open to you.
  const canRaise = state.currentBet > 0 && maxTotal > state.currentBet && !noRaise;
  const minRaise = c(Math.min(fullMinRaise, maxTotal));
  const maxRaise = c(maxTotal);

  // All-in is always available — unless it would constitute a raise you're not allowed to make.
  const canAllIn = seat.stack > 0 && !(noRaise && maxTotal > state.currentBet);

  return {
    canFold: true,
    canCheck,
    canCall, callAmount,
    canBet, minBet, maxBet,
    canRaise, minRaise, maxRaise,
    canAllIn, allInAmount: c(maxTotal),
  };
}

/** Apply one player action. The ONLY way state advances. Illegal player input
 *  returns { ok: false }; impossible internal state throws EngineError. */
export function applyAction(state: HandState, playerAction: PlayerAction): ApplyResult {
  const { seat: seatIndex, action } = playerAction;
  if (state.street === 'showdown' || state.street === 'complete') {
    return { ok: false, reason: 'handComplete' };
  }
  if (state.actingSeat !== seatIndex) return { ok: false, reason: 'notYourTurn' };

  const d = toDraft(state);
  const seat = d.seats[seatIndex];
  if (!seat || seat.status !== 'active' || seat.isAllIn) {
    return { ok: false, reason: 'seatNotActive' };
  }

  const events: Event[] = [];
  const toCall = d.currentBet - seat.committedThisStreet;
  const maxTotal = seat.committedThisStreet + seat.stack;
  const fullMinRaise = d.currentBet + d.lastRaiseSize;
  const noRaise = d.noRaiseSeats.includes(seatIndex);

  switch (action.kind) {
    case 'fold': {
      seat.status = 'folded';
      seat.hasActedThisStreet = true;
      events.push({ t: 'acted', seat: seatIndex, action, amount: ZERO });
      break;
    }
    case 'check': {
      if (toCall > 0) return { ok: false, reason: 'cannotCheckFacingBet' };
      seat.hasActedThisStreet = true;
      events.push({ t: 'acted', seat: seatIndex, action, amount: ZERO });
      break;
    }
    case 'call': {
      if (toCall <= 0) return { ok: false, reason: 'nothingToCall' };
      if (seat.stack === 0) return { ok: false, reason: 'insufficientChips' };
      const paid = commit(d, seat, toCall);
      seat.hasActedThisStreet = true;
      events.push({ t: 'acted', seat: seatIndex, action, amount: c(paid) });
      break;
    }
    case 'bet': {
      if (d.currentBet > 0) return { ok: false, reason: 'betNotAllowedFacingBet' };
      const to = action.to;
      if (!Number.isSafeInteger(to) || to <= 0) return { ok: false, reason: 'raiseTooSmall' };
      if (to > seat.stack + seat.committedThisStreet) return { ok: false, reason: 'insufficientChips' };
      if (to < Math.min(d.blinds.bigBlind, maxTotal)) return { ok: false, reason: 'raiseTooSmall' };
      const paid = commit(d, seat, to - seat.committedThisStreet);
      seat.hasActedThisStreet = true;
      events.push({ t: 'acted', seat: seatIndex, action, amount: c(paid) });
      applyAggression(d, seat, to);
      break;
    }
    case 'raise': {
      if (d.currentBet === 0) return { ok: false, reason: 'betNotAllowedFacingBet' };
      if (noRaise) return { ok: false, reason: 'raiseNotAllowed' };
      const to = action.to;
      if (!Number.isSafeInteger(to) || to <= d.currentBet) return { ok: false, reason: 'raiseTooSmall' };
      if (to > maxTotal) return { ok: false, reason: 'insufficientChips' };
      if (to < Math.min(fullMinRaise, maxTotal)) return { ok: false, reason: 'raiseTooSmall' };
      const paid = commit(d, seat, to - seat.committedThisStreet);
      seat.hasActedThisStreet = true;
      events.push({ t: 'acted', seat: seatIndex, action, amount: c(paid) });
      applyAggression(d, seat, to);
      break;
    }
    case 'allIn': {
      if (seat.stack === 0) return { ok: false, reason: 'insufficientChips' };
      if (noRaise && maxTotal > d.currentBet) return { ok: false, reason: 'raiseNotAllowed' };
      const to = maxTotal;
      const paid = commit(d, seat, seat.stack);
      seat.hasActedThisStreet = true;
      events.push({ t: 'acted', seat: seatIndex, action, amount: c(paid) });
      if (to > d.currentBet) applyAggression(d, seat, to);
      break;
    }
    default: {
      const exhaustive: never = action;
      void exhaustive;
      throw new EngineError('unknown action kind');
    }
  }

  // Hand over by folds?
  if (d.seats.filter(notFolded).length === 1) {
    foldWin(d, events);
    return { ok: true, state: freeze(d), events };
  }

  const next = nextSeatWhere(d, seatIndex, (s) => needsToAct(d, s));
  if (next) {
    d.actingSeat = next.index;
  } else {
    completeStreet(d, events);
  }
  return { ok: true, state: freeze(d), events };
}

/** Shared bet/raise/all-in bookkeeping once chips are committed and `to` exceeds
 *  the previous bet. Decides full raise vs short all-in (house rule 3). */
function applyAggression(d: Draft, seat: DraftSeat, to: number): void {
  const isFullRaise =
    d.currentBet === 0
      ? to >= d.blinds.bigBlind // opening bet below the minimum only happens all-in
      : to >= d.currentBet + d.lastRaiseSize;

  if (isFullRaise) {
    d.lastRaiseSize = d.currentBet === 0 ? to : to - d.currentBet;
    d.currentBet = to;
    reopenAction(d, seat.index);
  } else {
    d.currentBet = to;
    // lastRaiseSize deliberately unchanged: the next full raise is measured
    // from the last FULL bet or raise, not from the short all-in.
    shortRaise(d, seat.index);
  }
}
