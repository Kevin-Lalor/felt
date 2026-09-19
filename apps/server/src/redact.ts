// Redaction: the security boundary of the whole app (CLAUDE.md hard rule 2).
// Before ANY broadcast, the authoritative state passes through buildView to
// produce a per-player view. Other players' hole cards are ABSENT from the
// payload — not flagged, not obscured: absent. The deck never leaves this
// module at all.

import type { HandState } from '@poker/engine';
import { encodeCard, legalActions } from '@poker/engine';
import type { PlayerSkin, SeatView, TableView } from '@poker/protocol';

export type SeatOccupant = {
  playerId: string;
  name: string;
  avatar: number;
  /** Public cosmetics — see playerSkinSchema in @poker/protocol. */
  skin: PlayerSkin;
  connected: boolean;
};

/** Empty seats have no player, so no skin. Never rendered as chips. */
const NO_SKIN: PlayerSkin = { chipStyle: 'casino', chipColour: 'red' };

export type TableSnapshot = {
  tableName: string;
  hostId: string | null;
  /** Physical seat occupancy — who is sitting where, independent of the hand. */
  occupants: readonly (SeatOccupant | null)[];
  /** Stacks for seats not covered by a live hand (idle table). */
  idleStacks: readonly number[];
  hand: HandState | null;
  handNumber: number;
  /** Cards voluntarily shown after the hand (show one / show both). Public. */
  shownCards: ReadonlyMap<number, readonly string[]>;
  /** Showdown reveals from the finished hand. Public. */
  showdownSeats: ReadonlySet<number>;
  /** Action clock: when the current actor's time runs out, and its full length. */
  actionDeadline: number | null;
  actionClockMs: number;
  blinds: { smallBlind: number; bigBlind: number; ante: number };
  /** Mirrors the wire shape exactly so buildView passes it straight through. */
  fairness: TableView['fairness'];
};

/** Streets where hole cards are still private. After 'showdown' the engine has
 *  already emitted public reveals for the seats that reached it. */
function holeCardsArePrivate(hand: HandState): boolean {
  if (hand.street === 'showdown') return false;
  if (hand.street === 'complete') {
    // Complete via showdown → contested seats were revealed. Complete via
    // everyone-folding → nothing is revealed unless the winner chooses to show.
    return false; // callers must pass showdownSeats to decide; see buildSeatView
  }
  return true;
}

function buildSeatView(
  snapshot: TableSnapshot,
  seatIndex: number,
  viewerPlayerId: string | null,
): SeatView {
  const occupant = snapshot.occupants[seatIndex] ?? null;
  const hand = snapshot.hand;
  const handSeat = hand?.seats[seatIndex];

  // A hand seat describes the player the hand was dealt to. If that is not the
  // player sitting here NOW, nothing in it describes the current occupant —
  // not their stack, not their status, not whether they hold cards. Reading it
  // anyway showed a player who bought in mid-hand a stack of 0 (their seat was
  // empty when the hand started, so the record says 0), and showed someone who
  // took a vacated seat the departed player's chips. Same failure as the hole
  // cards below: identity inferred from the seat index.
  const ownSeat =
    handSeat && handSeat.playerId !== null && handSeat.playerId === occupant?.playerId
      ? handSeat
      : null;

  const base: SeatView = {
    index: seatIndex,
    playerId: occupant?.playerId ?? null,
    name: occupant?.name ?? null,
    avatar: occupant?.avatar ?? null,
    // Seated but not in this hand — bought in mid-hand, or sat out — is
    // 'sittingOut'. They are dealt in when the next hand starts.
    status: occupant === null ? 'empty' : (ownSeat?.status ?? 'sittingOut'),
    // Not in the hand → the authoritative stack is the table's, not the hand's.
    stack: ownSeat ? ownSeat.stack : (snapshot.idleStacks[seatIndex] ?? 0),
    committedThisStreet: ownSeat?.committedThisStreet ?? 0,
    isAllIn: ownSeat?.isAllIn ?? false,
    hasCards: (ownSeat?.holeCards.length ?? 0) > 0 && ownSeat?.status !== 'folded',
    skin: occupant?.skin ?? NO_SKIN,
    connected: occupant?.connected ?? false,
  };

  if (!hand || !handSeat || handSeat.holeCards.length === 0) return base;

  // Identity is NEVER inferred from the seat index alone on this boundary. The
  // cards belong to the player they were dealt to, not to whoever occupies the
  // seat now — a seat vacated and retaken mid-hand used to hand the previous
  // occupant's hole cards straight to the new player.
  const dealtTo = handSeat.playerId;
  const isViewer =
    dealtTo !== null && dealtTo === viewerPlayerId && occupant?.playerId === dealtTo;
  const encoded = handSeat.holeCards.map(encodeCard);

  if (isViewer) {
    // Your own cards — and only yours — ride on your own seat.
    return { ...base, holeCards: encoded };
  }

  // Public reveals: showdown participants once the hand reaches showdown, and
  // voluntary shows after the hand. Everything else: the cards DO NOT EXIST in
  // this payload.
  if (!holeCardsArePrivate(hand)) {
    if (snapshot.showdownSeats.has(seatIndex) && handSeat.status !== 'folded') {
      return { ...base, shownCards: encoded };
    }
  }
  const shown = snapshot.shownCards.get(seatIndex);
  if (shown && shown.length > 0) {
    return { ...base, shownCards: [...shown] };
  }
  return base;
}

export function buildView(snapshot: TableSnapshot, viewerPlayerId: string | null): TableView {
  const hand = snapshot.hand;
  const seats: SeatView[] = [];
  for (let i = 0; i < snapshot.occupants.length; i++) {
    seats.push(buildSeatView(snapshot, i, viewerPlayerId));
  }

  const yourSeat = seats.findIndex((s) => s.playerId !== null && s.playerId === viewerPlayerId);
  const acting = hand?.actingSeat ?? null;
  const yourSeatOrNull = yourSeat === -1 ? null : yourSeat;

  const legal =
    hand && acting !== null && yourSeatOrNull !== null && acting === yourSeatOrNull
      ? legalActions(hand, acting)
      : null;

  const potTotal = hand
    ? hand.seats.reduce((sum, s) => sum + s.committedThisHand, 0)
    : 0;

  return {
    tableName: snapshot.tableName,
    handNumber: snapshot.handNumber,
    street: hand ? hand.street : 'idle',
    button: hand?.button ?? 0,
    actingSeat: acting,
    board: hand ? hand.board.map(encodeCard) : [],
    pots: hand ? hand.pots.map((p) => ({ amount: p.amount, eligibleSeats: [...p.eligibleSeats] })) : [],
    potTotal,
    currentBet: hand?.currentBet ?? 0,
    blinds: snapshot.blinds,
    seats,
    yourSeat: yourSeatOrNull,
    actionDeadline: acting === null ? null : snapshot.actionDeadline,
    actionClockMs: snapshot.actionClockMs,
    legal: legal
      ? {
          canFold: legal.canFold,
          canCheck: legal.canCheck,
          canCall: legal.canCall,
          callAmount: legal.callAmount,
          canBet: legal.canBet,
          minBet: legal.minBet,
          maxBet: legal.maxBet,
          canRaise: legal.canRaise,
          minRaise: legal.minRaise,
          maxRaise: legal.maxRaise,
          canAllIn: legal.canAllIn,
          allInAmount: legal.allInAmount,
        }
      : null,
    fairness: snapshot.fairness,
    hostId: snapshot.hostId,
  };
}
