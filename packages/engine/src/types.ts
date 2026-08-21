// Core types for the pure NLHE engine. See docs/ENGINE-SPEC.md.
// This package is PURE: no I/O, no randomness, no Date.now(), zero dependencies.

// ---------- cards ----------
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14; // 11=J 12=Q 13=K 14=A
export type Suit = 's' | 'h' | 'd' | 'c';
export type Card = { readonly rank: Rank; readonly suit: Suit };
export type Deck = readonly Card[]; // always 52, always pre-shuffled by the caller

// ---------- money ----------
/** Chips are integers. Always. There are no fractional chips and no floats anywhere
 *  in this package. A float in chip arithmetic is a bug by definition. */
export type Chips = number & { readonly __brand: 'Chips' };

/** The only way to make Chips. Throws EngineError on non-integer or negative input,
 *  because either one is a bug, not a player mistake. */
export function chips(n: number): Chips {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new EngineError(`invalid chip amount: ${n}`);
  }
  return n as Chips;
}

export const ZERO: Chips = 0 as Chips;

// ---------- table ----------
export type SeatIndex = number; // 0..maxSeats-1, fixed physical position
export type SeatStatus = 'empty' | 'active' | 'folded' | 'allIn' | 'sittingOut' | 'busted';

export type Seat = {
  readonly index: SeatIndex;
  readonly playerId: string | null;
  readonly status: SeatStatus;
  readonly stack: Chips;
  readonly holeCards: readonly Card[]; // [] when not dealt in
  readonly committedThisStreet: Chips; // reset each street
  readonly committedThisHand: Chips; // used to build side pots (includes antes)
  readonly hasActedThisStreet: boolean;
  readonly isAllIn: boolean;
};

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete';

export type Pot = {
  readonly amount: Chips;
  readonly eligibleSeats: readonly SeatIndex[]; // seats that can win THIS pot
};

export type BlindStructure = {
  readonly smallBlind: Chips;
  readonly bigBlind: Chips;
  readonly ante: Chips; // 0 if none
  readonly anteType: 'none' | 'perPlayer' | 'bigBlindAnte';
};

export type HouseRules = {
  /** House rule 2: the odd chip on a split pot goes to the first eligible seat
   *  left of the button. */
  readonly oddChipRule: 'firstLeftOfButton';
};

export const DEFAULT_RULES: HouseRules = { oddChipRule: 'firstLeftOfButton' };

export type HandState = {
  readonly handNumber: number;
  readonly seats: readonly Seat[];
  readonly button: SeatIndex;
  readonly street: Street;
  readonly board: readonly Card[]; // 0, 3, 4, or 5
  readonly deck: Deck; // full deck; dealt from index 0 upward
  readonly deckPointer: number; // next card index. Only ever increments.
  readonly pots: readonly Pot[];
  readonly blinds: BlindStructure;
  readonly currentBet: Chips; // highest committedThisStreet this street
  readonly lastRaiseSize: Chips; // for minimum re-raise calculation
  readonly actingSeat: SeatIndex | null; // null when the street is complete
  readonly lastAggressor: SeatIndex | null; // for showdown order
  /** Seats that may only call or fold for the rest of this street, because a short
   *  all-in raised the bet without constituting a full raise (house rule 3). */
  readonly noRaiseSeats: readonly SeatIndex[];
  readonly rules: HouseRules;
};

// ---------- actions ----------
export type Action =
  | { readonly kind: 'fold' }
  | { readonly kind: 'check' }
  | { readonly kind: 'call' }
  | { readonly kind: 'bet'; readonly to: Chips } // `to` is a TOTAL for this street, never a delta.
  | { readonly kind: 'raise'; readonly to: Chips } // Deltas are where off-by-one bugs live.
  | { readonly kind: 'allIn' };

export type PlayerAction = { readonly seat: SeatIndex; readonly action: Action };

// ---------- hand ranks ----------
export type HandCategory = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9; // 1 high card … 9 straight flush

export type HandRank = {
  readonly category: HandCategory;
  readonly value: number; // single comparable integer, kickers included
  readonly cards: readonly Card[]; // the best five, for display
  readonly label: string; // "Flush, King high" — for the UI and hand histories
};

// ---------- events (what the UI animates from) ----------
export type Event =
  | { readonly t: 'handStarted'; readonly handNumber: number; readonly button: SeatIndex }
  | {
      readonly t: 'blindPosted';
      readonly seat: SeatIndex;
      readonly amount: Chips;
      readonly blind: 'small' | 'big' | 'ante';
    }
  | { readonly t: 'holeCardsDealt'; readonly seat: SeatIndex } // cards themselves come via redaction
  | {
      readonly t: 'acted';
      readonly seat: SeatIndex;
      readonly action: Action;
      readonly amount: Chips;
    }
  | { readonly t: 'streetDealt'; readonly street: Street; readonly cards: readonly Card[] }
  | { readonly t: 'potsFormed'; readonly pots: readonly Pot[] }
  | {
      readonly t: 'showdown';
      readonly reveals: readonly { readonly seat: SeatIndex; readonly cards: readonly Card[] }[];
    }
  | {
      readonly t: 'potAwarded';
      readonly pot: number;
      readonly seat: SeatIndex;
      readonly amount: Chips;
      readonly hand: HandRank | null;
    }
  | { readonly t: 'handComplete' };

// ---------- results ----------
export type IllegalActionReason =
  | 'notYourTurn'
  | 'seatNotActive'
  | 'cannotCheckFacingBet'
  | 'nothingToCall'
  | 'raiseTooSmall'
  | 'raiseTooLarge'
  | 'betNotAllowedFacingBet'
  | 'raiseNotAllowed'
  | 'insufficientChips'
  | 'handComplete';

export type ApplyResult =
  | { readonly ok: true; readonly state: HandState; readonly events: readonly Event[] }
  | { readonly ok: false; readonly reason: IllegalActionReason }; // player error — NOT a throw

export type LegalActions = {
  readonly canFold: boolean;
  readonly canCheck: boolean;
  readonly canCall: boolean;
  readonly callAmount: Chips;
  readonly canBet: boolean;
  readonly minBet: Chips;
  readonly maxBet: Chips;
  readonly canRaise: boolean;
  readonly minRaise: Chips;
  readonly maxRaise: Chips;
  readonly canAllIn: boolean;
  readonly allInAmount: Chips;
};

/** Impossible internal state — a bug. Crashes loudly in tests.
 *  Illegal PLAYER input never throws; it returns { ok: false }. Never conflate the two. */
export class EngineError extends Error {
  override name = 'EngineError';
}

/** Narrow an indexed access or lookup. Engine invariants guarantee presence; absence is a bug. */
export function must<T>(x: T | null | undefined, what = 'value'): T {
  if (x === undefined || x === null) throw new EngineError(`missing ${what}`);
  return x;
}
