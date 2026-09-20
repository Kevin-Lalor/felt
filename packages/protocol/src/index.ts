import { z } from 'zod';

// The contract between client and server. Every inbound WebSocket message is
// parsed with ClientMessage before it touches anything (CLAUDE.md hard rule 6).
// Cards travel as two-character strings ('As', 'Td'); other players' hole cards
// are ABSENT from payloads, not hidden (hard rule 2).

export const cardSchema = z.string().regex(/^[2-9TJQKA][shdc]$/, 'invalid card');
export type WireCard = z.infer<typeof cardSchema>;

/** Chips on the wire. The upper bound is load-bearing: `.int()` alone accepts
 *  1e21, which reaches `chips()` in the engine and THROWS before applyAction
 *  gets the chance to refuse it politely. */
export const chipsSchema = z.number().int().nonnegative().max(1_000_000_000);

export const playerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .regex(/^[\p{L}\p{N} _\-'.]+$/u, 'name contains unsupported characters');

export const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fold') }),
  z.object({ kind: z.literal('check') }),
  z.object({ kind: z.literal('call') }),
  z.object({ kind: z.literal('bet'), to: chipsSchema }),
  z.object({ kind: z.literal('raise'), to: chipsSchema }),
  z.object({ kind: z.literal('allIn') }),
]);
export type WireAction = z.infer<typeof actionSchema>;

/** One player's contribution to a shuffle, pinned to the seat it was used in.
 *  Recorded POSITIONALLY — never keyed by name, which players can change
 *  mid-session and which made hand records unverifiable. */
export const clientSeedEntrySchema = z.object({
  seat: z.number().int().min(0).max(8),
  name: z.string(),
  seed: z.string(),
  /** True when this seed was set AFTER the commitment it is mixed into was
   *  published. That ordering is what makes commit-reveal binding. */
  postCommit: z.boolean(),
});
export type ClientSeedEntry = z.infer<typeof clientSeedEntrySchema>;

/** PLAYER SKIN — cosmetic, chosen by each player, visible to EVERYONE at the
 *  table (docs/DESIGN-SYSTEM.md). That visibility is the point: a cosmetic
 *  nobody else sees is not worth choosing. It therefore travels in the
 *  protocol, unlike a local preference, which must stay on the client.
 *
 *  Nothing here may affect gameplay, information or timing. The ids are an
 *  enum so an unknown one is rejected at the Zod boundary rather than reaching
 *  the table — packages/tokens/cosmetics.json is the catalogue these mirror. */
export const chipStyleSchema = z.enum(['casino', 'ceramic', 'vintage', 'neon', 'minimal']);
export type ChipStyle = z.infer<typeof chipStyleSchema>;

export const chipColourSchema = z.enum([
  'red',
  'blue',
  'green',
  'black',
  'purple',
  'yellow',
  'orange',
  'pink',
  'white',
]);
export type ChipColour = z.infer<typeof chipColourSchema>;

