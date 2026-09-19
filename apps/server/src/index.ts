// FELT server: Fastify for HTTP (static app + history API), ws for the table.
// Invite-only: every join must present the invite code (or host code). Layer
// this behind a Cloudflare Tunnel for internet play — see docs/SECURITY-SETUP.md.

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { clientMessageSchema } from '@poker/protocol';
import type { ServerMessage } from '@poker/protocol';
import { Table } from './table.js';
import { HandHistory } from './history.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env['PORT'] ?? 8090);
const HOST = process.env['HOST'] ?? '0.0.0.0';
const INVITE_CODE = process.env['INVITE_CODE'] ?? 'KYL37';
const HOST_CODE = process.env['HOST_CODE'] ?? randomBytes(4).toString('hex').toUpperCase();
const TABLE_NAME = process.env['TABLE_NAME'] ?? "Kevin's Home Game";

const history = new HandHistory(join(HERE, '..', 'data', 'history.jsonl'));
const table = new Table(
  {
    tableName: TABLE_NAME,
    smallBlind: Number(process.env['SMALL_BLIND'] ?? 1),
    bigBlind: Number(process.env['BIG_BLIND'] ?? 2),
    ante: Number(process.env['ANTE'] ?? 0),
    minBuyIn: Number(process.env['MIN_BUYIN'] ?? 100),
    maxBuyIn: Number(process.env['MAX_BUYIN'] ?? 400),
  },
  (record) => history.append(record),
);

const app = Fastify({ logger: { level: 'info' } });

await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 } });

// Serve the built web app when present (pnpm --filter @poker/web build).
const webDist = join(HERE, '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
}

app.get('/api/health', async () => ({ ok: true, table: TABLE_NAME }));

// Hand histories are public TO THE TABLE — not to the internet. The WebSocket
// has always required the invite code; these routes did not, so behind a public
// tunnel URL they served every hole card, client seed and revealed server seed
// to anyone holding the link.
app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/history') && !req.url.startsWith('/api/fairness')) return;
  const url = new URL(req.url, 'http://local');
  const code = url.searchParams.get('code') ?? String(req.headers['x-felt-code'] ?? '');
  if (code === INVITE_CODE || code === HOST_CODE) return;
  return reply.code(401).send({ error: 'invite code required' });
});

app.get('/api/history', async () => history.readAll().slice(-200));
app.get('/api/history/:handId', async (req, reply) => {
  const { handId } = req.params as { handId: string };
  const record = history.find(handId);
  if (!record) return reply.code(404).send({ error: 'no such hand' });
  return record;
});

// Simple fairness dashboard numbers (χ² page grows from here).
app.get('/api/fairness', async () => {
  const hands = history.readAll();
  let pocketPairs = 0;
  let holeHands = 0;
  for (const hand of hands) {
    for (const seat of hand.seats) {
      if (seat.holeCards.length === 2) {
        holeHands += 1;
        if (seat.holeCards[0]?.[0] === seat.holeCards[1]?.[0]) pocketPairs += 1;
      }
    }
  }
  return {
    handsDealt: hands.length,
    holeHandsDealt: holeHands,
    pocketPairs,
    pocketPairRate: holeHands > 0 ? pocketPairs / holeHands : null,
    pocketPairExpected: 3 / 51, // ≈ 5.88%
  };
});

app.register(async (scope) => {
  scope.get('/ws', { websocket: true }, (socket) => {
    let playerId: string | null = null;

    const send = (msg: ServerMessage): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    socket.on('message', (raw: Buffer | string) => {
      let json: unknown;
      try {
        json = JSON.parse(String(raw));
      } catch {
        send({ type: 'error', code: 'badJson', message: 'Malformed message.' });
        return;
      }
      // Parse FIRST, then auth, then turn checks (hard rule 6).
      const parsed = clientMessageSchema.safeParse(json);
      if (!parsed.success) {
        send({ type: 'error', code: 'badMessage', message: 'Invalid message shape.' });
        return;
      }
      const msg = parsed.data;

      if (msg.type === 'join') {
        const isHost = msg.inviteCode === HOST_CODE;
        if (!isHost && msg.inviteCode !== INVITE_CODE) {
          send({ type: 'error', code: 'badInvite', message: 'Wrong invite code.' });
          socket.close();
          return;
        }
        const player = table.join({
          name: msg.name,
          avatar: msg.avatar ?? 0,
          clientSeed: msg.clientSeed,
          isHost,
          existingToken: msg.playerToken,
          send,
        });
        playerId = player.playerId;
        send({
          type: 'welcome',
          playerId: player.playerId,
          playerToken: player.token,
          tableName: TABLE_NAME,
          isHost: player.isHost,
        });
        send({ type: 'state', view: table.viewFor(player.playerId) });
        return;
      }

      if (playerId === null) {
        send({ type: 'error', code: 'joinFirst', message: 'Join with the invite code first.' });
        return;
      }

      if (msg.type === 'chat') {
        const player = table.getPlayer(playerId);
        if (player) {
          table.sendToAll({
            type: 'chat',
            from: player.name,
            seat: null,
            text: msg.text,
            at: Date.now(),
          });
        }
        return;
      }
      if (msg.type === 'emote') {
        const player = table.getPlayer(playerId);
        if (player) {
          table.sendToAll({
            type: 'emote',
            from: player.name,
            seat: null,
            emote: msg.emote.slice(0, 16),
            at: Date.now(),
          });
        }
        return;
      }

      const errorReply = table.handle(playerId, msg);
      if (errorReply) send(errorReply);
    });

    socket.on('close', () => {
      if (playerId !== null) table.disconnect(playerId);
    });
  });
});

await app.listen({ port: PORT, host: HOST });

console.log('');
console.log('  ♠ FELT is running');
console.log(`  table:       ${TABLE_NAME}`);
console.log(`  local:       http://localhost:${PORT}`);
console.log(`  invite code: ${INVITE_CODE}   (share this with friends)`);
console.log(`  host code:   ${HOST_CODE}   (keep this one — it makes you host)`);
console.log('');
