// Hand histories: full transparency, append-only JSONL, public to every player
// after the hand ends. This file plus the revealed seeds is everything a
// suspicious friend needs to verify any hand ever dealt (tools/verify-hand.ts).
//
// Reads are served from memory. The file used to be read and parsed in full,
// synchronously, on every request — so the bigger the history grew, the longer
// each Hands-tab refresh froze the table for everyone. Now it is streamed once
// at startup, the most recent hands are kept in memory, and every new hand is
// appended to both. Only a lookup for a hand older than that window touches
// the disk again, and it streams rather than blocking.

import { appendFileSync, createReadStream, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

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

/** How many hands stay in memory. The API serves at most 200; the rest of the
 *  window keeps a lookup by id for anything from the last few nights cheap. */
const MEMORY_WINDOW = 2_000;

export class HandHistory {
  private recentHands: HandRecord[] = [];
  private loaded = false;
  /** Records in the file. While it is no more than the memory window, memory
   *  holds every hand there is, and a miss is a miss — no disk read. */
  private recordsInFile = 0;

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  /** Stream the file once, keeping the most recent hands. Call before serving. */
  async load(): Promise<void> {
    const recent: HandRecord[] = [];
    let count = 0;
    await this.scan((record) => {
      count += 1;
      recent.push(record);
      if (recent.length > MEMORY_WINDOW) recent.shift();
      return false;
    });
    // Hands appended while the file was streaming are already in memory.
    this.recordsInFile += count;
    this.recentHands = [...recent, ...this.recentHands].slice(-MEMORY_WINDOW);
    this.loaded = true;
  }

  append(record: HandRecord): void {
    appendFileSync(this.file, JSON.stringify(record) + '\n', 'utf8');
    this.recordsInFile += 1;
    this.recentHands.push(record);
    if (this.recentHands.length > MEMORY_WINDOW) this.recentHands.shift();
  }

  /** The last `count` hands, oldest first. */
  recent(count: number): HandRecord[] {
    return this.recentHands.slice(-count);
  }

  /** Look up by stable handId, or by handNumber for convenience. handNumber can
   *  repeat across server restarts, so the MOST RECENT match wins. */
  async find(idOrNumber: string): Promise<HandRecord | undefined> {
    const inMemory = findIn(this.recentHands, idOrNumber);
    if (inMemory || !this.loaded || this.recordsInFile <= this.recentHands.length) return inMemory;
    // Older than the memory window: stream the file rather than load it. One
    // scan at a time — a burst of lookups for hands that do not exist should
    // cost one read, not one each.
    const scan = this.scanning.then(() => this.findOnDisk(idOrNumber));
    this.scanning = scan.then(
      () => undefined,
      () => undefined,
    );
    return scan;
  }

  private scanning: Promise<void> = Promise.resolve();

  private async findOnDisk(idOrNumber: string): Promise<HandRecord | undefined> {
    const n = Number(idOrNumber);
    let match: HandRecord | undefined;
    await this.scan((record) => {
      if (record.handId === idOrNumber) {
        match = record;
        return true;
      }
      if (Number.isFinite(n) && record.handNumber === n) match = record;
      return false;
    });
    return match;
  }

  /** Visit every record in file order; the visitor returns true to stop. */
  private async scan(visit: (record: HandRecord) => boolean): Promise<void> {
    if (!existsSync(this.file)) return;
    const lines = createInterface({
      input: createReadStream(this.file, 'utf8'),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      if (visit(JSON.parse(line) as HandRecord)) {
        lines.close();
        break;
      }
    }
  }
}

function findIn(records: readonly HandRecord[], idOrNumber: string): HandRecord | undefined {
  const byId = records.find((r) => r.handId === idOrNumber);
  if (byId) return byId;
  const n = Number(idOrNumber);
  if (!Number.isFinite(n)) return undefined;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]?.handNumber === n) return records[i];
  }
  return undefined;
}
