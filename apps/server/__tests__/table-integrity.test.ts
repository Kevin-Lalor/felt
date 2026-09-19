// Integration tests over the real Table. Every test here corresponds to a
// defect that shipped and was fixed — they exist so those defects cannot come
// back quietly. See docs/FAIRNESS.md and CLAUDE.md.
//
//   1. Commit ordering — the server must commit BEFORE it can know the client
//      seeds that commitment will be mixed with. Getting this backwards lets a
//      modified server grind decks while every published check still passes.
//   2. Seat reuse — a seat vacated mid-hand still holds its cards; taking it
//      must not serve the previous occupant's hole cards to the new player.
//   3. Verifiability — a hand record must re-derive under tools/verify-hand.ts
//      even after a player renames, which name-keyed seeds did not survive.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientMessage, ServerMessage } from '@poker/protocol';
import type { HandRecord } from '../src/history.js';
import type { TableConfig } from '../src/table.js';
import { Table } from '../src/table.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const CONFIG: TableConfig = {
  tableName: 'integrity test',
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  minBuyIn: 2, // low enough that a short stack is all-in on the blind
  maxBuyIn: 400,
};

type Seated = { id: string; token: string; seat: number; sent: ServerMessage[] };

class Harness {
  readonly records: HandRecord[] = [];
  readonly table: Table;
  readonly players = new Map<string, Seated>();

  constructor(config: TableConfig = CONFIG) {
    this.table = new Table(config, (r) => this.records.push(r));
  }

  seat(name: string, seatIndex: number, buyIn = 200, isHost = false): Seated {
    const sent: ServerMessage[] = [];
    const player = this.table.join({
      name,
      avatar: 0,
      clientSeed: `${name}-initial-seed`,
      isHost,
      existingToken: undefined,
      send: (m) => sent.push(m),
    });
    const entry: Seated = { id: player.playerId, token: player.token, seat: seatIndex, sent };
    this.players.set(name, entry);
    const error = this.table.handle(player.playerId, {
      type: 'sit',
      seat: seatIndex,
      buyIn,
    } as ClientMessage);
    if (error) throw new Error(`could not seat ${name}: ${JSON.stringify(error)}`);
    return entry;
  }

  get(name: string): Seated {
    const p = this.players.get(name);
    if (!p) throw new Error(`no player ${name}`);
    return p;
  }

  commits(name: string): Extract<ServerMessage, { type: 'handCommit' }>[] {
    return this.get(name).sent.filter(
      (m): m is Extract<ServerMessage, { type: 'handCommit' }> => m.type === 'handCommit',
    );
  }

  /** Act as `name`, asserting it really is their turn. Keeps the scripted
   *  hands below honest about blind positions instead of hoping. */
  act(name: string, action: { kind: 'fold' | 'check' | 'call' }): void {
    const p = this.get(name);
    const view = this.table.viewFor(p.id);
    if (view.actingSeat !== p.seat) {
      throw new Error(`expected ${name} (seat ${p.seat}) to act, but seat ${view.actingSeat} is`);
    }
    const error = this.table.handle(p.id, {
      type: 'action',
      handNumber: view.handNumber,
      action,
    } as ClientMessage);
    if (error) throw new Error(`${name} ${action.kind} rejected: ${JSON.stringify(error)}`);
  }

