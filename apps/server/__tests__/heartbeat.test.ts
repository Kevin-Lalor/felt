// The heartbeat (going online, 11 Oct 2026). Cloudflare closes idle sockets,
// and a phone that drops off wifi leaves sockets that never say they closed.
// The server pings; whatever stops answering is terminated and goes down the
// ordinary disconnect path (HOUSE-RULES #8, #9).
//
// Browsers and Node's own WebSocket answer pings automatically, so they cannot
// play the part of a dead phone. The silent client below speaks just enough
// WebSocket over a raw TCP socket to join and sit — and never answers a ping.

import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { connect as tcpConnect } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerMessage } from '@poker/protocol';
import { buildApp } from '../src/app.js';
import { HandHistory } from '../src/history.js';
import { Table } from '../src/table.js';

const INVITE = 'INVITE-CODE-0001';
const HOST = 'HOST-CODE-000001';
const HEARTBEAT_MS = 100;

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(): Promise<{ port: number; table: Table }> {
  const dir = mkdtempSync(join(tmpdir(), 'felt-beat-'));
  const history = new HandHistory(join(dir, 'history.jsonl'));
  const table = new Table(
    { tableName: 't', smallBlind: 1, bigBlind: 2, ante: 0, minBuyIn: 10, maxBuyIn: 400 },
    (r) => history.append(r),
  );
  app = await buildApp({
    inviteCode: INVITE,
    hostCode: HOST,
    tableName: 't',
    table,
    history,
    logger: false,
    heartbeatMs: HEARTBEAT_MS,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { port: address.port, table };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A WebSocket client that never answers a ping — a phone that went away
 *  without closing anything. Text frames only; enough to join and sit. */
async function silentClient(port: number) {
  const tcp: Socket = tcpConnect(port, '127.0.0.1');
  const texts: ServerMessage[] = [];
  let pings = 0;
  const closed = new Promise<void>((resolve) => tcp.on('close', () => resolve()));
  await new Promise<void>((resolve) => tcp.on('connect', () => resolve()));
  tcp.write(
    'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
  );
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  tcp.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      upgraded = true;
      buffer = buffer.subarray(end + 4);
    }
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = (buffer[0] ?? 0) & 0x0f;
      let length = (buffer[1] ?? 0) & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x1) texts.push(JSON.parse(payload.toString('utf8')) as ServerMessage);
      if (opcode === 0x9) pings += 1; // and pointedly do not pong
    }
  });
  const sendText = (msg: unknown): void => {
    const payload = Buffer.from(JSON.stringify(msg), 'utf8');
    const mask = Buffer.from([1, 2, 3, 4]);
    const header =
      payload.length < 126
        ? Buffer.from([0x81, 0x80 | payload.length])
        : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    const masked = Buffer.from(payload.map((b, i) => b ^ (mask[i % 4] ?? 0)));
    tcp.write(Buffer.concat([header, mask, masked]));
  };
  return { texts, sendText, closed, pings: () => pings, tcp };
}

async function browserLike(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages: ServerMessage[] = [];
  socket.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data)) as ServerMessage));
  await new Promise<void>((r) => socket.addEventListener('open', () => r()));
  return { socket, messages };
}

describe('heartbeat', () => {
  test('a socket that stops answering pings is closed, and its player is sat out', async () => {
    const { port, table } = await start();
    const phone = await silentClient(port);
    phone.sendText({ type: 'join', inviteCode: INVITE, name: 'Phone' });
    await wait(50);
    const welcome = phone.texts.find((m) => m.type === 'welcome');
    if (!welcome || welcome.type !== 'welcome') throw new Error('did not join');
    phone.sendText({ type: 'sit', seat: 0, buyIn: 100 });
    await wait(30);
    expect(table.viewFor(null).seats[0]?.connected).toBe(true);

    const started = Date.now();
    await phone.closed;
    const tookMs = Date.now() - started;
    await wait(30); // the server handles its side of the close a moment later
    expect(phone.pings()).toBeGreaterThan(0);
    // Gone within two heartbeats: one ping unanswered, then terminated.
    expect(tookMs).toBeLessThan(HEARTBEAT_MS * 3 + 100);
    // No live hand, so the ordinary disconnect path sits them out (#8).
    const seat = table.viewFor(null).seats[0];
    expect(seat?.connected).toBe(false);
    expect(seat?.away).toBe('sittingOut');
    expect(seat?.stack).toBe(100); // seat and chips kept (#6)
  });

  test('holding cards when the socket dies: the clock still runs, as for any disconnect (#9)', async () => {
    const { port, table } = await start();
    const host = await browserLike(port);
    host.socket.send(JSON.stringify({ type: 'join', inviteCode: HOST, name: 'Kev' }));
    const phone = await silentClient(port);
    phone.sendText({ type: 'join', inviteCode: INVITE, name: 'Phone' });
    await wait(50);
    host.socket.send(JSON.stringify({ type: 'sit', seat: 0, buyIn: 100 }));
    phone.sendText({ type: 'sit', seat: 1, buyIn: 100 });
    await wait(50);
    host.socket.send(JSON.stringify({ type: 'startHand' }));
    await wait(50);
    expect(table.handInProgress()).toBe(true);
    await phone.closed;
    await wait(30);
    const view = table.viewFor(null);
    expect(view.seats[1]?.connected).toBe(false);
    expect(view.seats[1]?.hasCards).toBe(true); // nothing folded early
    expect(view.seats[1]?.away).toBe('no'); // sat out only when the clock runs out
    host.socket.close();
  });

  test('a client that answers stays connected through many heartbeats', async () => {
    const { port, table } = await start();
    const client = await browserLike(port);
    client.socket.send(JSON.stringify({ type: 'join', inviteCode: INVITE, name: 'Awake' }));
    await wait(HEARTBEAT_MS * 8);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(table.playerByName('Awake')?.connected).toBe(true);
    client.socket.close();
  });

  test('an old socket closing after the player rejoined elsewhere does not disconnect them', async () => {
    // Phone moves from wifi to mobile data: it rejoins on a new socket with
    // its token while the old one is still half-open. When the heartbeat (or
    // anything) closes the old one, that must not mark the player away.
    const { port, table } = await start();
    const onWifi = await silentClient(port);
    onWifi.sendText({ type: 'join', inviteCode: INVITE, name: 'Mover' });
    await wait(50);
    const welcome = onWifi.texts.find((m) => m.type === 'welcome');
    if (!welcome || welcome.type !== 'welcome') throw new Error('did not join');
    onWifi.sendText({ type: 'sit', seat: 2, buyIn: 100 });
    await wait(30);

    const onMobile = await browserLike(port);
    onMobile.socket.send(
      JSON.stringify({ type: 'join', inviteCode: INVITE, name: 'Mover', playerToken: welcome.playerToken }),
    );
    await wait(50);
    await onWifi.closed; // the heartbeat terminates the dead one
    await wait(30);
    const seat = table.viewFor(null).seats[2];
    expect(seat?.connected).toBe(true);
    expect(seat?.away).toBe('no');
    onMobile.socket.close();
  });
});
