// The authoritative table. Owns the one true state; everything the clients see
// goes through redact.buildView. Data flow per action (CLAUDE.md):
// intent → Zod parse (index.ts) → auth/seat/turn check → engine → persist →
// redact per seat → broadcast.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Chips, Event, HandState, Seat } from '@poker/engine';
import { DEFAULT_RULES, applyAction, chips, encodeCard, startHand } from '@poker/engine';
import type {
  ChipColour,
  ClientMessage,
  ClientSeedEntry,
  HandEvent,
  PlayerSkin,
  ServerMessage,
  TableView,
} from '@poker/protocol';
import { commitOf, deriveDeck, generateServerSeed } from './fairness.js';
import type { SeatOccupant, TableSnapshot } from './redact.js';
import { buildView } from './redact.js';
import type { HandRecord } from './history.js';

const MAX_SEATS = 9;
/** Chip colours handed out in order as players join, so a fresh table has nine
 *  distinguishable stacks instead of nine red ones. Players can change theirs. */
const CHIP_COLOUR_ROTATION: readonly ChipColour[] = [
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'pink',
  'white',
  'black',
];
const ACTION_CLOCK_MS = 45_000; // HOUSE-RULES: action clock (to be tuned); auto check/fold on expiry
const NEXT_HAND_DELAY_MS = 6_500;
const SHOW_WINDOW_MS = 8_000;

export type Player = {
  playerId: string;
  token: string;
  name: string;
  avatar: number;
  clientSeed: string;
  /** The commitment that was public when this seed was chosen. A seed only
   *  constrains the server if it was picked AFTER the commitment it goes into. */
  seedSetAgainstCommit: string;
  /** Cosmetics this player chose. Public to the whole table by design. */
  skin: PlayerSkin;
  isHost: boolean;
  connected: boolean;
  /** Where this player stands with the table (HOUSE-RULES #6, #7).
   *  'in'      — dealt in.
   *  'out'     — sitting out: seat and stack kept, dealt out entirely.
   *  'waiting' — back, but waiting for the big blind to reach them. */
  seatState: 'in' | 'out' | 'waiting';
  /** Pressed Sit out during a live hand: applies once it ends (#11). */
  sitOutAfterHand: boolean;
  /** Chose to post rather than wait. Consumed by the next deal (#7). */
  posting: boolean;
  /** The big blind has passed this seat since they sat out, so returning is a
   *  choice between posting and waiting rather than just being dealt in. */
  missedBlind: boolean;
  send: (msg: ServerMessage) => void;
};

/** Walking clockwise, does the arc (from, to] contain `target`?
 *  Used to answer "has the big blind passed this seat while it sat out". */
export function blindPassed(from: number, to: number, target: number): boolean {
  for (let step = 1; step <= MAX_SEATS; step++) {
    const seat = (from + step) % MAX_SEATS;
    if (seat === target) return true;
    if (seat === to) return false;
  }
  return false;
}

/** Which seat the big blind will land on, for a given button and set of seats
 *  in the hand.
 *
 *  The engine decides this and says so on `handStarted` — but only AFTER the
 *  deal, and whether a waiting player rejoins THIS hand has to be settled
 *  before it. So this mirrors the engine's rule (house rule 4 for heads-up,
 *  otherwise first and second live seats left of the button), and a property
 *  test asserts the two agree for every button and participant set. If they
 *  ever drift, that test fails rather than a game night. */
