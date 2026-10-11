// The HTTP and WebSocket surface, built as a function so tests can stand up a
// real server on a random port and attack it the way a browser would.
// index.ts reads the environment, builds this, and listens.

import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { NAME_RULES_MESSAGE, clientMessageSchema } from '@poker/protocol';
import type { ServerMessage } from '@poker/protocol';
import { codeMatches } from './config.js';
import type { HandHistory } from './history.js';
import {
  CodeGuard,
  ConnectionCounter,
  DEFAULT_LOCKOUT,
  DEFAULT_RATES,
  PlayerRateLimits,
  clientAddress,
} from './limits.js';
import type { LockoutPolicy, Rate, ThrottledMessage } from './limits.js';
import type { Table } from './table.js';

export type AppOptions = {
  inviteCode: string;
  hostCode: string;
  tableName: string;
  table: Table;
  history: HandHistory;
  /** Built web app to serve, when it exists. */
  webDist?: string;
  /** Fastify logger setting; tests pass false. */
  logger?: boolean;
  lockout?: LockoutPolicy;
  rates?: Record<ThrottledMessage, Rate>;
  maxConnectionsPerClient?: number;
  /** How long a socket may stay open without joining. */
  joinTimeoutMs?: number;
};

/** The history API serves the same window it always has. */
const HISTORY_LIMIT = 200;

/** Header the web app sends the table code in. Never the query string: query
 *  strings land in access logs, browser history and Referer headers. */
export const CODE_HEADER = 'x-felt-code';

/** Everything after `?` is dropped before a URL reaches the log. Codes used to
 *  arrive as ?code=, and an old bookmark or a stale client could still send
 *  one — it should not end up on disk either way. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?[redacted]`;
}

/** Hosts we will name in the CSP's connect-src. A Host header is
 *  attacker-chosen, so anything that is not a plain host[:port] is ignored. */
