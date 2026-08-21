// The authoritative table. Owns the one true state; everything the clients see
// goes through redact.buildView. Data flow per action (CLAUDE.md):
// intent → Zod parse (index.ts) → auth/seat/turn check → engine → persist →
// redact per seat → broadcast.

import { randomBytes } from 'node:crypto';
import type { Chips, Event, HandState, Seat } from '@poker/engine';
import { DEFAULT_RULES, applyAction, chips, encodeCard, startHand } from '@poker/engine';
import type { ClientMessage, HandEvent, ServerMessage, TableView } from '@poker/protocol';
import { commitOf, deriveDeck, generateServerSeed } from './fairness.js';
import type { SeatOccupant, TableSnapshot } from './redact.js';
import { buildView } from './redact.js';
import type { HandRecord } from './history.js';

const MAX_SEATS = 9;
const ACTION_CLOCK_MS = 45_000; // HOUSE-RULES: action clock (to be tuned); auto check/fold on expiry
const NEXT_HAND_DELAY_MS = 6_500;
const SHOW_WINDOW_MS = 8_000;

export type Player = {
  playerId: string;
  token: string;
  name: string;
  avatar: number;
  clientSeed: string;
  isHost: boolean;
  connected: boolean;
  send: (msg: ServerMessage) => void;
};

export type ChipLogEntry = { at: number; playerName: string; delta: number; reason: string };

export type TableConfig = {
  tableName: string;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  minBuyIn: number;
  maxBuyIn: number;
};

type PendingShow = { seatIndex: number; playerId: string; cards: readonly string[] };

export class Table {
  readonly config: TableConfig;
  private readonly players = new Map<string, Player>();
  private readonly seats: (string | null)[] = Array(MAX_SEATS).fill(null); // playerId per seat
  private readonly stacks: number[] = Array(MAX_SEATS).fill(0);
  private hand: HandState | null = null;
  private handNumber = 0;
  private button = 0;
  private serverSeed: string | null = null;
  private commit: string | null = null;
  private revealedSeed: string | null = null;
  private handClientSeeds: Record<string, string> = {};
  private shownCards = new Map<number, readonly string[]>();
  private showdownSeats = new Set<number>();
  private pendingShows = new Map<string, PendingShow>();
  private showWindowUntil = 0;
  private handActions: { seat: number; action: string; to?: number }[] = [];
  readonly chipLog: ChipLogEntry[] = [];
  private actionTimer: NodeJS.Timeout | null = null;
  private nextHandTimer: NodeJS.Timeout | null = null;

  constructor(
    config: TableConfig,
    private readonly persistHand: (record: HandRecord) => void,
  ) {
    this.config = config;
  }

  // ----------------------------------------------------------------- players

  join(input: {
    name: string;
    avatar: number;
    clientSeed: string | undefined;
    isHost: boolean;
    existingToken: string | undefined;
    send: (msg: ServerMessage) => void;
  }): Player {
    if (input.existingToken) {
      for (const player of this.players.values()) {
        if (player.token === input.existingToken) {
          player.connected = true;
          player.send = input.send;
          player.name = input.name;
          this.broadcast();
          return player;
        }
      }
    }
    const player: Player = {
      playerId: randomBytes(8).toString('hex'),
      token: randomBytes(24).toString('hex'),
      name: this.uniqueName(input.name),
      avatar: input.avatar,
      clientSeed: input.clientSeed ?? randomBytes(8).toString('hex'),
      isHost: input.isHost,
      connected: true,
      send: input.send,
    };
    this.players.set(player.playerId, player);
    this.broadcast();
    return player;
  }

