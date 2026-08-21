// Hand histories: full transparency, append-only JSONL, public to every player
// after the hand ends. This file plus the revealed seeds is everything a
// suspicious friend needs to verify any hand ever dealt (tools/verify-hand.ts).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type HandRecord = {
  handNumber: number;
  at: string;
  tableName: string;
  commit: string;
  serverSeed: string;
  clientSeeds: Record<string, string>;
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

  find(handNumber: number): HandRecord | undefined {
    return this.readAll().find((r) => r.handNumber === handNumber);
  }
}
