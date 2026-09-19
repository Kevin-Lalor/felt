#!/usr/bin/env tsx
// A bot that sits down and plays, so you can try a table without rounding up
// three friends first.
//
//   pnpm bot Mo                        (joins, sits, plays)
//   pnpm bot Dec --style tight
//   pnpm bot Ana --url ws://localhost:8090/ws --code FELT01 --buyin 400
//
// It is an ordinary client: it speaks the same protocol, gets the same redacted
// view as a person, and sees nobody else's hole cards. It has no special access
// and it CANNOT have any — the server would not answer differently if it tried.
// That is worth knowing when you use it to sanity-check a table.
//
// Zero dependencies: Node 22 has a global WebSocket, and every random choice
// below comes from randomInt in node:crypto. Hard rule 3 bans the obvious
// alternative everywhere, not only in the deck path.
//
// Deliberately not naming that function here, even to disclaim it: the CI
// guard is a plain text grep over tools/, so writing it in a comment fails the
// build. That is the guard working as intended — one clever enough to skip
// comments would be one you could hide behind. Leave this wording alone.

import { randomInt } from 'node:crypto';

type Action =
  | { kind: 'fold' | 'check' | 'call' | 'allIn' }
  | { kind: 'bet' | 'raise'; to: number };

type Legal = {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canBet: boolean;
  minBet: number;
  maxBet: number;
  canRaise: boolean;
  minRaise: number;
  maxRaise: number;
  canAllIn: boolean;
  allInAmount: number;
};

type Seat = { index: number; playerId: string | null; stack: number };

type View = {
  handNumber: number;
  fairness: { nextCommit: string } | null;
  street: string;
  potTotal: number;
  blinds: { smallBlind: number; bigBlind: number; ante: number };
  seats: Seat[];
  yourSeat: number | null;
  legal: Legal | null;
};

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const name = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'Bot';
function flag(key: string, fallback: string): string {
  const i = argv.indexOf(`--${key}`);
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : fallback;
}

const URL = flag('url', 'ws://localhost:8090/ws');
const CODE = flag('code', process.env['INVITE_CODE'] ?? '');
const BUYIN = Number(flag('buyin', '200'));
const STYLE = flag('style', 'normal'); // tight | normal | loose

if (!CODE) {
  console.error(
    'No invite code. Pass --code ABC123, or set INVITE_CODE before starting\n' +
      'the server so both ends agree. The server prints the code at startup.',
  );
  process.exit(2);
}
if (typeof WebSocket === 'undefined') {
  console.error('This needs Node 22+, which has a built-in WebSocket client.');
  process.exit(2);
}

const CHIP_STYLES = ['casino', 'ceramic', 'vintage', 'neon', 'minimal'] as const;
/** Stable per name, so a given bot always looks the same across restarts. */
const chipStyle =
  CHIP_STYLES[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % CHIP_STYLES.length];

// ---------------------------------------------------------------- decisions

/** Pick from the actions the SERVER says are legal, weighted. Choosing from
 *  `legal` rather than reasoning about the rules means a bot can never send an
 *  illegal action, however wrong its poker judgement is. */