  /** End the hand the cheapest way: whoever is to act folds. */
  foldToTheEnd(): void {
    const anyPlayer = [...this.players.values()][0] as Seated;
    for (let guard = 0; guard < 60 && this.table.handInProgress(); guard++) {
      const view = this.table.viewFor(anyPlayer.id);
      if (view.actingSeat === null) break;
      const actingId = view.seats[view.actingSeat]?.playerId;
      if (!actingId) break;
      this.table.handle(actingId, {
        type: 'action',
        handNumber: view.handNumber,
        action: { kind: 'fold' },
      } as ClientMessage);
    }
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------

describe('commit ordering — the server commits before it can know the seeds', () => {
  test('a commitment for hand 1 exists before anyone has joined', () => {
    const h = new Harness();
    const spectator = h.table.viewFor(null).fairness;
    expect(spectator).not.toBeNull();
    expect(spectator?.nextHandNumber).toBe(1);
    expect(spectator?.nextCommit).toMatch(/^[0-9a-f]{64}$/);
    // No hand has been dealt, so there is nothing to reveal yet.
    expect(spectator?.commit).toBeNull();
    expect(spectator?.revealedServerSeed).toBeNull();
  });

  test('hand 1 consumes the commitment that was public before it started', () => {
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    h.seat('Bob', 1);

    const publishedBefore = h.table.viewFor(ann.id).fairness?.nextCommit;
    expect(publishedBefore).toBeTruthy();

    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);

    const [first] = h.commits('Ann');
    expect(first?.handNumber).toBe(1);
    expect(first?.commit).toBe(publishedBefore);
  });

  test('each hand consumes the commitment published during the previous hand', () => {
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    h.seat('Bob', 1);

    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);
    const [handOne] = h.commits('Ann');
    expect(handOne?.nextHandNumber).toBe(2);
    const promisedForHandTwo = handOne?.nextCommit;

    h.foldToTheEnd();
    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);

    const handTwo = h.commits('Ann')[1];
    expect(handTwo?.handNumber).toBe(2);
    // This is the whole guarantee: the commitment for hand 2 was published
    // while hand 1 was running, i.e. before any seed for hand 2 was chosen.
    expect(handTwo?.commit).toBe(promisedForHandTwo);
    expect(handTwo?.commit).not.toBe(handOne?.commit);
  });

  test('a seed rotated against the published commitment is marked post-commit', () => {
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    const bob = h.seat('Bob', 1);

    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);
    // Ann rotates during hand 1 — against the commitment for hand 2.
    h.table.handle(ann.id, {
      type: 'setClientSeed',
      seed: 'ann-rotated-after-the-commit',
    } as ClientMessage);
    h.foldToTheEnd();
    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);

    const seeds = h.table.viewFor(bob.id).fairness?.clientSeeds ?? [];
    const annSeed = seeds.find((s) => s.name === 'Ann');
    const bobSeed = seeds.find((s) => s.name === 'Bob');

    expect(annSeed?.postCommit).toBe(true);
    // Bob never rotated: his seed was known to the server before it committed,
    // so it is honestly reported as NOT protecting him.
    expect(bobSeed?.postCommit).toBe(false);
  });

  test('seeds are recorded positionally, by seat, never keyed by name', () => {
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    h.seat('Bob', 3);

    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);
    h.foldToTheEnd();

    const [record] = h.records;
    expect(Array.isArray(record?.clientSeeds)).toBe(true);
    expect(record?.clientSeeds.map((s) => s.seat)).toEqual([0, 3]);
    expect(record?.handId).toMatch(/^[0-9a-f]{8}-1$/);
    // The blinds field carries three keys, not a spread of the whole config.
    expect(Object.keys(record?.blinds ?? {}).sort()).toEqual(['ante', 'bigBlind', 'smallBlind']);
  });
});

// ---------------------------------------------------------------------------

