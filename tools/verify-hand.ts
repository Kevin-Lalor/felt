#!/usr/bin/env tsx
// Standalone provably-fair verifier. Run it OUTSIDE the app:
//
//   pnpm verify-hand <handNumber>            (reads apps/server/data/history.jsonl)
//   pnpm verify-hand <handNumber> <file>     (any history JSONL you exported)
//
// This file deliberately re-implements the derivation instead of importing the
// server's code — an independent implementation agreeing with the server is the
// point. Only node:crypto is used. See docs/FAIRNESS.md; CLAUDE.md requires any
// protocol change to update this file in the same PR.

import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

type HandRecord = {
  handNumber: number;
  commit: string;
  serverSeed: string;
  clientSeeds: Record<string, string>;
  button: number;
  seats: { seat: number; name: string; holeCards: string[] }[];
  board: string[];
};

const MAX_SEATS = 9;
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['s', 'h', 'd', 'c'];

function orderedDeck(): string[] {
  const deck: string[] = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(rank + suit);
  return deck;
}

/** HMAC-SHA256 counter-mode byte stream + unbiased rejection sampling. */
function makeStream(serverSeed: string, message: string) {
  let block = Buffer.alloc(0);
  let offset = 0;
  let counter = 0;
  const nextUint32 = (): number => {
    if (offset + 4 > block.length) {
      block = createHmac('sha256', serverSeed).update(`${message}:${counter++}`, 'utf8').digest();
      offset = 0;
    }
    const v = block.readUInt32BE(offset);
    offset += 4;
    return v;
  };
  return (n: number): number => {
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    for (;;) {
      const v = nextUint32();
      if (v < limit) return v % n;
    }
  };
}

function deriveDeck(serverSeed: string, clientSeeds: string[], handNumber: number): string[] {
  const nextInt = makeStream(serverSeed, `${clientSeeds.join('|')}+${handNumber}`);
  const deck = orderedDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = nextInt(i + 1);
    const tmp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = tmp;
  }
  return deck;
}

// ---------------------------------------------------------------------------

const [, , handArg, fileArg] = process.argv;
if (!handArg) {
  console.error('usage: pnpm verify-hand <handNumber> [historyFile]');
  process.exit(2);
}
const here = fileURLToPath(new URL('.', import.meta.url));
const file = fileArg ?? join(dirname(here), 'apps', 'server', 'data', 'history.jsonl');

const records = readFileSync(file, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as HandRecord);
const record = records.find((r) => r.handNumber === Number(handArg));
if (!record) {
  console.error(`hand #${handArg} not found in ${file}`);
  process.exit(2);
}

let failed = false;
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? '✓' : '✗ FAILED'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
};

console.log(`\nVerifying hand #${record.handNumber}\n`);

// 1. The server committed to its seed BEFORE dealing, and revealed it after.
const recomputedCommit = createHash('sha256').update(record.serverSeed, 'utf8').digest('hex');
check(
  'commit matches SHA256(revealed server seed) — the server never changed its mind',
  recomputedCommit === record.commit,
);

// 2. Re-derive the deck from the revealed seed + every player's seed.
const seedsInSeatOrder = record.seats.map((s) => {
  const seed = record.clientSeeds[s.name];
  if (seed === undefined) throw new Error(`no client seed recorded for ${s.name}`);
  return seed;
});
const deck = deriveDeck(record.serverSeed, seedsInSeatOrder, record.handNumber);

// 3. Replay the deal: two cards each, one at a time, clockwise from the button.
const participating = new Set(record.seats.map((s) => s.seat));
const ringOrder: number[] = [];
for (let step = 1; step <= MAX_SEATS; step++) {
  const i = (record.button + step) % MAX_SEATS;
  if (participating.has(i)) ringOrder.push(i);
}
let pointer = 0;
const dealt = new Map<number, string[]>();
for (let round = 0; round < 2; round++) {
  for (const seat of ringOrder) {
    const cards = dealt.get(seat) ?? [];
    cards.push(deck[pointer++]!);
    dealt.set(seat, cards);
  }
}
const board = deck.slice(pointer, pointer + record.board.length);

for (const seat of record.seats) {
  const derived = dealt.get(seat.seat)?.join(' ') ?? '(none)';
  check(
    `${seat.name} (seat ${seat.seat}) was dealt ${seat.holeCards.join(' ')}`,
    derived === seat.holeCards.join(' '),
    derived === seat.holeCards.join(' ') ? '' : `derivation says ${derived}`,
  );
}
check(
  `board ${record.board.join(' ') || '(no board)'}`,
  board.join(' ') === record.board.join(' '),
  board.join(' ') === record.board.join(' ') ? '' : `derivation says ${board.join(' ')}`,
);

console.log(
  failed
    ? '\n✗ VERIFICATION FAILED — this hand does not match its commitment. Ask your host hard questions.\n'
    : '\n✓ Hand verified. The deck was fixed before any card was dealt, and every player’s\n  seed went into the shuffle — the host could not have precomputed this deck.\n',
);
process.exit(failed ? 1 : 0);
