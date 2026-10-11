// Kevin's decisions of 11 Oct 2026: the light host (HOUSE-RULES #13–#15) and
// mucked hands staying hidden (#16). The redaction tests here are hard rule 2:
// a mucked card must be ABSENT from what leaves the server, so the fuzzer at
// the bottom is named for the leak suite and runs with it.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ClientMessage, ServerMessage, TableView } from '@poker/protocol';
import { publicHandRecordSchema } from '@poker/protocol';
import { buildApp } from '../src/app.js';
import { HandHistory } from '../src/history.js';
import type { HandRecord, ShowLine } from '../src/history.js';
import { publicHandRecord } from '../src/redact.js';
import type { TableConfig } from '../src/table.js';
import { Table } from '../src/table.js';

const CONFIG: TableConfig = {
  tableName: 'host test',
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  minBuyIn: 2,
  maxBuyIn: 400,
};

/** Seeded deterministic PRNG — tests only (CLAUDE.md hard rule 3). */
function testRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Seat = {
  id: string;
  token: string;
  seat: number;
  sent: ServerMessage[];
  closed: boolean;
};

class Room {
  readonly records: HandRecord[] = [];
  readonly shows: ShowLine['show'][] = [];
  readonly table = new Table(
    CONFIG,
    (r) => this.records.push(r),
    (s) => this.shows.push(s),
  );
  readonly people = new Map<string, Seat>();

  join(name: string, seat: number | null, buyIn = 200, isHost = false): Seat {
    const entry: Seat = { id: '', token: '', seat: seat ?? -1, sent: [], closed: false };
    const player = this.table.join({
      name,
      avatar: 0,
      clientSeed: `${name}-seed`,
      isHost,
      existingToken: undefined,
      send: (m) => entry.sent.push(m),
      close: () => {
        entry.closed = true;
      },
    });
    entry.id = player.playerId;
    entry.token = player.token;
    this.people.set(name, entry);
    if (seat !== null) {
      const error = this.do(name, { type: 'sit', seat, buyIn });
      if (error) throw new Error(`could not seat ${name}: ${error.message}`);
    }
    return entry;
  }

  get(name: string): Seat {
    const p = this.people.get(name);
    if (!p) throw new Error(`no ${name}`);
    return p;
  }

  do(name: string, msg: ClientMessage): Extract<ServerMessage, { type: 'error' }> | null {
    const reply = this.table.handle(this.get(name).id, msg);
    return reply && reply.type === 'error' ? reply : null;
  }

  view(name: string | null = null): TableView {
    return this.table.viewFor(name === null ? null : this.get(name).id);
  }

  actingName(): string {
    const view = this.view();
    const id = view.actingSeat === null ? null : view.seats[view.actingSeat]?.playerId;
    const found = [...this.people.entries()].find(([, p]) => p.id === id);
    if (!found) throw new Error('nobody to act');
    return found[0];
  }

  act(name: string, action: Extract<ClientMessage, { type: 'action' }>['action']): void {
    const error = this.do(name, { type: 'action', handNumber: this.view().handNumber, action });
    if (error) throw new Error(`${name} ${action.kind}: ${error.message}`);
  }

  /** Chips on the table: stacks, plus whatever is in the middle of a live hand. */
  chipsInPlay(): number {
    const view = this.view();
    const stacks = view.seats.reduce((sum, s) => sum + s.stack, 0);
    return stacks + (view.street === 'complete' || view.street === 'idle' ? 0 : view.potTotal);
  }

