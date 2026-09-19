// Hand histories: full transparency, append-only JSONL, public to every player
// after the hand ends. This file plus the revealed seeds is everything a
// suspicious friend needs to verify any hand ever dealt (tools/verify-hand.ts).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Seeds are recorded positionally. The old shape was `Record<name, seed>`,
 *  which broke verification the moment a player renamed on reconnect. */
export type ClientSeedRecord = { seat: number; name: string; seed: string; postCommit: boolean };

export type HandRecord = {
  /** Stable across restarts: `${sessionId}-${handNumber}`. handNumber alone
   *  resets to 0 on restart while this file persists, so it is not unique. */
  handId: string;
  handNumber: number;
  at: string;
  tableName: string;
  commit: string;
  serverSeed: string;
  clientSeeds: ClientSeedRecord[];
  button: number;
  blinds: { smallBlind: number; bigBlind: number; ante: number };
  seats: {
    seat: number;
    name: string;
    holeCards: string[];
    finalStatus: string;
    stackAfter: number;
  }[];
  board: string[];
  actions: { seat: number; action: string; to?: number }[];
  pots: { amount: number; eligibleSeats: number[] }[];
};

export class HandHistory {
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  append(record: HandRecord): void {
    appendFileSync(this.file, JSON.stringify(record) + '\n', 'utf8');
  }

  readAll(): HandRecord[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as HandRecord);
  }

  /** Look up by stable handId, or by handNumber for convenience. handNumber can
   *  repeat across server restarts, so the MOST RECENT match wins. */
  find(idOrNumber: string): HandRecord | undefined {
    const all = this.readAll();
    const byId = all.find((r) => r.handId === idOrNumber);
    if (byId) return byId;
    const n = Number(idOrNumber);
    if (!Number.isFinite(n)) return undefined;
    const matches = all.filter((r) => r.handNumber === n);
    return matches[matches.length - 1];
  }
}