describe('seat reuse — cards belong to the player they were dealt to', () => {
  test('a seat still holding cards cannot be taken mid-hand', () => {
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    const bob = h.seat('Bob', 1);
    h.seat('Cat', 2);
    h.seat('Eve', 3);

    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);
    expect(h.table.handInProgress()).toBe(true);

    // Button 0, small blind 1 (Bob), big blind 2 (Cat), first to act 3 (Eve).
    // Bob folds with Ann, Cat and Eve still live, so the hand carries on
    // around the seat he is about to vacate.
    h.act('Eve', { kind: 'call' });
    h.act('Ann', { kind: 'call' });
    h.act('Bob', { kind: 'fold' });
    expect(h.table.handInProgress()).toBe(true);

    // Standing up is allowed — he folded — but his cards stay in the hand.
    expect(h.table.handle(bob.id, { type: 'standUp' } as ClientMessage)).toBeNull();

    // A newcomer tries to take a seat whose cards are still on the table.
    const dan: ServerMessage[] = [];
    const danPlayer = h.table.join({
      name: 'Dan',
      avatar: 0,
      clientSeed: 'dan',
      isHost: false,
      existingToken: undefined,
      send: (m) => dan.push(m),
    });
    const refusal = h.table.handle(danPlayer.playerId, {
      type: 'sit',
      seat: 1,
      buyIn: 200,
    } as ClientMessage);

    expect(refusal).toMatchObject({ type: 'error', code: 'seatInHand' });

    // And nothing anywhere in Dan's view carries a hole card.
    const danView = h.table.viewFor(danPlayer.playerId);
    for (const seat of danView.seats) {
      expect(seat.holeCards).toBeUndefined();
    }
  });

  test('an all-in player cannot leave the hand and forfeit their winnings', () => {
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    h.seat('Bob', 1);
    const shorty = h.seat('Shorty', 2, 2); // all-in the moment blinds are posted

    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);

    const view = h.table.viewFor(shorty.id);
    const shortySeat = view.seats[2];
    // Either posted all-in, or still active — both must be blocked from leaving.
    if (shortySeat?.isAllIn || shortySeat?.status === 'allIn' || shortySeat?.status === 'active') {
      expect(h.table.handle(shorty.id, { type: 'standUp' } as ClientMessage)).toMatchObject({
        type: 'error',
        code: 'inHand',
      });
      expect(h.table.handle(shorty.id, { type: 'leave' } as ClientMessage)).toMatchObject({
        type: 'error',
        code: 'inHand',
      });
    }
  });

  test('another player never receives hole cards on a seat that is not theirs', () => {
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    const bob = h.seat('Bob', 1);

    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);

    const annView = h.table.viewFor(ann.id);
    const bobView = h.table.viewFor(bob.id);
    expect(annView.seats[0]?.holeCards).toHaveLength(2);
    expect(annView.seats[1]?.holeCards).toBeUndefined();
    expect(bobView.seats[1]?.holeCards).toHaveLength(2);
    expect(bobView.seats[0]?.holeCards).toBeUndefined();
    // And the two players never hold the same cards.
    expect(annView.seats[0]?.holeCards).not.toEqual(bobView.seats[1]?.holeCards);
  });
});

// ---------------------------------------------------------------------------

describe('verifiability — a record survives a rename and re-derives offline', () => {
  test('a player cannot rename while seated in a live hand', () => {
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    h.seat('Bob', 1);
    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);

    const rejoined = h.table.join({
      name: 'Renamed Mid Hand',
      avatar: 0,
      clientSeed: undefined,
      isHost: false,
      existingToken: ann.token,
      send: () => {},
    });
    expect(rejoined.playerId).toBe(ann.id);
    expect(rejoined.name).toBe('Ann'); // frozen for the duration of the hand
  });

  test('tools/verify-hand.ts re-derives a real record, rename and all', () => {
    const h = new Harness();
    const ann = h.seat('Ann', 0, 200, true);
    h.seat('Bob', 1);

    h.table.handle(ann.id, { type: 'startHand' } as ClientMessage);
    h.foldToTheEnd();

    // Between hands, Ann renames — the exact move that used to orphan the
    // record's name-keyed seeds and make an honest hand fail verification.
    const renamed = h.table.join({
      name: 'Annabel',
      avatar: 0,
      clientSeed: undefined,
      isHost: false,
      existingToken: ann.token,
      send: () => {},
    });
    expect(renamed.name).toBe('Annabel');

    const [record] = h.records;
    expect(record).toBeDefined();

    const dir = mkdtempSync(join(tmpdir(), 'felt-verify-'));
    const file = join(dir, 'history.jsonl');
    writeFileSync(file, JSON.stringify(record) + '\n', 'utf8');

    // Shell out to the real verifier. It shares no code with the server, so
    // this asserts the two implementations genuinely still agree.
    const output = execSync(`npx tsx tools/verify-hand.ts ${record?.handId} "${file}"`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    expect(output).toContain('Hand verified');
    expect(output).not.toContain('FAILED');
  }, 60_000);
});