export const playerSkinSchema = z.object({
  chipStyle: chipStyleSchema,
  chipColour: chipColourSchema,
});
export type PlayerSkin = z.infer<typeof playerSkinSchema>;

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export const clientMessageSchema = z.discriminatedUnion('type', [
  /** First message on every socket. Rejoining players present their token. */
  z.object({
    type: z.literal('join'),
    inviteCode: z.string().min(1).max(64),
    name: playerNameSchema,
    avatar: z.number().int().min(0).max(7).optional(),
    playerToken: z.string().max(128).optional(),
    /** Player's contribution to the shuffle — see docs/FAIRNESS.md. */
    clientSeed: z.string().min(1).max(64).optional(),
  }),
  z.object({ type: z.literal('sit'), seat: z.number().int().min(0).max(8), buyIn: chipsSchema }),
  z.object({ type: z.literal('standUp') }),
  // Sitting out keeps your seat and stack (HOUSE-RULES #6). Leaving does not.
  z.object({ type: z.literal('sitOut') }),
  // `post: true` buys straight back in with a dead big blind rather than
  // waiting for the big blind to reach you (HOUSE-RULES #7).
  z.object({ type: z.literal('sitIn'), post: z.boolean() }),
  z.object({ type: z.literal('leave') }),
  /** Rebuy/top-up between hands. Publicly logged for the whole table. */
  z.object({ type: z.literal('topUp'), amount: chipsSchema }),
  z.object({ type: z.literal('startHand') }),
  z.object({ type: z.literal('action'), handNumber: z.number().int().positive(), action: actionSchema }),
  z.object({ type: z.literal('chat'), text: z.string().trim().min(1).max(300) }),
  z.object({ type: z.literal('emote'), emote: z.string().min(1).max(16) }),
  z.object({ type: z.literal('setClientSeed'), seed: z.string().min(1).max(64) }),
  /** Change your own cosmetics. Everyone at the table sees the result. */
  z.object({ type: z.literal('setSkin'), skin: playerSkinSchema }),
  /** Post-hand 6-second window: show both, one, or muck (wireframe: show one card). */
  z.object({ type: z.literal('show'), cards: z.enum(['both', 'first', 'second']) }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------------------
// Server → Client (documented as schemas so the shapes are testable and the
// leak fuzzer can walk them; the server constructs these, clients parse them)
// ---------------------------------------------------------------------------

export const seatViewSchema = z.object({
  index: z.number().int(),
  playerId: z.string().nullable(),
  name: z.string().nullable(),
  avatar: z.number().int().nullable(),
  status: z.enum(['empty', 'active', 'folded', 'allIn', 'sittingOut', 'busted']),
  /** At the table but not in this hand, and why — so the felt can say
   *  "sitting out" rather than leaving a seat looking broken. */
  away: z.enum(['no', 'sittingOut', 'waitingForBigBlind']),
  stack: chipsSchema,
  committedThisStreet: chipsSchema,
  isAllIn: z.boolean(),
  /** True when this seat holds live cards. The cards themselves appear ONLY in
   *  `holeCards` on the recipient's own seat, or in `shownCards` post-hand. */
  hasCards: z.boolean(),
  /** Present only on the recipient's own seat before showdown. */
  holeCards: z.array(cardSchema).optional(),
  /** Cards this seat chose to show (or showed at showdown). Public. */
  shownCards: z.array(cardSchema).optional(),
  /** This player's chosen cosmetics. Public by design — see playerSkinSchema. */
  skin: playerSkinSchema,
  connected: z.boolean(),
});
export type SeatView = z.infer<typeof seatViewSchema>;

export const potViewSchema = z.object({
  amount: chipsSchema,
  eligibleSeats: z.array(z.number().int()),
});

export const legalActionsViewSchema = z.object({
  canFold: z.boolean(),
  canCheck: z.boolean(),
  canCall: z.boolean(),
  callAmount: chipsSchema,
  canBet: z.boolean(),
  minBet: chipsSchema,
  maxBet: chipsSchema,
  canRaise: z.boolean(),
  minRaise: chipsSchema,
  maxRaise: chipsSchema,
  canAllIn: z.boolean(),
  allInAmount: chipsSchema,
});

export const tableViewSchema = z.object({
  tableName: z.string(),
  handNumber: z.number().int(),
  street: z.enum(['idle', 'preflop', 'flop', 'turn', 'river', 'showdown', 'complete']),
  button: z.number().int(),
  actingSeat: z.number().int().nullable(),
  board: z.array(cardSchema),
  pots: z.array(potViewSchema),
  potTotal: chipsSchema,
  currentBet: chipsSchema,
  blinds: z.object({ smallBlind: chipsSchema, bigBlind: chipsSchema, ante: chipsSchema }),
  seats: z.array(seatViewSchema),
  /** The recipient's seat index at this table, or null when spectating. */
  yourSeat: z.number().int().nullable(),
  /** Your own sit-out situation. Null when you are not seated. Separate from
   *  the seat view because only you need it — it drives which button you see,
   *  not what the table looks like. */
  you: z
    .object({
      away: z.enum(['no', 'sittingOut', 'waitingForBigBlind']),
      /** You pressed Sit out during a live hand; it applies next hand (#11). */
      sitOutAfterHand: z.boolean(),
      /** The big blind passed your seat while you were out, so coming back
       *  means choosing: post it now, or wait for it to reach you (#7). */
      missedBlind: z.boolean(),
    })
    .nullable(),
  /** Wall-clock ms (Date.now()) when the acting player's clock expires, or null
   *  when nobody is on the clock. The server has always run this clock; it just
   *  had no field to travel in, so no client could draw a countdown. */
  actionDeadline: z.number().int().nullable(),
  /** Full length of the action clock, so the client can draw a fraction. */
  actionClockMs: z.number().int(),
  /** What the recipient may legally do right now. Never compute this client-side. */
  legal: legalActionsViewSchema.nullable(),
  /** Fairness. `commit` governs `handNumber`; `nextCommit` is ALREADY published
   *  for the next hand, so any seed set from now on is provably chosen after the
   *  commitment it will be mixed into. See docs/FAIRNESS.md. */
  fairness: z
    .object({
      handNumber: z.number().int(),
      commit: z.string().nullable(),
      clientSeeds: z.array(clientSeedEntrySchema),
      revealedServerSeed: z.string().nullable(),
      nextHandNumber: z.number().int(),
      nextCommit: z.string(),
    })
    .nullable(),
  hostId: z.string().nullable(),
});
export type TableView = z.infer<typeof tableViewSchema>;

export const handEventSchema = z.object({
  t: z.string(),
  seat: z.number().int().optional(),
  street: z.string().optional(),
  cards: z.array(cardSchema).optional(),
  amount: chipsSchema.optional(),
  pot: z.number().int().optional(),
  blind: z.string().optional(),
  label: z.string().optional(),
  action: actionSchema.optional(),
  handNumber: z.number().int().optional(),
  button: z.number().int().optional(),
});
export type HandEvent = z.infer<typeof handEventSchema>;

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    playerId: z.string(),
    playerToken: z.string(),
    tableName: z.string(),
    isHost: z.boolean(),
  }),
  z.object({ type: z.literal('state'), view: tableViewSchema }),
  z.object({
    type: z.literal('events'),
    handNumber: z.number().int(),
    events: z.array(handEventSchema),
  }),
  z.object({
    type: z.literal('handCommit'),
    handNumber: z.number().int(),
    commit: z.string(),
    clientSeeds: z.array(clientSeedEntrySchema),
    /** Commitment for the NEXT hand, published as this one starts. */
    nextHandNumber: z.number().int(),
    nextCommit: z.string(),
  }),
  z.object({
    type: z.literal('handReveal'),
    handNumber: z.number().int(),
    serverSeed: z.string(),
    commit: z.string(),
  }),
  z.object({
    type: z.literal('chat'),
    from: z.string(),
    seat: z.number().int().nullable(),
    text: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('emote'),
    from: z.string(),
    seat: z.number().int().nullable(),
    emote: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('chipLog'),
    entries: z.array(
      z.object({
        at: z.number(),
        playerName: z.string(),
        delta: z.number().int(),
        reason: z.string(),
      }),
    ),
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