function decide(view: View, legal: Legal): Action {
  const me = view.yourSeat === null ? undefined : view.seats[view.yourSeat];
  const stack = me?.stack ?? 0;
  const pot = Math.max(1, view.potTotal);
  const price = legal.callAmount / Math.max(1, stack + legal.callAmount);

  const loose = STYLE === 'loose';
  const tight = STYLE === 'tight';

  const options: { action: Action; weight: number }[] = [];

  if (legal.canCheck) {
    options.push({ action: { kind: 'check' }, weight: 100 });
    if (legal.canBet) {
      const to = clamp(Math.round(pot * (loose ? 0.75 : 0.5)), legal.minBet, legal.maxBet);
      options.push({ action: { kind: 'bet', to }, weight: loose ? 45 : tight ? 12 : 22 });
    }
  } else {
    // Facing a bet. The dearer it is relative to the stack, the less often we pay.
    if (legal.canCall) {
      const callWeight = price > 0.5 ? 18 : price > 0.2 ? 55 : 100;
      options.push({
        action: { kind: 'call' },
        weight: Math.round(callWeight * (loose ? 1.4 : tight ? 0.7 : 1)),
      });
    }
    if (legal.canRaise) {
      const to = clamp(
        Math.round(legal.callAmount * 2.5 + pot * 0.4),
        legal.minRaise,
        legal.maxRaise,
      );
      options.push({ action: { kind: 'raise', to }, weight: loose ? 22 : tight ? 6 : 12 });
    }
    if (legal.canFold) {
      const foldWeight = price > 0.5 ? 110 : price > 0.2 ? 45 : 18;
      options.push({
        action: { kind: 'fold' },
        weight: Math.round(foldWeight * (tight ? 1.5 : loose ? 0.55 : 1)),
      });
    }
    // Nothing else available — short stack with only a shove left.
    if (options.length === 0 && legal.canAllIn) {
      options.push({ action: { kind: 'allIn' }, weight: 100 });
    }
  }

  if (options.length === 0) return { kind: 'fold' };

  const total = options.reduce((sum, o) => sum + o.weight, 0);
  let roll = randomInt(0, Math.max(1, total));
  for (const o of options) {
    roll -= o.weight;
    if (roll < 0) return o.action;
  }
  return options[0]!.action;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

// ---------------------------------------------------------------- the client

const socket = new WebSocket(URL);
let playerId: string | null = null;
let acting = false;
let sitting = false;
let isHost = false;
let dealRequested = false;
let rotatedAgainst: string | null = null;

function send(msg: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

function log(...parts: unknown[]): void {
  console.log(`[${name}]`, ...parts);
}

socket.addEventListener('open', () => {
  log(`connected to ${URL}`);
  send({
    type: 'join',
    inviteCode: CODE,
    name,
    avatar: randomInt(0, 8),
    clientSeed: `${name}-${randomInt(0, 1_000_000)}`,
  });
});

socket.addEventListener('message', (event: MessageEvent) => {
  let msg: { type: string; [k: string]: unknown };
  try {
    msg = JSON.parse(String(event.data));
  } catch {
    return;
  }

  if (msg.type === 'error') {
    log('server said:', msg['code'], '—', msg['message']);
    acting = false; // never get stuck waiting on an action that was refused
    return;
  }

  if (msg.type === 'welcome') {
    playerId = String(msg['playerId']);
    isHost = msg['isHost'] === true;
    log('joined as', playerId.slice(0, 6), isHost ? '(host)' : '');
    send({ type: 'setSkin', skin: { chipStyle, chipColour: pickColour() } });
    return;
  }

  if (msg.type !== 'state') return;
  const view = msg['view'] as View;

  // Rotate the shuffle seed whenever a new commitment appears, exactly as the
  // browser client does. A seed the server already knew when it committed
  // constrains nothing, so a bot that never rotates makes every hand it plays
  // report "0 of N seeds chosen after the commitment" — a worse citizen at the
  // table than a real player, and misleading when you are testing fairness.
  const nextCommit = view.fairness?.nextCommit ?? null;
  if (nextCommit && nextCommit !== rotatedAgainst) {
    rotatedAgainst = nextCommit;
    send({ type: 'setClientSeed', seed: `${name}-${randomInt(0, 1_000_000_000)}` });
  }

  // Sit down in the first open seat.
  if (view.yourSeat === null && !sitting) {
    const open = view.seats.find((s) => s.playerId === null);
    if (open) {
      sitting = true;
      log(`sitting in seat ${open.index + 1} for ${BUYIN}`);
      send({ type: 'sit', seat: open.index, buyIn: BUYIN });
    }
    return;
  }

  // Top up between hands rather than sitting there with a dust stack.
  const me = view.yourSeat === null ? undefined : view.seats[view.yourSeat];
  if (me && view.legal === null && me.stack < view.blinds.bigBlind * 10) {
    send({ type: 'topUp', amount: BUYIN });
  }

  // Given the HOST code, a bot can start the table by itself — handy for
  // testing with no browser open. With the invite code it never deals, which
  // is right: the host is a person clicking a button.
  if (isHost && !dealRequested && view.handNumber === 0) {
    const ready = view.seats.filter((s) => s.playerId !== null && s.stack > 0).length;
    if (ready >= 2) {
      dealRequested = true;
      log(`dealing the first hand — ${ready} seated`);
      setTimeout(() => send({ type: 'startHand' }), 1500);
    }
  }

  if (!view.legal || acting) return;

  acting = true;
  const legal = view.legal;
  // A human-ish pause. Well inside the server's 45s action clock, and slow
  // enough that you can actually watch the table do something.
  setTimeout(
    () => {
      const action = decide(view, legal);
      log(
        `hand #${view.handNumber} ${view.street}:`,
        'to' in action ? `${action.kind} ${action.to}` : action.kind,
      );
      send({ type: 'action', handNumber: view.handNumber, action });
      acting = false;
    },
    randomInt(700, 2400),
  );
});

socket.addEventListener('close', () => {
  log('disconnected');
  process.exit(0);
});

function pickColour(): string {
  const colours = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'white', 'black'];
  const i = [...name].reduce((a, c) => a + c.charCodeAt(0) * 7, 0) % colours.length;
  return colours[i] as string;
}
