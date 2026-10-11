// Security regressions. Every test here was an exploit reproduced against a
// live server in the 11 Oct 2026 review; each one failed before the fix and
// must keep passing. They run against a real server on a random port, over
// real HTTP and real WebSockets, because the first bug only existed between
// the network and the router — a test that called the handler directly could
// never have seen it.

import { afterEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { clientMessageSchema, normaliseName, playerNameSchema } from '@poker/protocol';
import type { ClientMessage, ServerMessage } from '@poker/protocol';
import { buildApp, redactUrl } from '../src/app.js';
import type { AppOptions } from '../src/app.js';
import { ConfigError, MIN_CODE_LENGTH, codeMatches, resolveCodes } from '../src/config.js';
import { HandHistory } from '../src/history.js';
import type { HandRecord } from '../src/history.js';
import { CodeGuard, PlayerRateLimits, clientAddress } from '../src/limits.js';
import { Table } from '../src/table.js';

const INVITE = 'INVITE-CODE-0001';
const HOST = 'HOST-CODE-000001';
const SERVER_DIR = fileURLToPath(new URL('../', import.meta.url));

const SAMPLE_HAND: HandRecord = {
  handId: 'abc-1',
  handNumber: 1,
  at: '2026-10-11T00:00:00.000Z',
  tableName: 't',
  commit: 'c',
  serverSeed: 's',
  clientSeeds: [],
  button: 0,
  blinds: { smallBlind: 1, bigBlind: 2, ante: 0 },
  seats: [{ seat: 0, name: 'Ann', holeCards: ['As', 'Kd'], finalStatus: 'active', stackAfter: 10 }],
  board: [],
  actions: [],
  pots: [],
};

type Running = { app: FastifyInstance; http: string; ws: string; table: Table };
const running: FastifyInstance[] = [];

async function start(overrides: Partial<AppOptions> = {}): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'felt-sec-'));
  const history = new HandHistory(join(dir, 'history.jsonl'));
  history.append(SAMPLE_HAND);
  const table = new Table(
    { tableName: 't', smallBlind: 1, bigBlind: 2, ante: 0, minBuyIn: 10, maxBuyIn: 400 },
    (r) => history.append(r),
  );
  const app = await buildApp({
    inviteCode: INVITE,
    hostCode: HOST,
    tableName: 't',
    table,
    history,
    logger: false,
    ...overrides,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  running.push(app);
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    app,
    table,
    http: `http://127.0.0.1:${address.port}`,
    ws: `ws://127.0.0.1:${address.port}/ws`,
  };
}

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

type Client = { socket: WebSocket; messages: ServerMessage[]; closed: Promise<void> };

async function connect(url: string): Promise<Client> {
  const socket = new WebSocket(url);
  const messages: ServerMessage[] = [];
  socket.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data)) as ServerMessage));
  const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('could not connect')));
  });
  return { socket, messages, closed };
}

function sendMsg(client: Client, msg: ClientMessage | Record<string, unknown>): void {
  client.socket.send(JSON.stringify(msg));
}

