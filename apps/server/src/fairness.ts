// Commit-reveal provably-fair shuffle. See CLAUDE.md "Fairness protocol" and
// docs/FAIRNESS.md. NEVER change this derivation without updating
// tools/verify-hand.ts and the /verify page in the same PR.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Card, Deck } from '@poker/engine';
import { orderedDeck } from '@poker/engine';

export function generateServerSeed(): string {
  return randomBytes(32).toString('hex');
}

export function commitOf(serverSeed: string): string {
  return createHash('sha256').update(serverSeed, 'utf8').digest('hex');
}

/** Deterministic byte stream: HMAC-SHA256(serverSeed, message:counter) blocks. */
class HmacStream {
  private block: Buffer = Buffer.alloc(0);
  private offset = 0;
  private counter = 0;
  constructor(
    private readonly serverSeed: string,
    private readonly message: string,
  ) {}

  nextUint32(): number {
    if (this.offset + 4 > this.block.length) {
      this.block = createHmac('sha256', this.serverSeed)
        .update(`${this.message}:${this.counter++}`, 'utf8')
        .digest();
      this.offset = 0;
    }
    const value = this.block.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  /** Unbiased integer in [0, n) via rejection sampling — no modulo bias. */
  nextInt(n: number): number {
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    for (;;) {
      const v = this.nextUint32();
      if (v < limit) return v % n;
    }
  }
}

/** The exact message the deck derivation is keyed on. Client seeds are joined
 *  in SEAT ORDER so every player's contribution is pinned to a position. */
export function shuffleMessage(clientSeeds: readonly string[], handNumber: number): string {
  return `${clientSeeds.join('|')}+${handNumber}`;
}

/** Fisher–Yates over the canonical 52-card deck, driven by the HMAC stream.
 *  Fully deterministic given (serverSeed, clientSeeds, handNumber): anyone can
 *  re-derive the deck after the seed is revealed. */
export function deriveDeck(
  serverSeed: string,
  clientSeeds: readonly string[],
  handNumber: number,
): Deck {
  const stream = new HmacStream(serverSeed, shuffleMessage(clientSeeds, handNumber));
  const deck = [...orderedDeck()] as Card[];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = stream.nextInt(i + 1);
    const tmp = deck[i] as Card;
    deck[i] = deck[j] as Card;
    deck[j] = tmp;
  }
  return deck;
}