const SAFE_HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { inviteCode, hostCode, tableName, table, history } = options;
  const guard = new CodeGuard(options.lockout ?? DEFAULT_LOCKOUT);
  const rateLimits = new PlayerRateLimits(options.rates ?? DEFAULT_RATES);
  const connections = new ConnectionCounter(options.maxConnectionsPerClient ?? 8);
  const joinTimeoutMs = options.joinTimeoutMs ?? 10_000;

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: 'info',
            serializers: {
              req(req) {
                return {
                  method: req.method,
                  url: redactUrl(req.url),
                  remoteAddress: req.ip,
                };
              },
            },
          },
  });

  const clientOf = (req: FastifyRequest): string =>
    clientAddress(req.socket.remoteAddress, req.headers['cf-connecting-ip']);

  // ------------------------------------------------------------ headers

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        // The Vite build is external module scripts and one stylesheet; no
        // inline <script> or <style>. React's style={{…}} props are applied
        // through the CSSOM, which style-src does not govern.
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        manifestSrc: ["'self'"],
        // 'self' covers ws:/wss: to the same host in current browsers, but
        // older Safari read it as http(s) only — and half the table is on an
        // iPhone. Naming this host's socket explicitly costs nothing.
        connectSrc: [
          "'self'",
          (req) => {
            const host = (req as { headers: Record<string, string | string[] | undefined> }).headers[
              'host'
            ];
            return typeof host === 'string' && SAFE_HOST.test(host)
              ? `wss://${host} ws://${host}`
              : '';
          },
        ],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // Cloudflare terminates TLS; on a LAN test over plain http this header
    // would be ignored anyway. includeSubDomains is off so it cannot affect
    // anything else Kevin hosts on the same domain.
    hsts: { maxAge: 15_552_000, includeSubDomains: false },
    crossOriginEmbedderPolicy: false,
  });

  // Nothing here is for search engines: no page of it should ever be indexed,
  // whatever links to it. robots.txt asks politely; this header insists.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  });

  app.get('/robots.txt', async (_req, reply) => {
    reply.type('text/plain; charset=utf-8');
    return 'User-agent: *\nDisallow: /\n';
  });

  await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 } });

  if (options.webDist && existsSync(options.webDist)) {
    await app.register(fastifyStatic, { root: options.webDist });
  }

  app.get('/api/health', async () => ({ ok: true, table: tableName }));

  // ------------------------------------------------------------ history

  // Hand histories are public TO THE TABLE — not to the internet. The check is
  // attached to each route, so it runs on whatever Fastify actually routed
  // here. It used to be a prefix match on the raw URL in a global hook, and
  // Fastify decodes the path before routing: /api/%68istory skipped the check
  // and still landed on /api/history, serving every hole card ever dealt.
  const requireTableCode = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const client = clientOf(req);
    const locked = guard.lockedFor(client);
    if (locked > 0) {
      reply.header('Retry-After', String(Math.ceil(locked / 1000)));
      await reply.code(429).send({ error: 'Too many wrong codes. Try again later.' });
      return;
    }
    const header = req.headers[CODE_HEADER];
    const code = typeof header === 'string' ? header : '';
    if (code.length > 0 && (codeMatches(code, inviteCode) || codeMatches(code, hostCode))) {
      guard.succeed(client);
      return;
    }
    // A request with no code at all is not a guess, so it costs nothing. A
    // wrong one counts against the same budget as a wrong join.
    if (code.length > 0) guard.fail(client);
    await reply.code(401).send({ error: 'invite code required' });
  };

  app.get('/api/history', { preHandler: requireTableCode }, async () =>
    history.recent(HISTORY_LIMIT),
  );

  app.get('/api/history/:handId', { preHandler: requireTableCode }, async (req, reply) => {
    const { handId } = req.params as { handId: string };
    const record = await history.find(handId);
    if (!record) return reply.code(404).send({ error: 'no such hand' });
    return record;
  });

  // Simple fairness dashboard numbers (χ² page grows from here). Same window
  // as /api/history — it used to parse the entire file on every request.
  app.get('/api/fairness', { preHandler: requireTableCode }, async () => {
    const hands = history.recent(HISTORY_LIMIT);
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

  // ------------------------------------------------------------ the table

  app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (socket, req) => {
      const client = clientOf(req);
      let playerId: string | null = null;

      const send = (msg: ServerMessage): void => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      const refuse = (code: string, message: string): void => {
        send({ type: 'error', code, message });
        socket.close(1008, code);
      };

      if (!connections.tryOpen(client)) {
        // Not counted as open, so not released on close either.
        refuse('tooManyConnections', 'Too many connections from your network. Close a tab and retry.');
        return;
      }
      let counted = true;

      // A socket that never joins is holding a slot for nothing.
      const joinTimer = setTimeout(() => {
        if (playerId === null) refuse('joinTimeout', 'Join with the invite code first.');
      }, joinTimeoutMs);

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
          const badName = parsed.error.issues.some((issue) => issue.path[0] === 'name');
          if (badName) {
            send({ type: 'error', code: 'badName', message: NAME_RULES_MESSAGE });
          } else {
            send({ type: 'error', code: 'badMessage', message: 'Invalid message shape.' });
          }
          return;
        }
        const msg = parsed.data;

        if (msg.type === 'join') {
          // One connection, one player. Nine joins down one socket used to
          // seat nine players, so one person could fill the table.
          if (playerId !== null) {
            send({ type: 'error', code: 'alreadyJoined', message: 'This connection already has a player.' });
            return;
          }
          const locked = guard.lockedFor(client);
          if (locked > 0) {
            refuse(
              'tooManyAttempts',
              `Too many wrong codes. Try again in ${Math.ceil(locked / 60_000)} minutes.`,
            );
            return;
          }
          const isHost = codeMatches(msg.inviteCode, hostCode);
          if (!isHost && !codeMatches(msg.inviteCode, inviteCode)) {
            guard.fail(client);
            refuse('badInvite', 'Wrong invite code.');
            return;
          }
          guard.succeed(client);
          clearTimeout(joinTimer);
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
            tableName,
            isHost: player.isHost,
          });
          send({ type: 'state', view: table.viewFor(player.playerId) });
          return;
        }

        if (playerId === null) {
          send({ type: 'error', code: 'joinFirst', message: 'Join with the invite code first.' });
          return;
        }

        if (
          (msg.type === 'chat' ||
            msg.type === 'emote' ||
            msg.type === 'setSkin' ||
            msg.type === 'setClientSeed') &&
          !rateLimits.take(playerId, msg.type)
        ) {
          send({ type: 'error', code: 'slowDown', message: 'Slow down a little.' });
          return;
        }

        if (msg.type === 'chat') {
          const player = table.getPlayer(playerId);
          if (player) {
            table.sendToAll({
              type: 'chat',
              from: player.name,
              seat: table.seatNumberOf(playerId),
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
              seat: table.seatNumberOf(playerId),
              emote: msg.emote,
              at: Date.now(),
            });
          }
          return;
        }

        const errorReply = table.handle(playerId, msg);
        if (errorReply) send(errorReply);
      });

      socket.on('close', () => {
        clearTimeout(joinTimer);
        if (counted) {
          counted = false;
          connections.close(client);
        }
        if (playerId !== null) table.disconnect(playerId);
      });
    });
  });

  return app;
}