/** Wait until the server has said something matching, or fail loudly. */
async function until(client: Client, match: (m: ServerMessage) => boolean): Promise<ServerMessage> {
  for (let i = 0; i < 100; i++) {
    const found = client.messages.find(match);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no matching message; got ${JSON.stringify(client.messages.map((m) => m.type))}`);
}

const errorCode = (code: string) => (m: ServerMessage) => m.type === 'error' && m.code === code;

async function sitDown(server: Running, name: string, code = INVITE): Promise<Client> {
  const client = await connect(server.ws);
  sendMsg(client, { type: 'join', inviteCode: code, name });
  await until(client, (m) => m.type === 'welcome' || m.type === 'error');
  return client;
}

// ---------------------------------------------------------------------------

describe('blocker 1: hand history needs the code however the path is spelled', () => {
  const encodedPaths = [
    '/api/history',
    '/api/%68istory',
    '/%61pi/history',
    '/%61%70%69/%68%69%73%74%6f%72%79',
    '/api/f%61irness',
    '/api/fairness',
    '/api/history/abc-1',
    '/api/%68istory/abc-1',
    '/api/history/1',
  ];

  test.each(encodedPaths)('%s without a code is 401 and leaks no cards', async (path) => {
    const server = await start();
    const response = await fetch(server.http + path);
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).not.toContain('As');
    expect(body).not.toContain('serverSeed');
  });

  test.each(encodedPaths)('%s with the code in the header is served', async (path) => {
    const server = await start();
    const response = await fetch(server.http + path, { headers: { 'x-felt-code': INVITE } });
    expect(response.status).toBe(200);
  });

  test('the code in the query string is no longer accepted', async () => {
    const server = await start();
    const response = await fetch(`${server.http}/api/history?code=${INVITE}`);
    expect(response.status).toBe(401);
  });

  test('codes compare case-insensitively and ignore surrounding spaces', async () => {
    const server = await start();
    const response = await fetch(`${server.http}/api/history`, {
      headers: { 'x-felt-code': `  ${INVITE.toLowerCase()} ` },
    });
    expect(response.status).toBe(200);
  });
});

describe('blocker 2: a blank or weak code refuses to start', () => {
  test('unset codes become strong random ones that differ', () => {
    const codes = resolveCodes({});
    expect(codes.inviteCode.length).toBeGreaterThanOrEqual(16);
    expect(codes.hostCode.length).toBeGreaterThanOrEqual(16);
    expect(codes.inviteCode).not.toBe(codes.hostCode);
    expect(codes.generated).toEqual({ invite: true, host: true });
  });

  test.each([
    ['empty host code', { INVITE_CODE: INVITE, HOST_CODE: '' }],
    ['whitespace host code', { INVITE_CODE: INVITE, HOST_CODE: '   ' }],
    ['empty invite code', { INVITE_CODE: '', HOST_CODE: HOST }],
    ['short code', { INVITE_CODE: 'SHORT1', HOST_CODE: HOST }],
    ['codes equal', { INVITE_CODE: INVITE, HOST_CODE: INVITE }],
    ['codes equal ignoring case', { INVITE_CODE: INVITE, HOST_CODE: INVITE.toLowerCase() }],
    ['a space inside', { INVITE_CODE: 'INVITE CODE 0001', HOST_CODE: HOST }],
  ])('%s throws', (_label, env) => {
    expect(() => resolveCodes(env)).toThrow(ConfigError);
  });

  test(`a set code of exactly ${MIN_CODE_LENGTH} characters is accepted`, () => {
    const codes = resolveCodes({ INVITE_CODE: 'A'.repeat(MIN_CODE_LENGTH), HOST_CODE: HOST });
    expect(codes.inviteCode).toBe('A'.repeat(MIN_CODE_LENGTH));
    expect(codes.generated).toEqual({ invite: false, host: false });
  });

  test('the real entry point exits non-zero with HOST_CODE set but empty', () => {
    let exitCode = 0;
    let output = '';
    try {
      execFileSync(join(SERVER_DIR, 'node_modules', '.bin', 'tsx'), ['src/index.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, INVITE_CODE: INVITE, HOST_CODE: '', PORT: '0' },
        stdio: 'pipe',
        timeout: 20_000,
      });
    } catch (error) {
      const failure = error as { status: number | null; stderr: Buffer };
      exitCode = failure.status ?? -1;
      output = String(failure.stderr);
    }
    expect(exitCode).toBe(1);
    expect(output).toContain('HOST_CODE is set but empty');
  });

  test('an empty candidate never matches', () => {
    expect(codeMatches('', INVITE)).toBe(false);
  });
});

describe('blocker 3: wrong codes lock you out', () => {
  const lockout = { maxFailures: 3, windowMs: 60_000, lockoutMs: 60_000 };

  test('over HTTP: after the limit even the right code is refused', async () => {
    const server = await start({ lockout });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${server.http}/api/history`, { headers: { 'x-felt-code': `WRONG-${i}-XXXXXXX` } });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
    const right = await fetch(`${server.http}/api/history`, { headers: { 'x-felt-code': INVITE } });
    expect(right.status).toBe(429);
    expect(Number(right.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  test('over the WebSocket: after the limit even the right code is refused', async () => {
    const server = await start({ lockout });
    for (let i = 0; i < 3; i++) {
      const guess = await sitDown(server, 'Guesser', `WRONG-${i}-XXXXXXX`);
      expect(guess.messages.some(errorCode('badInvite'))).toBe(true);
      await guess.closed;
    }
    const right = await sitDown(server, 'Guesser', INVITE);
    expect(right.messages.some(errorCode('tooManyAttempts'))).toBe(true);
    expect(right.messages.some((m) => m.type === 'welcome')).toBe(false);
  });

  test('the WebSocket and HTTP share one budget', async () => {
    const server = await start({ lockout });
    for (let i = 0; i < 2; i++) {
      await fetch(`${server.http}/api/history`, { headers: { 'x-felt-code': `WRONG-${i}-XXXXXXX` } });
    }
    const third = await sitDown(server, 'Guesser', 'WRONG-3-XXXXXXX');
    await third.closed;
    const right = await fetch(`${server.http}/api/history`, { headers: { 'x-felt-code': INVITE } });
    expect(right.status).toBe(429);
  });

  test('behind the tunnel, clients are told apart by CF-Connecting-IP', async () => {
    // The test client connects from 127.0.0.1, exactly as cloudflared does.
    const server = await start({ lockout });
    for (let i = 0; i < 3; i++) {
      await fetch(`${server.http}/api/history`, {
        headers: { 'x-felt-code': `WRONG-${i}-XXXXXXX`, 'cf-connecting-ip': '203.0.113.7' },
      });
    }
    const guesser = await fetch(`${server.http}/api/history`, {
      headers: { 'x-felt-code': INVITE, 'cf-connecting-ip': '203.0.113.7' },
    });
    expect(guesser.status).toBe(429);
    // Someone else coming through the same tunnel is not locked out with them.
    const friend = await fetch(`${server.http}/api/history`, {
      headers: { 'x-felt-code': INVITE, 'cf-connecting-ip': '198.51.100.20' },
    });
    expect(friend.status).toBe(200);
  });

  test('CF-Connecting-IP is only believed from loopback', () => {
    expect(clientAddress('127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddress('::1', '2001:db8::1')).toBe('2001:db8::1');
    expect(clientAddress('::ffff:127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    // Someone on the LAN writing the header themselves to dodge a lockout.
    expect(clientAddress('192.168.1.40', '203.0.113.7')).toBe('192.168.1.40');
    // Garbage in the header falls back to the peer.
    expect(clientAddress('127.0.0.1', 'not-an-ip')).toBe('127.0.0.1');
    expect(clientAddress('127.0.0.1', undefined)).toBe('127.0.0.1');
  });

  test('a right code resets the count; the lockout expires', () => {
    let now = 0;
    const guard = new CodeGuard({ maxFailures: 3, windowMs: 1_000, lockoutMs: 5_000 }, () => now);
    guard.fail('a');
    guard.fail('a');
    guard.succeed('a');
    guard.fail('a');
    guard.fail('a');
    expect(guard.lockedFor('a')).toBe(0);
    expect(guard.fail('a')).toBe(true);
    expect(guard.lockedFor('a')).toBe(5_000);
    now = 5_001;
    expect(guard.lockedFor('a')).toBe(0);
  });
});

describe('blocker 4: one connection, one player', () => {
  test('nine joins down one socket seat exactly one player', async () => {
    const server = await start();
    const client = await connect(server.ws);
    for (let i = 0; i < 9; i++) sendMsg(client, { type: 'join', inviteCode: INVITE, name: `Spam${i}` });
    await until(client, errorCode('alreadyJoined'));
    await new Promise((r) => setTimeout(r, 100));
    expect(client.messages.filter((m) => m.type === 'welcome')).toHaveLength(1);
    expect(client.messages.filter(errorCode('alreadyJoined'))).toHaveLength(8);
    expect(server.table.playerByName('Spam1')).toBeUndefined();
  });

  test('connections from one client are capped', async () => {
    const server = await start({ maxConnectionsPerClient: 3 });
    const open = [await connect(server.ws), await connect(server.ws), await connect(server.ws)];
    const extra = await connect(server.ws);
    await until(extra, errorCode('tooManyConnections'));
    await extra.closed;
    // Closing one frees its slot.
    open[0]?.socket.close();
    await open[0]?.closed;
    await new Promise((r) => setTimeout(r, 50));
    const again = await connect(server.ws);
    sendMsg(again, { type: 'join', inviteCode: INVITE, name: 'Late' });
    await until(again, (m) => m.type === 'welcome');
  });

  test('a socket that never joins is closed', async () => {
    const server = await start({ joinTimeoutMs: 150 });
    const idle = await connect(server.ws);
    await idle.closed;
    expect(idle.messages.some(errorCode('joinTimeout'))).toBe(true);
  });

  test('a socket that joins in time is not closed by the join timer', async () => {
    const server = await start({ joinTimeoutMs: 150 });
    const client = await sitDown(server, 'Prompt');
    await new Promise((r) => setTimeout(r, 300));
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe('should-fix: only the host deals', () => {
  test('after hand 1 a non-host startHand is refused and the pause stands', async () => {
    const server = await start();
    const host = await sitDown(server, 'Host', HOST);
    const guest = await sitDown(server, 'Guest');
    sendMsg(host, { type: 'sit', seat: 0, buyIn: 100 });
    sendMsg(guest, { type: 'sit', seat: 1, buyIn: 100 });
    await new Promise((r) => setTimeout(r, 100));
    sendMsg(guest, { type: 'startHand' });
    await until(guest, errorCode('hostOnly'));
    sendMsg(host, { type: 'startHand' });
    await until(host, (m) => m.type === 'state' && m.view.handNumber === 1);
    // End hand 1: whoever is to act folds.
    const view = server.table.viewFor(null);
    const acting = view.actingSeat === 0 ? host : guest;
    sendMsg(acting, { type: 'action', handNumber: 1, action: { kind: 'fold' } });
    await until(host, (m) => m.type === 'handReveal');
    guest.messages.length = 0;
    sendMsg(guest, { type: 'startHand' });
    await until(guest, errorCode('hostOnly'));
    expect(server.table.viewFor(null).handNumber).toBe(1);
  });
});

describe('should-fix: chat, emotes, skins and seeds are rate-limited', () => {
  test('a burst of chat beyond the allowance is refused', async () => {
    const server = await start();
    const client = await sitDown(server, 'Chatty');
    for (let i = 0; i < 10; i++) sendMsg(client, { type: 'chat', text: `spam ${i}` });
    await until(client, errorCode('slowDown'));
    await new Promise((r) => setTimeout(r, 100));
    expect(client.messages.filter((m) => m.type === 'chat').length).toBeLessThanOrEqual(3);
  });

  test.each(['setSkin', 'setClientSeed', 'emote'] as const)('%s floods are refused', async (kind) => {
    const server = await start();
    const client = await sitDown(server, 'Flooder');
    const msg =
      kind === 'setSkin'
        ? { type: 'setSkin', skin: { chipStyle: 'neon', chipColour: 'blue' } }
        : kind === 'setClientSeed'
          ? { type: 'setClientSeed', seed: 'x' }
          : { type: 'emote', emote: 'gg' };
    for (let i = 0; i < 20; i++) sendMsg(client, msg);
    await until(client, errorCode('slowDown'));
  });

  test('the bucket refills', () => {
    let now = 0;
    const limits = new PlayerRateLimits(
      {
        chat: { burst: 2, everyMs: 1_000 },
        emote: { burst: 1, everyMs: 1_000 },
        setSkin: { burst: 1, everyMs: 1_000 },
        setClientSeed: { burst: 1, everyMs: 1_000 },
      },
      () => now,
    );
    expect(limits.take('p', 'chat')).toBe(true);
    expect(limits.take('p', 'chat')).toBe(true);
    expect(limits.take('p', 'chat')).toBe(false);
    now = 1_000;
    expect(limits.take('p', 'chat')).toBe(true);
    expect(limits.take('other', 'chat')).toBe(true);
  });

  test('emotes come from the fixed list only', () => {
    expect(clientMessageSchema.safeParse({ type: 'emote', emote: 'gg' }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: 'emote', emote: 'BUY CHIPS @' }).success).toBe(false);
  });

  test('chat says which seat spoke', async () => {
    const server = await start();
    const client = await sitDown(server, 'Seated');
    sendMsg(client, { type: 'sit', seat: 4, buyIn: 100 });
    await new Promise((r) => setTimeout(r, 50));
    sendMsg(client, { type: 'chat', text: 'hello' });
    const chat = await until(client, (m) => m.type === 'chat');
    expect(chat).toMatchObject({ from: 'Seated', seat: 4 });
  });
});

describe('should-fix: names', () => {
  test.each(['Seán', 'Aoife', 'Zoë', 'Björn', "O'Brien", 'Mo 2', 'Ana-María'])('%s is allowed', (name) => {
    expect(playerNameSchema.safeParse(name).success).toBe(true);
  });

  test.each([
    ['Cyrillic і look-alike', 'Kevіn'],
    ['Greek', 'Κεβιν'],
    ['emoji', 'Kevin 🃏'],
    ['punctuation only', '...'],
    ['zero-width joiner', 'Ke‍vin'],
    ['right-to-left override', '‮nivek'],
    ['too long', 'A'.repeat(17)],
  ])('%s is refused', (_label, name) => {
    expect(playerNameSchema.safeParse(name).success).toBe(false);
  });

  test('NFKC folds look-alikes and composes accents', () => {
    expect(normaliseName('Ｋｅｖｉｎ')).toBe('Kevin');
    expect(normaliseName('Seán')).toBe('Seán');
    expect(normaliseName('O’Brien')).toBe("O'Brien");
    expect(normaliseName('  Mo   Dee ')).toBe('Mo Dee');
  });

  test('names are unique ignoring case', async () => {
    const server = await start();
    await sitDown(server, 'Kevin');
    const second = await sitDown(server, 'kevin');
    const welcome = second.messages.find((m) => m.type === 'welcome');
    expect(welcome).toBeDefined();
    expect(server.table.playerByName('kevin')).toBeUndefined();
    expect(server.table.playerByName('kevin 2')).toBeDefined();
  });

  test('a refused name gets a message that says why', async () => {
    const server = await start();
    const client = await connect(server.ws);
    sendMsg(client, { type: 'join', inviteCode: INVITE, name: 'Kevіn' });
    const refusal = await until(client, errorCode('badName'));
    expect(refusal).toMatchObject({ type: 'error' });
  });
});

describe('should-fix: search engines and headers', () => {
  test('robots.txt disallows everything', async () => {
    const server = await start();
    const response = await fetch(`${server.http}/robots.txt`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('User-agent: *\nDisallow: /\n');
  });

  test('every response says noindex and carries a CSP', async () => {
    const server = await start();
    for (const path of ['/api/health', '/api/history', '/robots.txt', '/nope']) {
      const response = await fetch(server.http + path);
      expect(response.headers.get('x-robots-tag')).toContain('noindex');
    }
    const health = await fetch(`${server.http}/api/health`);
    const csp = health.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toMatch(/connect-src 'self' wss:\/\/127\.0\.0\.1:\d+ ws:\/\/127\.0\.0\.1:\d+/);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('query strings never reach the log', () => {
    expect(redactUrl('/api/history?code=SECRET')).toBe('/api/history?[redacted]');
    expect(redactUrl('/?invite=SECRET')).toBe('/?[redacted]');
    expect(redactUrl('/api/health')).toBe('/api/health');
  });
});

describe('should-fix: history reads', () => {
  test('history is loaded once and served from memory, capped at 200', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'felt-hist-'));
    const file = join(dir, 'history.jsonl');
    const lines = Array.from({ length: 250 }, (_, i) =>
      JSON.stringify({ ...SAMPLE_HAND, handId: `h-${i + 1}`, handNumber: i + 1 }),
    );
    writeFileSync(file, lines.join('\n') + '\n');
    const history = new HandHistory(file);
    await history.load();
    const recent = history.recent(200);
    expect(recent).toHaveLength(200);
    expect(recent[0]?.handId).toBe('h-51');
    expect(recent[199]?.handId).toBe('h-250');
    expect((await history.find('h-3'))?.handNumber).toBe(3);
    expect((await history.find('nope'))).toBeUndefined();
  });

  test('/api/fairness counts the last 200 hands, not the whole file', async () => {
    const server = await start();
    const response = await fetch(`${server.http}/api/fairness`, { headers: { 'x-felt-code': INVITE } });
    expect(response.status).toBe(200);
    expect((await response.json()) as { handsDealt: number }).toMatchObject({ handsDealt: 1 });
  });
});