export function bigBlindSeatFor(inHand: readonly number[], button: number): number | null {
  if (inHand.length < 2) return null;
  const seated = new Set(inHand);
  const nextIn = (from: number): number => {
    for (let step = 1; step <= MAX_SEATS; step++) {
      const seat = (from + step) % MAX_SEATS;
      if (seated.has(seat)) return seat;
    }
    return from;
  };
  // Heads-up the button posts the small blind (house rule 4), so the big blind
  // is the other player either way.
  const smallBlind = inHand.length === 2 ? button : nextIn(button);
  return nextIn(smallBlind);
}

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
  /** Distinguishes hands across restarts — handNumber alone resets to 0 while
   *  history.jsonl persists, so it is not unique. */
  private readonly sessionId = randomBytes(4).toString('hex');
  private button = 0;
  private serverSeed: string | null = null;
  private commit: string | null = null;
  private revealedSeed: string | null = null;
  /** Seed and commitment for the NEXT hand, minted one hand ahead so every
   *  client seed is chosen after the commitment it will be mixed into. */
  private nextServerSeed: string;
  private nextCommit: string;
  private handSeeds: ClientSeedEntry[] = [];
  private shownCards = new Map<number, readonly string[]>();
  private showdownSeats = new Set<number>();
  private pendingShows = new Map<string, PendingShow>();
  private showWindowUntil = 0;
  private handActions: { seat: number; action: string; to?: number }[] = [];
  readonly chipLog: ChipLogEntry[] = [];
  private actionTimer: NodeJS.Timeout | null = null;
  /** When the current actor's clock expires. Broadcast so clients can draw it. */
  private actionDeadline: number | null = null;
  private nextHandTimer: NodeJS.Timeout | null = null;
  /** Where the big blind sat last hand, so we can tell which away seats it has
   *  since passed (HOUSE-RULES #7). Null until the first hand is dealt. */
  private lastBigBlindSeat: number | null = null;

  constructor(
    config: TableConfig,
    private readonly persistHand: (record: HandRecord) => void,
  ) {
    this.config = config;
    // Commit to hand 1 before anyone has joined, let alone chosen a seed.
    this.nextServerSeed = generateServerSeed();
    this.nextCommit = commitOf(this.nextServerSeed);
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
        if (!tokensMatch(player.token, input.existingToken)) continue;
        player.connected = true;
        player.send = input.send;
        // Reconnecting restores your socket, not your seat in the game. A
        // player who dropped is sitting out until they press I'm back
        // (HOUSE-RULES #8) — otherwise a flaky connection would deal you into
        // hands you are not watching.
        // Names are FROZEN for the duration of a hand, and always go through
        // uniqueName. A rename on reconnect used to orphan the hand record's
        // seeds and make an honest hand fail verification.
        const seated = this.seatOf(player.playerId) !== -1;
        if (!(this.handInProgress() && seated) && input.name !== player.name) {
          player.name = this.uniqueName(input.name, player.playerId);
        }
        this.broadcast();
        return player;
      }
    }
    const player: Player = {
      playerId: randomBytes(8).toString('hex'),
      token: randomBytes(24).toString('hex'),
      name: this.uniqueName(input.name),
      avatar: input.avatar,
      clientSeed: input.clientSeed ?? randomBytes(8).toString('hex'),
      seedSetAgainstCommit: this.nextCommit,
      skin: { chipStyle: 'casino', chipColour: this.nextFreeChipColour() },
      isHost: input.isHost,
      connected: true,
      seatState: 'in',
      sitOutAfterHand: false,
      posting: false,
      missedBlind: false,
      send: input.send,
    };
    this.players.set(player.playerId, player);
    this.broadcast();
    return player;
  }

  /** First colour nobody at the table is already using, else the first. */
  private nextFreeChipColour(): ChipColour {
    const taken = new Set([...this.players.values()].map((p) => p.skin.chipColour));
    return CHIP_COLOUR_ROTATION.find((c) => !taken.has(c)) ?? (CHIP_COLOUR_ROTATION[0] as ChipColour);
  }

  private uniqueName(name: string, exceptPlayerId?: string): string {
    const taken = new Set(
      [...this.players.values()].filter((p) => p.playerId !== exceptPlayerId).map((p) => p.name),
    );
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
    //
    // Whether they are sat out now depends on whether they hold cards
    // (HOUSE-RULES #8, #9). With a live hand, nothing happens yet: their clock
    // runs its full length, which is their window to reconnect and play it out.
    // A live hand belongs to the player who was dealt it. With no live hand
    // there is nothing to protect, so they sit out at once and the table stops
    // dealing them in — which is the whole point, because a seat that is dealt
    // in and always times out costs everyone else 45 seconds a street.
    const seatIndex = this.seatOf(playerId);
    const holdsCards = this.handInProgress() && stillInHand(this.hand?.seats[seatIndex]?.status);
    if (seatIndex !== -1 && !holdsCards) this.setSittingOut(player);
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
      case 'sitOut':
        return this.sitOut(player);
      case 'sitIn':
        return this.sitIn(player, msg.post);
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
        // Pin the seed to the commitment that was public when it was chosen.
        player.seedSetAgainstCommit = this.nextCommit;
        this.broadcast();
        return null;
      case 'setSkin':
        // Cosmetic only. Zod has already rejected any id outside the catalogue,
        // and nothing here touches gameplay, information or timing.
        player.skin = msg.skin;
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
    // A seat vacated mid-hand still holds its cards in this.hand. Taking it
    // would serve the previous occupant's hole cards to whoever sits down.
    if (this.handInProgress() && (this.hand?.seats[seatIndex]?.holeCards.length ?? 0) > 0) {
      return err('seatInHand', 'That seat is still in this hand. Take it once the hand finishes.');
    }
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

  /** Sitting out keeps the seat and the chips (HOUSE-RULES #6). During a live
   *  hand it applies from the next one (#11) — you finish what you were dealt. */
  private sitOut(player: Player): ServerMessage | null {
    if (this.seatOf(player.playerId) === -1) return err('notSeated', 'You are not seated.');
    if (player.seatState === 'out') return err('alreadyOut', 'You are already sitting out.');
    const seatIndex = this.seatOf(player.playerId);
    if (this.handInProgress() && stillInHand(this.hand?.seats[seatIndex]?.status)) {
      player.sitOutAfterHand = true;
      this.broadcast();
      return null;
    }
    this.setSittingOut(player);
    this.broadcast();
    return null;
  }

  /** I'm back (#7). If the big blind has not passed you, you are simply dealt
   *  into the next hand. If it has, `post` decides: pay it now, or wait for it
   *  to reach you. Either way you pay it — you only choose when. */
  private sitIn(player: Player, post: boolean): ServerMessage | null {
    if (this.seatOf(player.playerId) === -1) return err('notSeated', 'You are not seated.');
    if (player.seatState === 'in') {
      // Pressing I'm back while a sit-out is pending cancels it — that is the
      // Cancel button, not a mistake worth an error.
      if (!player.sitOutAfterHand) return err('alreadyIn', 'You are already in the game.');
      player.sitOutAfterHand = false;
      this.broadcast();
      return null;
    }
    player.sitOutAfterHand = false;
    if (!player.missedBlind) {
      player.seatState = 'in';
      player.posting = false;
    } else if (post) {
      player.seatState = 'in';
      player.posting = true;
    } else {
      player.seatState = 'waiting';
      player.posting = false;
    }
    this.maybeScheduleNextHand();
    this.broadcast();
    return null;
  }

  /** One place that puts a player out, so every route into sitting-out — the
   *  button, a timeout, a dropped connection — leaves identical state. */
  private setSittingOut(player: Player): void {
    player.seatState = 'out';
    player.sitOutAfterHand = false;
    player.posting = false;
  }

  private standUp(player: Player): ServerMessage | null {
    const seatIndex = this.seatOf(player.playerId);
    if (seatIndex === -1) return err('notSeated', 'You are not seated.');
    // 'allIn' counts as still in the hand: those cards contest the pot, and
    // completeHand() only pays a seat still held by the same player, so leaving
    // while all-in silently forfeited the winnings.
    if (this.handInProgress() && stillInHand(this.hand?.seats[seatIndex]?.status)) {
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
      if (this.handInProgress() && stillInHand(this.hand?.seats[seatIndex]?.status)) {
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
    return this.participatingSeats().length;
  }

  /** The single source of truth for who is in the next hand: seated, holding
   *  chips, and resolvable to a known player. Deciding "who is dealt in" and
   *  "whose seed enters the shuffle" from two separate loops let them drift. */
  private participatingSeats(): { seat: number; player: Player }[] {
    const out: { seat: number; player: Player }[] = [];
    for (let i = 0; i < MAX_SEATS; i++) {
      const playerId = this.seats[i] ?? null;
      if (playerId === null || (this.stacks[i] ?? 0) <= 0) continue;
      const player = this.players.get(playerId);
      // Sitting out and waiting-for-the-big-blind are both dealt out (#6, #7).
      if (player && player.seatState === 'in') out.push({ seat: i, player });
    }
    return out;
  }

  // -------------------------------------------------------------- hand lifecycle

  private startNextHand(): ServerMessage | null {
    // A player waiting for the big blind when the table cannot otherwise deal
    // is admitted now — waiting for a rotation that is not turning is just a
    // stalled table, and there is nothing to dodge when there is no game.
    this.admitStalledWaiters();
    if (this.participatingSeats().length < 2) {
      return err('needPlayers', 'Need at least two seated players with chips.');
    }
    this.clearTimers();
    this.handNumber += 1;
    this.shownCards.clear();
    this.showdownSeats.clear();
    this.pendingShows.clear();
    this.handActions = [];
    this.revealedSeed = null;

    // Advance the button to the next seat that is actually dealt in.
    this.button = this.nextEligibleSeat(this.handNumber === 1 ? MAX_SEATS - 1 : this.button);
    // With the button fixed, a player waiting for the big blind joins if it has
    // now reached their seat (HOUSE-RULES #7). They post it as the big blind
    // like anyone else — which is the whole point: you cannot skip your blind
    // by sitting out, only choose when you pay it.
    this.admitWaiterDueTheBigBlind();
    const participants = this.participatingSeats();
    if (participants.length < 2) {
      return err('needPlayers', 'Need at least two seated players with chips.');
    }

    // --- Fairness ------------------------------------------------------------
    // Consume the commitment minted a hand ago, then immediately mint the one
    // for the next hand. The server therefore commits BEFORE it can know the
    // seeds that commitment will be mixed with. Generating the seed here, after
    // reading player.clientSeed, would let a modified server grind decks and
    // still pass every published check — see docs/FAIRNESS.md.
    this.serverSeed = this.nextServerSeed;
    this.commit = this.nextCommit;

    this.handSeeds = participants.map(({ seat, player }) => ({
      seat,
      name: player.name,
      seed: player.clientSeed,
      postCommit: player.seedSetAgainstCommit === this.commit,
    }));

    this.nextServerSeed = generateServerSeed();
    this.nextCommit = commitOf(this.nextServerSeed);

    this.sendToAll({
      type: 'handCommit',
      handNumber: this.handNumber,
      commit: this.commit,
      clientSeeds: this.handSeeds,
      nextHandNumber: this.handNumber + 1,
      nextCommit: this.nextCommit,
    });

    const deck = deriveDeck(
      this.serverSeed,
      this.handSeeds.map((s) => s.seed),
      this.handNumber,
    );

    const dealtIn = new Set(participants.map((p) => p.seat));
    const seats: Seat[] = [];
    for (let i = 0; i < MAX_SEATS; i++) {
      const playerId = this.seats[i] ?? null;
      const stack = this.stacks[i] ?? 0;
      seats.push({
        index: i,
        playerId,
        // Sitting out is NOT busted: they have chips and a seat, they are just
        // not in this hand. The engine reads 'sittingOut' and deals them out
        // while leaving their stack alone.
        status:
          playerId === null
            ? 'empty'
            : dealtIn.has(i)
              ? 'active'
              : (this.stacks[i] ?? 0) > 0
                ? 'sittingOut'
                : 'busted',
        stack: chips(Math.max(0, stack)),
        holeCards: [],
        committedThisStreet: chips(0),
        committedThisHand: chips(0),
        hasActedThisStreet: false,
        isAllIn: false,
      });
    }

    // Players who chose to buy straight back in rather than wait (#7). A seat
    // that is paying a blind this hand must not also post — the engine treats
    // that as a bug and throws — so the blinds are worked out first and those
    // seats are skipped. Either way `posting` is consumed here.
    const dealtSeats = participants.map((p) => p.seat);
    const bigBlindSeat = bigBlindSeatFor(dealtSeats, this.button);
    const posts: { seat: number; amount: Chips }[] = [];
    for (const { seat, player } of participants) {
      if (!player.posting) continue;
      player.posting = false;
      player.missedBlind = false;
      // Coming back costs one full orbit, never less (HOUSE-RULES #7). Landing
      // on the big blind IS that payment, so no post. Landing on the small
      // blind is not — without the post on top, sitting out would be the
      // cheapest seat at the table, which is exactly backwards.
      if (seat === bigBlindSeat) continue;
      posts.push({ seat, amount: chips(this.config.bigBlind) });
      this.logChips(player.name, -this.config.bigBlind, 'posted the big blind to come back in');
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
      posts,
    });
    this.hand = state;
    this.noteBlindPassedSittingOutSeats(events);
    this.afterEngineStep(events);
    return null;
  }

  /** After a deal, mark every away seat the big blind has now passed. That is
   *  what turns "just sit back down" into "post it or wait for it" (#7). The
   *  blind seats come off the engine's own handStarted event rather than being
   *  recomputed, so this cannot disagree with the hand that was actually dealt. */
  private noteBlindPassedSittingOutSeats(events: readonly Event[]): void {
    const started = events.find((e) => e.t === 'handStarted');
    if (!started || started.t !== 'handStarted') return;
    const from = this.lastBigBlindSeat;
    const to = started.bigBlindSeat;
    this.lastBigBlindSeat = to;
    if (from === null) return;
    for (let seat = 0; seat < MAX_SEATS; seat++) {
      const player = this.playerAtSeat(seat);
      if (!player || player.seatState === 'in') continue;
      if (blindPassed(from, to, seat)) player.missedBlind = true;
    }
  }

  /** Waiting players join when the big blind reaches them (#7). */
  private admitWaiterDueTheBigBlind(): void {
    const inHand: number[] = [];
    const waiting: number[] = [];
    for (let seat = 0; seat < MAX_SEATS; seat++) {
      const player = this.playerAtSeat(seat);
      if (!player || (this.stacks[seat] ?? 0) <= 0) continue;
      if (player.seatState === 'in') inHand.push(seat);
      else if (player.seatState === 'waiting') waiting.push(seat);
    }
    if (waiting.length === 0 || inHand.length < 2) return;
    const due = bigBlindSeatFor([...inHand, ...waiting].sort((a, b) => a - b), this.button);
    if (due === null) return;
    const player = this.playerAtSeat(due);
    if (player?.seatState === 'waiting') {
      player.seatState = 'in';
      player.missedBlind = false;
    }
  }

  /** See the call site: waiting out a rotation that is not turning is just a
   *  stalled table, and there is no blind to dodge when there is no hand. */
  private admitStalledWaiters(): void {
    const canDeal = () => this.participatingSeats().length >= 2;
    if (canDeal()) return;
    for (let seat = 0; seat < MAX_SEATS; seat++) {
      const player = this.playerAtSeat(seat);
      if (!player || player.seatState !== 'waiting' || (this.stacks[seat] ?? 0) <= 0) continue;
      player.seatState = 'in';
      player.missedBlind = false;
      if (canDeal()) return;
    }
  }

  private playerAtSeat(seat: number): Player | undefined {
    const playerId = this.seats[seat];
    return playerId === null || playerId === undefined ? undefined : this.players.get(playerId);
  }

  /** The next seat that is actually dealt in. Sitting-out seats are skipped
   *  (HOUSE-RULES #6) — and must be, because startHand throws if the button
   *  lands on a seat that is not in the hand. */
  private nextEligibleSeat(from: number): number {
    for (let step = 1; step <= MAX_SEATS; step++) {
      const i = (from + step) % MAX_SEATS;
      if ((this.stacks[i] ?? 0) <= 0) continue;
      if (this.playerAtSeat(i)?.seatState === 'in') return i;
    }
    return from;
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
    const nameAtSeat = new Map(this.handSeeds.map((s) => [s.seat, s.name]));
    const record: HandRecord = {
      handId: `${this.sessionId}-${this.handNumber}`,
      handNumber: this.handNumber,
      at: new Date().toISOString(),
      tableName: this.config.tableName,
      commit: this.commit,
      serverSeed: this.serverSeed,
      clientSeeds: this.handSeeds.map((s) => ({ ...s })),
      button: hand.button,
      // Only the three blind fields. This used to spread the whole TableConfig
      // into a field typed as three keys — excess properties from a spread are
      // not checked, so every record on disk carries buy-in limits too.
      blinds: {
        smallBlind: this.config.smallBlind,
        bigBlind: this.config.bigBlind,
        ante: this.config.ante,
      },
      seats: hand.seats
        .filter((s) => s.holeCards.length > 0)
        .map((s) => ({
          seat: s.index,
          // Frozen at hand start: a rename mid-hand cannot orphan the record.
          name: nameAtSeat.get(s.index) ?? this.players.get(s.playerId ?? '')?.name ?? 'unknown',
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
    // Sit-out requested during the hand now takes effect (HOUSE-RULES #11),
    // as does a disconnection that was protected while cards were live (#9).
    for (const player of this.players.values()) {
      const stillAway = player.sitOutAfterHand || (!player.connected && player.seatState === 'in');
      if (stillAway && this.seatOf(player.playerId) !== -1) this.setSittingOut(player);
    }
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
    this.actionDeadline = Date.now() + ACTION_CLOCK_MS;
    const actingSeat = hand.actingSeat;
    const handNumber = this.handNumber;
    // A player already sitting out still holds cards from the hand they were in
    // when it happened. Those decisions resolve AT ONCE rather than on a clock
    // (HOUSE-RULES #10) — the table waits for an absence once, never twice.
    const actor = this.playerAtSeat(actingSeat);
    if (actor && actor.seatState !== 'in') {
      this.actionDeadline = null;
      queueMicrotask(() => {
        if (this.hand === hand && this.hand?.actingSeat === actingSeat) {
          this.resolveAbsentAction(actingSeat, handNumber);
        }
      });
      return;
    }
    this.actionTimer = setTimeout(() => {
      // Letting the clock run out sits you out (HOUSE-RULES #8), whether you
      // are away from the keyboard or disconnected mid-hand.
      const timedOut = this.playerAtSeat(actingSeat);
      if (timedOut) this.setSittingOut(timedOut);
      this.resolveAbsentAction(actingSeat, handNumber);
    }, ACTION_CLOCK_MS);
  }

  /** Act for a seat that is not going to act for itself: check when it is free,
   *  fold when facing a bet. The one policy, used by both the expired clock and
   *  a seat that is already sitting out. */
  private resolveAbsentAction(actingSeat: number, handNumber: number): void {
    const current = this.hand;
    if (!current || this.handNumber !== handNumber || current.actingSeat !== actingSeat) return;
    const check = applyAction(current, { seat: actingSeat, action: { kind: 'check' } });
    const result = check.ok
      ? check
      : applyAction(current, { seat: actingSeat, action: { kind: 'fold' } });
    if (!result.ok) return;
    this.handActions.push({
      seat: actingSeat,
      action: check.ok ? 'check (away)' : 'fold (away)',
    });
    this.hand = result.state;
    this.afterEngineStep(result.events);
  }

  private clearActionTimer(): void {
    if (this.actionTimer) clearTimeout(this.actionTimer);
    this.actionTimer = null;
    this.actionDeadline = null;
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
        skin: player.skin,
        connected: player.connected,
        away:
          player.seatState === 'in'
            ? 'no'
            : player.seatState === 'waiting'
              ? 'waitingForBigBlind'
              : 'sittingOut',
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
      actionDeadline: this.actionDeadline,
      actionClockMs: ACTION_CLOCK_MS,
      blinds: {
        smallBlind: this.config.smallBlind,
        bigBlind: this.config.bigBlind,
        ante: this.config.ante,
      },
      youFor: (viewerPlayerId: string | null) => {
        if (viewerPlayerId === null) return null;
        const player = this.players.get(viewerPlayerId);
        if (!player || this.seatOf(viewerPlayerId) === -1) return null;
        return {
          away:
            player.seatState === 'in'
              ? ('no' as const)
              : player.seatState === 'waiting'
                ? ('waitingForBigBlind' as const)
                : ('sittingOut' as const),
          sitOutAfterHand: player.sitOutAfterHand,
          missedBlind: player.missedBlind,
        };
      },
      fairness: {
        handNumber: this.handNumber,
        commit: this.commit,
        clientSeeds: this.handSeeds,
        revealedServerSeed: this.revealedSeed,
        nextHandNumber: this.handNumber + 1,
        nextCommit: this.nextCommit,
      },
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

/** Seats whose cards are still live. Folded seats may leave; all-in ones may not. */
function stillInHand(status: string | undefined): boolean {
  return status === 'active' || status === 'allIn';
}

/** Constant-time comparison for the reconnect token. */
function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
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
