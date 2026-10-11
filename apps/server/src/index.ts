// FELT server entry point: read the environment, build the app, listen.
// Invite-only: every join must present the invite code (or host code). This
// sits behind a Cloudflare Tunnel with Cloudflare Access in front for internet
// play — see docs/SECURITY-SETUP.md.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { ConfigError, resolveCodes } from './config.js';
import { HandHistory } from './history.js';
import { Table } from './table.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env['PORT'] ?? 8090);
// Loopback only by default. cloudflared runs on this machine and connects to
// localhost, so nothing else needs to reach the server directly — and anything
// that could (any device on the home network) would walk straight past the
// Cloudflare Access login. Set HOST=0.0.0.0 deliberately for LAN testing.
const HOST = process.env['HOST'] ?? '127.0.0.1';
const TABLE_NAME = process.env['TABLE_NAME'] ?? "Kevin's Home Game";

// No default code in source. This repo is public, so a hardcoded fallback would
// be the working code to a live table for anyone who reads it. Unset means a
// strong random one per boot, printed below; set means it must be a real code.
let codes;
try {
  codes = resolveCodes(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`\n  FELT will not start: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

const history = new HandHistory(join(HERE, '..', 'data', 'history.jsonl'));
await history.load();

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
  (show) => history.appendShow(show),
);

const maxConnections = Number(process.env['MAX_CONNECTIONS_PER_IP'] ?? 8);
const maxPlayers = Number(process.env['MAX_PLAYERS_PER_IP'] ?? 4);

const app = await buildApp({
  inviteCode: codes.inviteCode,
  hostCode: codes.hostCode,
  tableName: TABLE_NAME,
  table,
  history,
  webDist: join(HERE, '..', '..', 'web', 'dist'),
  ...(Number.isInteger(maxConnections) && maxConnections > 0
    ? { maxConnectionsPerClient: maxConnections }
    : {}),
  ...(Number.isInteger(maxPlayers) && maxPlayers > 0 ? { maxPlayersPerClient: maxPlayers } : {}),
});

await app.listen({ port: PORT, host: HOST });

// Printed once, here, and nowhere else: not into the request log, not into a
// file. Generated codes change every restart; set INVITE_CODE and HOST_CODE in
// the environment to keep them.
console.log('');
console.log('  ♠ FELT is running');
console.log(`  table:       ${TABLE_NAME}`);
console.log(`  listening:   http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`);
console.log(
  `  invite code: ${codes.inviteCode}   (share this with friends)${codes.generated.invite ? '  [random — new every restart]' : ''}`,
);
console.log(
  `  host code:   ${codes.hostCode}   (keep this one — it makes you host)${codes.generated.host ? '  [random — new every restart]' : ''}`,
);
console.log('');