  removedTotal(): number {
    return this.table.chipLog
      .filter((e) => e.reason.startsWith('removed by host'))
      .reduce((sum, e) => sum - e.delta, 0);
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------

describe('removing a player (HOUSE-RULES #14)', () => {
  test('only the host can remove, and never themselves', () => {
    const room = new Room();
    room.join('Kev', 0, 200, true);
    room.join('Ann', 1);
    room.join('Bob', 2);
    expect(room.do('Ann', { type: 'kick', playerId: room.get('Bob').id })?.code).toBe('hostOnly');
    expect(room.do('Kev', { type: 'kick', playerId: room.get('Kev').id })?.code).toBe('notYourself');
    expect(room.do('Kev', { type: 'kick', playerId: 'nobody' })?.code).toBe('unknownPlayer');
  });

  test('between hands: seat emptied, stack logged as removed by host, connection closed', () => {
    const room = new Room();
    room.join('Kev', 0, 200, true);
    const ann = room.join('Ann', 1, 150);
    expect(room.do('Kev', { type: 'kick', playerId: ann.id })).toBeNull();
    expect(room.view().seats[1]?.playerId).toBeNull();
    expect(room.table.chipLog.at(-1)).toMatchObject({
      playerName: 'Ann',
      delta: -150,
      reason: 'removed by host',
    });
    expect(ann.closed).toBe(true);
    expect(ann.sent.some((m) => m.type === 'error' && m.code === 'kicked')).toBe(true);
    expect(room.table.getPlayer(ann.id)).toBeUndefined();
    expect(room.view().players.map((p) => p.name)).toEqual(['Kev']);
  });

  test('mid-hand, not their turn: the hand is dead at once and their chips stay in the pot', () => {
    const room = new Room();
    // The host deals from the rail, so is in no pot: removal is at once (#18).
    room.join('Kev', null, 200, true);
    room.join('Ann', 1);
    room.join('Bob', 2);
    room.join('Cat', 3);
    room.do('Kev', { type: 'startHand' });
    const before = room.chipsInPlay();
    const potBefore = room.view().potTotal;
    const acting = room.actingName();
    // Remove someone who is NOT to act and has a blind in.
    const victimName = ['Ann', 'Bob', 'Cat'].find(
      (n) => n !== acting && (room.view().seats[room.get(n).seat]?.committedThisStreet ?? 0) > 0,
    ) as string;
    const victim = room.get(victimName);
    const victimStack = room.view().seats[victim.seat]?.stack ?? 0;

    room.do('Kev', { type: 'kick', playerId: victim.id });

    const after = room.view();
    expect(after.street).not.toBe('complete');
    expect(room.actingName()).toBe(acting); // the action did not move
    expect(after.potTotal).toBe(potBefore); // their blind is still in there
    expect(after.seats[victim.seat]?.playerId).toBeNull();
    expect(room.removedTotal()).toBe(victimStack);
    expect(room.chipsInPlay() + room.removedTotal()).toBe(before);
  });

  test('removing someone else does not give the player on the clock a fresh clock', () => {
    const room = new Room();
    room.join('Kev', null, 200, true);
    room.join('Ann', 1);
    room.join('Bob', 2);
    room.join('Cat', 3);
    room.do('Kev', { type: 'startHand' });
    const acting = room.actingName();
    const deadline = room.view().actionDeadline;
    vi.advanceTimersByTime(30_000);
    const victim = ['Ann', 'Bob', 'Cat'].find((n) => n !== acting) as string;
    room.do('Kev', { type: 'kick', playerId: room.get(victim).id });
    expect(room.actingName()).toBe(acting);
    expect(room.view().actionDeadline).toBe(deadline);
    // And it still expires on time: 15 seconds left, not 45.
    vi.advanceTimersByTime(15_001);
    expect(room.view(acting).you?.away).toBe('sittingOut');
  });

  test('host in the same pot: the removal waits until the hand ends (#18)', () => {
    // Heads-up, Ann raises into the host. Removing her now would win the host
    // the pot without a call, so she plays the hand out and leaves after it.
    const room = new Room();
    room.join('Kev', 0, 200, true);
    const ann = room.join('Ann', 1);
    room.do('Kev', { type: 'startHand' });
    const first = room.actingName();
    room.act(first, { kind: 'raise', to: 20 });
    expect(room.do('Kev', { type: 'kick', playerId: ann.id })).toBeNull();
    // Nothing happened to the hand: Ann is still in it, and still at the table.
    expect(room.view().seats[1]?.hasCards).toBe(true);
    expect(room.table.getPlayer(ann.id)).toBeDefined();
    expect(ann.closed).toBe(false);
    expect(room.view().players.find((p) => p.playerId === ann.id)?.removeAfterHand).toBe(true);
    expect(room.removedTotal()).toBe(0);
    // Play it out: whoever is to act calls or checks down.
    for (let guard = 0; guard < 30 && room.table.handInProgress(); guard++) {
      const name = room.actingName();
      room.act(name, room.view(name).legal?.canCheck ? { kind: 'check' } : { kind: 'call' });
    }
    expect(room.table.handInProgress()).toBe(false);
    // Now she is gone, with whatever she ended the hand with.
    expect(room.table.getPlayer(ann.id)).toBeUndefined();
    expect(ann.closed).toBe(true);
    expect(room.view().seats[1]?.playerId).toBeNull();
    expect(room.view().seats[0]!.stack + room.removedTotal()).toBe(400); // non-null: Kev is seated
  });

  test('a second host session cannot remove an opponent from a pot the seated host is playing (#18)', () => {
    // Review finding: the host code works on any number of devices. Kevin
    // seated on his phone and on the rail on his laptop could remove Ann from
    // the phone's pot via the laptop, and win it without a showdown.
    const room = new Room();
    room.join('Kev', 0, 200, true);
    room.join('KevLaptop', null, 200, true);
    const ann = room.join('Ann', 1);
    room.do('Kev', { type: 'startHand' });
    room.act(room.actingName(), { kind: 'raise', to: 50 });
    room.act(room.actingName(), { kind: 'call' });
    expect(room.view().street).toBe('flop');
    expect(room.do('KevLaptop', { type: 'kick', playerId: ann.id })).toBeNull();
    expect(room.table.handInProgress()).toBe(true);
    expect(room.view().seats[1]?.hasCards).toBe(true);
    expect(room.view().players.find((p) => p.playerId === ann.id)?.removeAfterHand).toBe(true);
  });

  test.each(['leave', 'standUp'] as const)(
    'a player waiting to be removed who folds and then tries to %s is removed there and then',
    (how) => {
      // Review finding: folding and leaving before the hand ended skipped the
      // public "removed by host" entry and the token bar entirely.
      const room = new Room();
      room.join('Kev', 0, 200, true);
      const ann = room.join('Ann', 1);
      room.join('Bob', 2);
      room.do('Kev', { type: 'startHand' });
      room.do('Kev', { type: 'kick', playerId: ann.id });
      expect(room.view().players.find((p) => p.playerId === ann.id)?.removeAfterHand).toBe(true);
      // Play until it is Ann's turn, then she folds.
      for (let guard = 0; guard < 10 && room.actingName() !== 'Ann'; guard++) {
        const name = room.actingName();
        room.act(name, room.view(name).legal?.canCheck ? { kind: 'check' } : { kind: 'call' });
      }
      room.act('Ann', { kind: 'fold' });
      expect(room.table.handInProgress()).toBe(true);
      expect(room.do('Ann', { type: how })).toBeNull();
      expect(room.table.getPlayer(ann.id)).toBeUndefined();
      expect(ann.closed).toBe(true);
      expect(room.table.isTokenBarred(ann.token)).toBe(true);
      expect(room.table.chipLog.some((e) => e.playerName === 'Ann' && e.reason === 'removed by host')).toBe(true);
    },
  );

  test('host not in the pot: removed at once, and the raise nobody called goes back with them (#19)', () => {
    // Host on the button folds; Ann raises to 20 into Bob's big blind; the host
    // removes Ann. Bob matched only 2 of her 20, so 18 goes back to Ann — and
    // leaves the table with her. Bob wins what he matched, not her raise.
    const room = new Room();
    room.join('Kev', 0, 200, true);
    const ann = room.join('Ann', 1);
    room.join('Bob', 2);
    room.do('Kev', { type: 'startHand' });
    expect(room.actingName()).toBe('Kev');
    room.act('Kev', { kind: 'fold' });
    room.act('Ann', { kind: 'raise', to: 20 });
    room.do('Kev', { type: 'kick', playerId: ann.id });
    expect(room.table.handInProgress()).toBe(false);
    expect(room.view().seats[2]?.stack).toBe(202);
    const log = room.table.chipLog.filter((e) => e.playerName === 'Ann').map((e) => [e.delta, e.reason]);
    expect(log).toContainEqual([-18, 'removed by host (unmatched bet)']);
    expect(log).toContainEqual([-180, 'removed by host']);
    expect(room.chipsInPlay() + room.removedTotal()).toBe(600);
    const record = room.records.at(-1);
    expect(record?.actions.some((a) => a.action === 'removed by host')).toBe(true);
  });

  test('Kevin’s case at the table: the short stack wins what it matched, the folder gets its bet back', () => {
    // Host on the rail. Ann (seat 0) all-in for 20; Bob and Cat call. Flop:
    // Bob bets 30, Cat raises to 100, the host removes Cat, Bob folds.
    const room = new Room();
    room.join('Kev', null, 200, true);
    room.join('Ann', 0, 20);
    room.join('Bob', 1, 200);
    const cat = room.join('Cat', 2, 200);
    room.do('Kev', { type: 'startHand' });
    room.act('Ann', { kind: 'allIn' });
    room.act('Bob', { kind: 'call' });
    room.act('Cat', { kind: 'call' });
    room.act('Bob', { kind: 'bet', to: 30 });
    room.act('Cat', { kind: 'raise', to: 100 });
    room.do('Kev', { type: 'kick', playerId: cat.id });
    expect(room.view('Bob').legal?.callAmount).toBe(70); // the bet still stands (#20)
    room.act('Bob', { kind: 'fold' });
    expect(room.table.handInProgress()).toBe(false);
    expect(room.view().seats[0]?.stack).toBe(60); // 20 from each, no more
    expect(room.view().seats[1]?.stack).toBe(180); // Bob's 30 came back
    expect(room.removedTotal()).toBe(180); // Cat's 80 behind + 100 unmatched
  });

  test('an all-in player can be removed: their hand is dead and it is never paid', () => {
    const room = new Room();
    room.join('Kev', null, 200, true);
    const ann = room.join('Ann', 1, 20);
    room.join('Bob', 2);
    room.join('Cat', 3);
    room.do('Kev', { type: 'startHand' });
    for (let guard = 0; guard < 10 && room.view().seats[1]?.isAllIn !== true; guard++) {
      const name = room.actingName();
      room.act(name, name === 'Ann' ? { kind: 'allIn' } : { kind: 'call' });
    }
    expect(room.view().seats[1]?.isAllIn).toBe(true);
    const before = room.chipsInPlay();
    room.do('Kev', { type: 'kick', playerId: ann.id });
    // Play it out by checking and calling.
    for (let guard = 0; guard < 30 && room.table.handInProgress(); guard++) {
      const name = room.actingName();
      const legal = room.view(name).legal;
      room.act(name, legal?.canCheck ? { kind: 'check' } : { kind: 'call' });
    }
    expect(room.table.handInProgress()).toBe(false);
    expect(room.removedTotal()).toBe(0); // all-in: nothing left behind to remove
    expect(room.chipsInPlay()).toBe(before);
    const record = room.records.at(-1);
    expect(record?.seats.find((s) => s.seat === 1)?.showdown).toBe(false);
  });

  test('their token cannot rejoin until the server restarts', () => {
    const room = new Room();
    room.join('Kev', 0, 200, true);
    const ann = room.join('Ann', 1);
    room.do('Kev', { type: 'kick', playerId: ann.id });
    expect(room.table.isTokenBarred(ann.token)).toBe(true);
    expect(room.table.isTokenBarred(room.get('Kev').token)).toBe(false);
    // A restart is a new Table: nothing is remembered.
    expect(new Table(CONFIG, () => {}).isTokenBarred(ann.token)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('pausing (HOUSE-RULES #15)', () => {
  test('only the host can pause, and everyone sees it', () => {
    const room = new Room();
    room.join('Kev', 0, 200, true);
    room.join('Ann', 1);
    expect(room.do('Ann', { type: 'setPaused', paused: true })?.code).toBe('hostOnly');
    expect(room.do('Kev', { type: 'setPaused', paused: true })).toBeNull();
    expect(room.view('Ann').paused).toBe(true);
    expect(room.view('Kev').paused).toBe(true);
  });

  test('a hand in progress plays out on its normal clock, then nothing is dealt until resume', () => {
    const room = new Room();
    room.join('Kev', 0, 200, true);
    room.join('Ann', 1);
    room.do('Kev', { type: 'startHand' });
    room.do('Kev', { type: 'setPaused', paused: true });
    expect(room.table.handInProgress()).toBe(true);
    // Nobody acts. The clock is not frozen: it expires and resolves the hand.
    for (let i = 0; i < 6 && room.table.handInProgress(); i++) vi.advanceTimersByTime(46_000);
    expect(room.table.handInProgress()).toBe(false);
    const handNumber = room.view().handNumber;
    // Bring both back in (the clock sat them out) and wait well past the pause.
    room.do('Kev', { type: 'sitIn', post: true });
    room.do('Ann', { type: 'sitIn', post: true });
    vi.advanceTimersByTime(60_000);
    expect(room.view().handNumber).toBe(handNumber);
    // The host cannot deal by hand either while paused.
    expect(room.do('Kev', { type: 'startHand' })?.code).toBe('paused');
    room.do('Kev', { type: 'setPaused', paused: false });
    vi.advanceTimersByTime(7_000);
    expect(room.view().handNumber).toBe(handNumber + 1);
  });

  test('pausing between hands cancels the deal that was coming', () => {
    const room = new Room();
    room.join('Kev', 0, 200, true);
    room.join('Ann', 1);
    room.do('Kev', { type: 'startHand' });
    room.act(room.actingName(), { kind: 'fold' });
    expect(room.table.handInProgress()).toBe(false);
    room.do('Kev', { type: 'setPaused', paused: true });
    vi.advanceTimersByTime(30_000);
    expect(room.view().handNumber).toBe(1);
  });

  test('sitting out and coming back still work while paused', () => {
    const room = new Room();
    room.join('Kev', 0, 200, true);
    room.join('Ann', 1);
    room.do('Kev', { type: 'setPaused', paused: true });
    expect(room.do('Ann', { type: 'sitOut' })).toBeNull();
    expect(room.view('Ann').you?.away).toBe('sittingOut');
    expect(room.do('Ann', { type: 'sitIn', post: false })).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('mucked hands stay hidden (HOUSE-RULES #16)', () => {
  test('a hand won without a showdown shows nobody’s cards', () => {
    const room = new Room();
    room.join('Kev', 0, 200, true);
    room.join('Ann', 1);
    room.do('Kev', { type: 'startHand' });
    room.act(room.actingName(), { kind: 'fold' });
    const record = room.records.at(-1) as HandRecord;
    const shown = publicHandRecord(record);
    for (const seat of shown.seats) expect(seat.holeCards).toEqual([null, null]);
    const json = JSON.stringify(shown);
    // Quoted: a bare "8c" can turn up inside the hex of a seed or commit.
    for (const seat of record.seats) {
      for (const card of seat.holeCards) expect(json).not.toContain(`"${card}"`);
    }
  });

  test('showdown seats are shown; a seat that folded is not', () => {
    const room = new Room();
    room.join('Kev', 0, 200, true);
    room.join('Ann', 1);
    room.join('Bob', 2);
    room.do('Kev', { type: 'startHand' });
    // First to act folds; the other two check it down.
    const folder = room.actingName();
    room.act(folder, { kind: 'fold' });
    for (let guard = 0; guard < 20 && room.table.handInProgress(); guard++) {
      const name = room.actingName();
      room.act(name, room.view(name).legal?.canCheck ? { kind: 'check' } : { kind: 'call' });
    }
    const record = room.records.at(-1) as HandRecord;
    const shown = publicHandRecord(record);
    const folderSeat = room.get(folder).seat;
    for (const seat of shown.seats) {
      const full = record.seats.find((s) => s.seat === seat.seat)?.holeCards;
      expect(seat.holeCards).toEqual(seat.seat === folderSeat ? [null, null] : full);
    }
  });

  test('showing one card puts exactly that card in the history', () => {
    const room = new Room();
    room.join('Kev', 0, 200, true);
    room.join('Ann', 1);
    room.do('Kev', { type: 'startHand' });
    room.act(room.actingName(), { kind: 'fold' });
    const record = room.records.at(-1) as HandRecord;
    const winner = record.seats.find((s) => s.finalStatus !== 'folded') as HandRecord['seats'][number];
    const name = winner.seat === 0 ? 'Kev' : 'Ann';
    expect(room.do(name, { type: 'show', cards: 'second' })).toBeNull();
    expect(room.shows).toEqual([
      { handId: record.handId, seat: winner.seat, cards: [null, winner.holeCards[1]] },
    ]);
    // What HandHistory does when it reads the show line back.
    winner.shown = [null, winner.holeCards[1] ?? null];
    const seat = publicHandRecord(record).seats.find((s) => s.seat === winner.seat);
    expect(seat?.holeCards).toEqual([null, winner.holeCards[1]]);
  });

  test('shows survive a restart: the history file merges them back in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'felt-shows-'));
    const file = join(dir, 'history.jsonl');
    const room = new Room();
    room.join('Kev', 0, 200, true);
    room.join('Ann', 1);
    room.do('Kev', { type: 'startHand' });
    room.act(room.actingName(), { kind: 'fold' });
    const record = room.records.at(-1) as HandRecord;
    const winner = record.seats.find((s) => s.finalStatus !== 'folded') as HandRecord['seats'][number];
    const written = new HandHistory(file);
    written.append(structuredClone(record));
    written.appendShow({ handId: record.handId, seat: winner.seat, cards: [winner.holeCards[0] ?? null, null] });
    written.appendShow({ handId: record.handId, seat: winner.seat, cards: [null, winner.holeCards[1] ?? null] });

    const reread = new HandHistory(file);
    await reread.load();
    const [loaded] = reread.recent(1);
    if (!loaded) throw new Error('nothing loaded');
    // Shown first, then second: both are now public, and nobody else's are.
    for (const seat of publicHandRecord(loaded).seats) {
      expect(seat.holeCards).toEqual(seat.seat === winner.seat ? winner.holeCards : [null, null]);
    }
  });

  test('sitting in a seat emptied during the hand cannot show the cards it held', () => {
    // Review finding: show() read the seat's cards without asking whose they
    // were. Ann folds and is removed mid-hand; after the hand Bob takes her
    // seat and presses Show.
    const room = new Room();
    room.join('Kev', null, 200, true);
    room.join('Dee', 0);
    const ann = room.join('Ann', 1);
    room.join('Cat', 2);
    room.join('Bob', null);
    room.do('Kev', { type: 'startHand' });
    room.do('Kev', { type: 'kick', playerId: ann.id });
    for (let guard = 0; guard < 30 && room.table.handInProgress(); guard++) {
      room.act(room.actingName(), { kind: 'fold' });
    }
    expect(room.table.handInProgress()).toBe(false);
    expect(room.do('Bob', { type: 'sit', seat: 1, buyIn: 100 })).toBeNull();
    expect(room.do('Bob', { type: 'show', cards: 'both' })?.code).toBe('noCards');
    expect(room.shows).toEqual([]);
    expect(room.view('Kev').seats[1]?.shownCards).toBeUndefined();
  });

  test('a show line cannot reveal a card that was not in that position', () => {
    const room = new Room();
    room.join('Kev', 0, 200, true);
    room.join('Ann', 1);
    room.do('Kev', { type: 'startHand' });
    room.act(room.actingName(), { kind: 'fold' });
    const record = room.records.at(-1) as HandRecord;
    const seat = record.seats[0] as HandRecord['seats'][number];
    seat.shown = [seat.holeCards[1] ?? null, null]; // the wrong position
    expect(publicHandRecord(record).seats[0]?.holeCards).toEqual([null, null]);
  });

  test('records written before the rule: shown only if more than one seat was still in', () => {
    const base: HandRecord = {
      handId: 'old-1',
      handNumber: 1,
      at: '2026-09-01T00:00:00.000Z',
      tableName: 't',
      commit: 'c',
      serverSeed: 's',
      clientSeeds: [],
      button: 0,
      blinds: { smallBlind: 1, bigBlind: 2, ante: 0 },
      seats: [
        { seat: 0, name: 'A', holeCards: ['As', 'Ad'], finalStatus: 'active', stackAfter: 10 },
        { seat: 1, name: 'B', holeCards: ['Ks', 'Kd'], finalStatus: 'folded', stackAfter: 10 },
        { seat: 2, name: 'C', holeCards: ['Qs', 'Qd'], finalStatus: 'busted', stackAfter: 0 },
      ],
      board: [],
      actions: [],
      pots: [],
    };
    expect(publicHandRecord(base).seats.map((s) => s.holeCards)).toEqual([
      ['As', 'Ad'],
      [null, null],
      ['Qs', 'Qd'],
    ]);
    const foldWin = { ...base, seats: base.seats.slice(0, 2) };
    expect(publicHandRecord(foldWin).seats.map((s) => s.holeCards)).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  test('leak: no public hand record ever contains a card that was not shown', () => {
    const hands = process.env['PROPERTY'] ? 1_500 : 150;
    const rng = testRng(20261011);
    const room = new Room();
    const names = ['Kev', 'Ann', 'Bob', 'Cat', 'Dee', 'Eve'];
    names.forEach((n, i) => room.join(n, i, 400, i === 0));
    room.do('Kev', { type: 'startHand' });
    const showsBySeat = new Map<string, Map<number, (string | null)[]>>();

    for (let hand = 0; hand < hands; hand++) {
      for (let guard = 0; guard < 200 && room.table.handInProgress(); guard++) {
        const name = room.actingName();
        const legal = room.view(name).legal;
        if (!legal) throw new Error('acting seat has no legal actions');
        const options: Extract<ClientMessage, { type: 'action' }>['action'][] = [];
        if (legal.canCheck) options.push({ kind: 'check' }, { kind: 'check' });
        if (legal.canCall) options.push({ kind: 'call' }, { kind: 'call' });
        if (legal.canFold) options.push({ kind: 'fold' });
        if (legal.canRaise) options.push({ kind: 'raise', to: legal.minRaise });
        if (legal.canBet) options.push({ kind: 'bet', to: legal.minBet });
        if (legal.canAllIn && rng() < 0.1) options.push({ kind: 'allIn' });
        room.act(name, options[Math.floor(rng() * options.length)] as (typeof options)[number]);
      }
      // After the hand, anyone may try to show anything.
      for (const name of names) {
        if (rng() < 0.3) {
          const which = (['both', 'first', 'second'] as const)[Math.floor(rng() * 3)] ?? 'both';
          room.do(name, { type: 'show', cards: which });
        }
      }
      for (const show of room.shows.splice(0)) {
        const bySeat = showsBySeat.get(show.handId) ?? new Map<number, (string | null)[]>();
        const prior = bySeat.get(show.seat) ?? [null, null];
        bySeat.set(show.seat, [0, 1].map((i) => show.cards[i] ?? prior[i] ?? null));
        showsBySeat.set(show.handId, bySeat);
      }
      // Keep everyone dealt in: top up the broke, bring back the timed-out.
      for (const name of names) {
        const view = room.view(name);
        if (view.you?.away !== 'no') room.do(name, { type: 'sitIn', post: true });
        const stack = view.yourSeat === null ? 0 : (view.seats[view.yourSeat]?.stack ?? 0);
        if (stack < 10) room.do(name, { type: 'topUp', amount: 400 });
      }
      vi.advanceTimersByTime(7_000);
      if (!room.table.handInProgress()) room.do('Kev', { type: 'startHand' });
    }

    expect(room.records.length).toBeGreaterThan(hands / 2);
    let muckedSeen = 0;
    for (const full of room.records) {
      const shows = showsBySeat.get(full.handId);
      for (const seat of full.seats) {
        const shownHere = shows?.get(seat.seat);
        if (shownHere) seat.shown = shownHere;
      }
      const shown = publicHandRecord(full);
      expect(publicHandRecordSchema.safeParse(shown).success).toBe(true);
      const json = JSON.stringify(shown);
      for (const seat of full.seats) {
        const out = shown.seats.find((s) => s.seat === seat.seat);
        seat.holeCards.forEach((card, i) => {
          const entitled = seat.showdown === true || seat.shown?.[i] === card;
          if (entitled) {
            expect(out?.holeCards[i]).toBe(card);
          } else {
            muckedSeen += 1;
            expect(out?.holeCards[i]).toBeNull();
            expect(json).not.toContain(`"${card}"`);
          }
        });
      }
    }
    expect(muckedSeen).toBeGreaterThan(0); // the test saw what it is guarding
  }, 120_000);
});

// ---------------------------------------------------------------------------

describe('over the wire', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  test('the history API serves only public records, and a removed token is turned away', async () => {
    vi.useRealTimers();
    const dir = mkdtempSync(join(tmpdir(), 'felt-host-'));
    const history = new HandHistory(join(dir, 'history.jsonl'));
    const table = new Table(CONFIG, (r) => history.append(r), (s) => history.appendShow(s));
    app = await buildApp({
      inviteCode: 'INVITE-CODE-0001',
      hostCode: 'HOST-CODE-000001',
      tableName: 't',
      table,
      history,
      logger: false,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const ws = `ws://127.0.0.1:${address.port}/ws`;

    const open = async (code: string, name: string, token?: string) => {
      const socket = new WebSocket(ws);
      const messages: ServerMessage[] = [];
      socket.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data)) as ServerMessage));
      const closed = new Promise<void>((r) => socket.addEventListener('close', () => r()));
      await new Promise<void>((r) => socket.addEventListener('open', () => r()));
      socket.send(JSON.stringify({ type: 'join', inviteCode: code, name, ...(token ? { playerToken: token } : {}) }));
      for (let i = 0; i < 100 && !messages.some((m) => m.type === 'welcome' || m.type === 'error'); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      return { socket, messages, closed };
    };
    const host = await open('HOST-CODE-000001', 'Kev');
    const ann = await open('INVITE-CODE-0001', 'Ann');
    const annWelcome = ann.messages.find((m) => m.type === 'welcome');
    if (!annWelcome || annWelcome.type !== 'welcome') throw new Error('Ann did not join');
    host.socket.send(JSON.stringify({ type: 'sit', seat: 0, buyIn: 100 }));
    ann.socket.send(JSON.stringify({ type: 'sit', seat: 1, buyIn: 100 }));
    await new Promise((r) => setTimeout(r, 50));
    host.socket.send(JSON.stringify({ type: 'startHand' }));
    await new Promise((r) => setTimeout(r, 50));
    const acting = table.viewFor(null).actingSeat === 0 ? host : ann;
    acting.socket.send(JSON.stringify({ type: 'action', handNumber: 1, action: { kind: 'fold' } }));
    await new Promise((r) => setTimeout(r, 50));

    const response = await fetch(`http://127.0.0.1:${address.port}/api/history`, {
      headers: { 'x-felt-code': 'INVITE-CODE-0001' },
    });
    const records = (await response.json()) as unknown[];
    expect(records).toHaveLength(1);
    const parsed = publicHandRecordSchema.parse(records[0]);
    for (const seat of parsed.seats) expect(seat.holeCards).toEqual([null, null]);

    // Remove Ann: her socket closes with the reason, and her token is done.
    host.socket.send(JSON.stringify({ type: 'kick', playerId: annWelcome.playerId }));
    await ann.closed;
    expect(ann.messages.some((m) => m.type === 'error' && m.code === 'kicked')).toBe(true);
    const back = await open('INVITE-CODE-0001', 'Ann', annWelcome.playerToken);
    expect(back.messages.some((m) => m.type === 'error' && m.code === 'kicked')).toBe(true);
    // A fresh join is still possible — which is why the UI points at Access.
    const fresh = await open('INVITE-CODE-0001', 'Ann');
    expect(fresh.messages.some((m) => m.type === 'welcome')).toBe(true);
    host.socket.close();
    fresh.socket.close();
  });
});