  private uniqueName(name: string): string {
    const taken = new Set([...this.players.values()].map((p) => p.name));
    if (!taken.has(name)) return name;
    for (let i = 2; ; i++) {
      const candidate = `${name.slice(0, 13)} ${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  disconnect(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;
    player.connected = false;
    // Seat and chips are kept — the player can reclaim them with their token.
    // The action clock will check/fold for them if it is their turn.
    this.broadcast();
  }

  // ------------------------------------------------------------------ intents

  handle(playerId: string, msg: ClientMessage): ServerMessage | null {
    const player = this.players.get(playerId);
    if (!player) return err('unknownPlayer', 'You are not at this table.');
    switch (msg.type) {
      case 'sit':
        return this.sit(player, msg.seat, msg.buyIn);
      case 'standUp':
        return this.standUp(player);
      case 'leave':
        return this.leave(player);
      case 'topUp':
        return this.topUp(player, msg.amount);
      case 'startHand':
        return this.requestStartHand(player);
      case 'action':
        return this.playerAction(player, msg.handNumber, msg.action);
      case 'setClientSeed':
        player.clientSeed = msg.seed.slice(0, 64);
        this.broadcast();
        return null;
      case 'show':
        return this.show(player, msg.cards);
      case 'chat':
      case 'emote':
      case 'join':
        return null; // handled at the connection layer
      default:
        return null;
    }
  }

  private seatOf(playerId: string): number {
    return this.seats.findIndex((id) => id === playerId);
  }

  private sit(player: Player, seatIndex: number, buyIn: number): ServerMessage | null {
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return err('badSeat', 'No such seat.');
    if (this.seats[seatIndex] !== null) return err('seatTaken', 'That seat is taken.');
    if (this.seatOf(player.playerId) !== -1) return err('alreadySeated', 'You are already seated.');
    if (buyIn < this.config.minBuyIn || buyIn > this.config.maxBuyIn) {
      return err('badBuyIn', `Buy-in must be ${this.config.minBuyIn}–${this.config.maxBuyIn}.`);
    }
    this.seats[seatIndex] = player.playerId;
    this.stacks[seatIndex] = buyIn;
    this.logChips(player.name, buyIn, 'buy-in');
    this.maybeScheduleNextHand();
    this.broadcast();
    return null;
  }

  private standUp(player: Player): ServerMessage | null {
    const seatIndex = this.seatOf(player.playerId);
    if (seatIndex === -1) return err('notSeated', 'You are not seated.');
    if (this.handInProgress() && this.hand?.seats[seatIndex]?.status === 'active') {
      return err('inHand', 'Finish the hand first (fold, then stand up).');
    }
    this.seats[seatIndex] = null;
    this.stacks[seatIndex] = 0;
    this.logChips(player.name, 0, 'stood up (chips withdrawn)');
    this.broadcast();
    return null;
  }

  private leave(player: Player): ServerMessage | null {
    const seatIndex = this.seatOf(player.playerId);
    if (seatIndex !== -1) {
      if (this.handInProgress() && this.hand?.seats[seatIndex]?.status === 'active') {
        return err('inHand', 'Finish the hand first.');
      }
      this.seats[seatIndex] = null;
      this.stacks[seatIndex] = 0;
    }
    this.players.delete(player.playerId);
    this.broadcast();
    return null;
  }

  private topUp(player: Player, amount: number): ServerMessage | null {
    const seatIndex = this.seatOf(player.playerId);
    if (seatIndex === -1) return err('notSeated', 'Sit down first.');
    if (this.handInProgress()) return err('inHand', 'Top up between hands.');
    const stack = this.stacks[seatIndex] ?? 0;
    const room = this.config.maxBuyIn - stack;
    if (room <= 0) return err('maxStack', 'You are at the table maximum.');
    const granted = Math.min(amount, room);
    if (granted <= 0) return err('badAmount', 'Nothing to add.');
    this.stacks[seatIndex] = stack + granted;
    // Every chip adjustment is logged and publicly visible — the single best
    // anti-suspicion feature in the app (build plan §4).
    this.logChips(player.name, granted, 'top-up');
    this.broadcast();
    return null;
  }

  private requestStartHand(player: Player): ServerMessage | null {
    if (this.handInProgress()) return err('inHand', 'A hand is already running.');
    if (!player.isHost && this.handNumber === 0) {
      return err('hostOnly', 'The host starts the first hand.');
    }
    return this.startNextHand();
  }

  handInProgress(): boolean {
    return this.hand !== null && this.hand.street !== 'complete';
  }

  private eligibleSeatCount(): number {
    return this.seats.filter((id, i) => id !== null && (this.stacks[i] ?? 0) > 0).length;
  }

  // -------------------------------------------------------------- hand lifecycle

  private startNextHand(): ServerMessage | null {
    if (this.eligibleSeatCount() < 2) {
      return err('needPlayers', 'Need at least two seated players with chips.');
    }
    this.clearTimers();
    this.handNumber += 1;
    this.shownCards.clear();
    this.showdownSeats.clear();
    this.pendingShows.clear();
    this.handActions = [];
    this.revealedSeed = null;

    // Advance the button to the next occupied seat with chips.
    this.button = this.nextEligibleSeat(this.handNumber === 1 ? MAX_SEATS - 1 : this.button);

    // --- Fairness: commit BEFORE any card exists. Seeds joined in seat order. ---
    this.serverSeed = generateServerSeed();
    this.commit = commitOf(this.serverSeed);
    const seedsInSeatOrder: string[] = [];
    this.handClientSeeds = {};
    for (let i = 0; i < MAX_SEATS; i++) {
      const playerId = this.seats[i] ?? null;
      if (playerId !== null && (this.stacks[i] ?? 0) > 0) {
        const player = this.players.get(playerId);
        if (player) {
          seedsInSeatOrder.push(player.clientSeed);
          this.handClientSeeds[player.name] = player.clientSeed;
        }
      }
    }
    this.sendToAll({
      type: 'handCommit',
      handNumber: this.handNumber,
      commit: this.commit,
      clientSeeds: this.handClientSeeds,
    });

    const deck = deriveDeck(this.serverSeed, seedsInSeatOrder, this.handNumber);

    const seats: Seat[] = [];
    for (let i = 0; i < MAX_SEATS; i++) {
      const playerId = this.seats[i] ?? null;
      const stack = this.stacks[i] ?? 0;
      seats.push({
        index: i,
        playerId,
        status: playerId === null ? 'empty' : stack > 0 ? 'active' : 'busted',
        stack: chips(Math.max(0, stack)),
        holeCards: [],
        committedThisStreet: chips(0),
        committedThisHand: chips(0),
        hasActedThisStreet: false,
        isAllIn: false,
      });
    }

    const { state, events } = startHand({
      seats,
      button: this.button,
      blinds: {
        smallBlind: chips(this.config.smallBlind),
        bigBlind: chips(this.config.bigBlind),
        ante: chips(this.config.ante),
        anteType: this.config.ante > 0 ? 'perPlayer' : 'none',
      },
      deck,
      handNumber: this.handNumber,
      rules: DEFAULT_RULES,
    });
    this.hand = state;
    this.afterEngineStep(events);
    return null;
  }

  private nextEligibleSeat(from: number): number {
    for (let step = 1; step <= MAX_SEATS; step++) {
      const i = (from + step) % MAX_SEATS;
      if (this.seats[i] !== null && (this.stacks[i] ?? 0) > 0) return i;
    }
    return 0;
  }

  private playerAction(
    player: Player,
    handNumber: number,
    action: { kind: 'fold' | 'check' | 'call' | 'allIn' } | { kind: 'bet' | 'raise'; to: number },
  ): ServerMessage | null {
    const hand = this.hand;
    if (!hand || !this.handInProgress()) return err('noHand', 'No hand in progress.');
    if (handNumber !== this.handNumber) return err('staleHand', 'That hand is over.');
    const seatIndex = this.seatOf(player.playerId);
    if (seatIndex === -1) return err('notSeated', 'You are not in this hand.');
    // Turn check BEFORE the engine sees anything (hard rule 6).
    if (hand.actingSeat !== seatIndex) return err('notYourTurn', 'Not your turn.');

    const engineAction =
      action.kind === 'bet' || action.kind === 'raise'
        ? { kind: action.kind, to: chips(action.to) }
        : { kind: action.kind };

    const result = applyAction(hand, { seat: seatIndex, action: engineAction });
    if (!result.ok) return err(result.reason, humanReason(result.reason));

    this.handActions.push({
      seat: seatIndex,
      action: action.kind,
      ...('to' in action ? { to: action.to } : {}),
    });
    this.hand = result.state;
    this.afterEngineStep(result.events);
    return null;
  }

  /** Persist, redact, broadcast, and manage clocks after every engine step. */
  private afterEngineStep(events: readonly Event[]): void {
    const hand = this.hand;
    if (!hand) return;

    for (const e of events) {
      if (e.t === 'showdown') {
        for (const reveal of e.reveals) this.showdownSeats.add(reveal.seat);
      }
    }

    this.sendToAll({
      type: 'events',
      handNumber: this.handNumber,
      events: events.map((e) => redactEvent(e)),
    });

    if (hand.street === 'complete') {
      this.completeHand();
    } else {
      this.armActionClock();
    }
    this.broadcast();
  }

  private completeHand(): void {
    const hand = this.hand;
    if (!hand || this.serverSeed === null || this.commit === null) return;

    // Write stacks back to the table — only for seats still occupied by the
    // same player (someone may have folded and stood up mid-hand).
    for (const seat of hand.seats) {
      if (seat.playerId !== null && this.seats[seat.index] === seat.playerId) {
        this.stacks[seat.index] = seat.stack;
      }
    }

    // Reveal the server seed — the other half of the commit.
    this.revealedSeed = this.serverSeed;
    this.sendToAll({
      type: 'handReveal',
      handNumber: this.handNumber,
      serverSeed: this.serverSeed,
      commit: this.commit,
    });

    // Open the show-your-hand window for seats that didn't reach showdown.
    this.showWindowUntil = Date.now() + SHOW_WINDOW_MS;

    // Full hand history, visible to everyone, downloadable. Transparency is
    // the product (build plan §2.3). Hole cards become public AFTER the hand.
    const record: HandRecord = {
      handNumber: this.handNumber,
      at: new Date().toISOString(),
      tableName: this.config.tableName,
      commit: this.commit,
      serverSeed: this.serverSeed,
      clientSeeds: this.handClientSeeds,
      button: hand.button,
      blinds: { ...this.config },
      seats: hand.seats
        .filter((s) => s.holeCards.length > 0)
        .map((s) => ({
          seat: s.index,
          name: this.players.get(s.playerId ?? '')?.name ?? 'unknown',
          holeCards: s.holeCards.map(encodeCard),
          finalStatus: s.status,
          stackAfter: s.stack,
        })),
      board: hand.board.map(encodeCard),
      actions: this.handActions,
      pots: hand.pots.map((p) => ({ amount: p.amount, eligibleSeats: [...p.eligibleSeats] })),
    };
    this.persistHand(record);

    this.serverSeed = null;
    this.maybeScheduleNextHand();
  }

  private show(player: Player, which: 'both' | 'first' | 'second'): ServerMessage | null {
    if (this.handInProgress()) return err('inHand', 'Wait for the hand to finish.');
    if (Date.now() > this.showWindowUntil) return err('showClosed', 'The show window has closed.');
    const hand = this.hand;
    if (!hand) return err('noHand', 'Nothing to show.');
    const seatIndex = this.seatOf(player.playerId);
    const seat = hand.seats[seatIndex];
    if (!seat || seat.holeCards.length !== 2) return err('noCards', 'You had no cards.');
    if (this.showdownSeats.has(seatIndex)) return err('alreadyShown', 'Your hand was already shown.');
    const cards = seat.holeCards.map(encodeCard);
    const shown =
      which === 'both' ? cards : which === 'first' ? [cards[0] as string] : [cards[1] as string];
    this.shownCards.set(seatIndex, shown);
    this.broadcast();
    return null;
  }

  private maybeScheduleNextHand(): void {
    if (this.handInProgress()) return;
    if (this.handNumber === 0) return; // host starts the first hand
    if (this.eligibleSeatCount() < 2) return;
    if (this.nextHandTimer) return;
    this.nextHandTimer = setTimeout(() => {
      this.nextHandTimer = null;
      if (!this.handInProgress() && this.eligibleSeatCount() >= 2) this.startNextHand();
    }, NEXT_HAND_DELAY_MS);
  }

  // ---------------------------------------------------------------- clock

  private armActionClock(): void {
    this.clearActionTimer();
    const hand = this.hand;
    if (!hand || hand.actingSeat === null) return;
    const actingSeat = hand.actingSeat;
    const handNumber = this.handNumber;
    this.actionTimer = setTimeout(() => {
      const current = this.hand;
      if (!current || this.handNumber !== handNumber || current.actingSeat !== actingSeat) return;
      // Disconnect/timeout policy: auto-check when free, otherwise fold.
      const check = applyAction(current, { seat: actingSeat, action: { kind: 'check' } });
      const result = check.ok
        ? check
        : applyAction(current, { seat: actingSeat, action: { kind: 'fold' } });
      if (result.ok) {
        this.handActions.push({ seat: actingSeat, action: check.ok ? 'check (timeout)' : 'fold (timeout)' });
        this.hand = result.state;
        this.afterEngineStep(result.events);
      }
    }, ACTION_CLOCK_MS);
  }

  private clearActionTimer(): void {
    if (this.actionTimer) clearTimeout(this.actionTimer);
    this.actionTimer = null;
  }

  private clearTimers(): void {
    this.clearActionTimer();
    if (this.nextHandTimer) clearTimeout(this.nextHandTimer);
    this.nextHandTimer = null;
  }

  // ---------------------------------------------------------------- output

  private logChips(playerName: string, delta: number, reason: string): void {
    this.chipLog.push({ at: Date.now(), playerName, delta, reason });
    this.sendToAll({ type: 'chipLog', entries: this.chipLog.slice(-20) });
  }

  snapshot(): TableSnapshot {
    const occupants: (SeatOccupant | null)[] = this.seats.map((playerId) => {
      if (playerId === null) return null;
      const player = this.players.get(playerId);
      if (!player) return null;
      return {
        playerId: player.playerId,
        name: player.name,
        avatar: player.avatar,
        connected: player.connected,
      };
    });
    return {
      tableName: this.config.tableName,
      hostId: [...this.players.values()].find((p) => p.isHost)?.playerId ?? null,
      occupants,
      idleStacks: [...this.stacks],
      hand: this.hand,
      handNumber: this.handNumber,
      shownCards: this.shownCards,
      showdownSeats: this.showdownSeats,
      blinds: {
        smallBlind: this.config.smallBlind,
        bigBlind: this.config.bigBlind,
        ante: this.config.ante,
      },
      fairness: this.commit
        ? {
            commit: this.commit,
            clientSeeds: this.handClientSeeds,
            revealedServerSeed: this.revealedSeed,
          }
        : null,
    };
  }

  viewFor(playerId: string | null): TableView {
    return buildView(this.snapshot(), playerId);
  }

  broadcast(): void {
    const snapshot = this.snapshot();
    for (const player of this.players.values()) {
      if (!player.connected) continue;
      player.send({ type: 'state', view: buildView(snapshot, player.playerId) });
    }
  }

  sendToAll(msg: ServerMessage): void {
    for (const player of this.players.values()) {
      if (player.connected) player.send(msg);
    }
  }

  playerByName(name: string): Player | undefined {
    return [...this.players.values()].find((p) => p.name === name);
  }

  getPlayer(playerId: string): Player | undefined {
    return this.players.get(playerId);
  }
}

function err(code: string, message: string): ServerMessage {
  return { type: 'error', code, message };
}

function humanReason(reason: string): string {
  const map: Record<string, string> = {
    notYourTurn: 'Not your turn.',
    seatNotActive: 'You cannot act right now.',
    cannotCheckFacingBet: 'There is a bet — call, raise, or fold.',
    nothingToCall: 'Nothing to call — you can check.',
    raiseTooSmall: 'That raise is below the minimum.',
    raiseTooLarge: 'That raise is too large.',
    betNotAllowedFacingBet: 'There is already a bet — raise instead.',
    raiseNotAllowed: 'The short all-in does not reopen raising for you.',
    insufficientChips: 'Not enough chips.',
    handComplete: 'The hand is over.',
  };
  return map[reason] ?? 'Illegal action.';
}

/** Engine events are already safe for broadcast — hole cards never ride on
 *  events (holeCardsDealt carries only the seat). Card-bearing events are the
 *  public board and public showdown reveals. */
function redactEvent(e: Event): HandEvent {
  switch (e.t) {
    case 'handStarted':
      return { t: e.t, handNumber: e.handNumber, button: e.button };
    case 'blindPosted':
      return { t: e.t, seat: e.seat, amount: e.amount, blind: e.blind };
    case 'holeCardsDealt':
      return { t: e.t, seat: e.seat };
    case 'acted':
      return { t: e.t, seat: e.seat, amount: e.amount, action: toWireAction(e.action) };
    case 'streetDealt':
      return { t: e.t, street: e.street, cards: e.cards.map(encodeCard) };
    case 'potsFormed':
      return { t: e.t };
    case 'showdown':
      return { t: e.t };
    case 'potAwarded':
      return {
        t: e.t,
        pot: e.pot,
        seat: e.seat,
        amount: e.amount,
        ...(e.hand ? { label: e.hand.label } : {}),
      };
    case 'handComplete':
      return { t: e.t };
    default:
      return { t: (e as { t: string }).t };
  }
}

function toWireAction(a: {
  kind: string;
  to?: Chips;
}): { kind: 'fold' | 'check' | 'call' | 'allIn' } | { kind: 'bet' | 'raise'; to: number } {
  if (a.kind === 'bet' || a.kind === 'raise') {
    return { kind: a.kind, to: a.to ?? 0 };
  }
  return { kind: a.kind as 'fold' | 'check' | 'call' | 'allIn' };
}
