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
    /** Every card dealt, kept ON THE SERVER. Never served as-is: the API
     *  passes records through publicHandRecord (redact.ts) first. */
    holeCards: string[];
    finalStatus: string;
    stackAfter: number;
    /** Reached showdown, so both cards were shown to the table. Absent on
     *  records written before 11 Oct 2026 — see publicHandRecord. */
    showdown?: boolean;
    /** Cards the player chose to show after the hand, by position. Merged in
     *  from `show` lines when the history is read; never written in the record. */
    shown?: (string | null)[];
  }[];
  board: string[];
  actions: { seat: number; action: string; to?: number }[];
  pots: { amount: number; eligibleSeats: number[] }[];
};

/** A player chose to show cards after the hand (HOUSE-RULES #16). Shows come
 *  after the hand record is written, so each is its own line in the file. It
 *  has no handNumber or commit, so an older verifier skips straight past it. */
export type ShowLine = { show: { handId: string; seat: number; cards: (string | null)[] } };

type Line = HandRecord | ShowLine;

function isShow(line: Line): line is ShowLine {
  return 'show' in line;
}

/** Fold a show into its record: a card once shown stays shown. */
function applyShow(record: HandRecord, show: ShowLine['show']): void {
  const seat = record.seats.find((s) => s.seat === show.seat);
  if (!seat) return;
  const merged = [0, 1].map((i) => show.cards[i] ?? seat.shown?.[i] ?? null);
  seat.shown = merged;
}

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
    await this.scan((line) => {
      if (isShow(line)) {
        const record = findIn(recent, line.show.handId);
        if (record) applyShow(record, line.show);
        return false;
      }
      count += 1;
      recent.push(line);
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

  /** Record that a player showed cards from a finished hand. */
  appendShow(show: ShowLine['show']): void {
    const line: ShowLine = { show };
    appendFileSync(this.file, JSON.stringify(line) + '\n', 'utf8');
    const record = findIn(this.recentHands, show.handId);
    if (record) applyShow(record, show);
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
    let exact = false;
    await this.scan((line) => {
      if (isShow(line)) {
        if (match && line.show.handId === match.handId) applyShow(match, line.show);
        return false;
      }
      // Shows for a hand always come before the next hand's record, so the
      // first record after an exact match ends the search.
      if (exact) return true;
      if (line.handId === idOrNumber) {
        match = line;
        exact = true;
        return false;
      }
      if (Number.isFinite(n) && line.handNumber === n) match = line;
      return false;
    });
    return match;
  }

  /** Visit every line in file order; the visitor returns true to stop. */
  private async scan(visit: (line: Line) => boolean): Promise<void> {
    if (!existsSync(this.file)) return;
    const lines = createInterface({
      input: createReadStream(this.file, 'utf8'),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      if (visit(JSON.parse(line) as Line)) {
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
