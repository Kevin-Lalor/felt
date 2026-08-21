# Architecture

## Principles

1. **The server is the only thing that knows the truth.** Clients render and send intents.
2. **The engine knows nothing about the outside world.** Pure functions in, new state out.
3. **Fairness is verifiable, not asserted.** Anything a player has to take on trust is a design bug.
4. **Everything visual is a token.** Nothing is hardcoded, so everything is themeable.

## Layers

```
┌───────────────────────────────────────────────────────────────┐
│  apps/web            React 19 PWA. Zustand store mirrors the  │
│                      redacted state it is sent. Sends intents.│
└──────────────────────────┬────────────────────────────────────┘
                           │  WebSocket (cookie-authenticated)
                           │  every frame: Zod-validated
┌──────────────────────────┴────────────────────────────────────┐
│  apps/server                                                  │
│    auth/       passkeys, invite tokens, sessions, allowlist   │
│    table/      authoritative TableState per table             │
│    redact.ts   ← THE choke point. Nothing broadcasts around it │
│    fairness/   serverSeed, commit, reveal, deck derivation    │
│    db/         Drizzle + SQLite. Hands, players, audit log    │
│    admin/      chip adjustments (logged + publicly visible)   │
└──────────────────────────┬────────────────────────────────────┘
                           │  pure function calls
┌──────────────────────────┴────────────────────────────────────┐
│  packages/engine     applyAction(state, action) → {state,events}│
│                      No I/O. No randomness. No time.           │
└───────────────────────────────────────────────────────────────┘
```

`packages/protocol` is shared by web and server — one Zod schema set, so the contract cannot drift.
`packages/tokens` is consumed by web at build time and emitted as CSS custom properties.

## One action, end to end

1. Player taps Raise 400. Client sends `{type:'action', handId, seat, action:{kind:'raise', to:400}}`.
2. Server Zod-parses the frame. Malformed → typed protocol error, connection kept.
3. Server checks: valid session → seat belongs to this user → it is this seat's turn → hand id
   matches the live hand. Any failure → typed error, no state change.
4. Server calls `applyAction(tableState, action)`. The engine validates poker legality (is 400 a
   legal raise size?) and returns either a new state + event list, or a typed rejection.
5. Server persists the action and any resulting events.
6. Server runs `redact(newState, seat)` for each connected seat and broadcasts each its own view.
7. Clients animate from the events. **Clients never compute outcomes** — they are told.

## Persistence

SQLite via `better-sqlite3` + Drizzle. One file. At nine players this is comfortably fast and
removes an entire class of operational problems. Litestream replicates continuously; a nightly
snapshot is kept for 7 days.

Core tables: `users`, `allowlist`, `invites`, `sessions`, `credentials` (passkeys), `tables`,
`hands`, `hand_actions`, `hand_seeds` (commit/reveal), `chip_adjustments`, `audit_log`,
`cosmetics`, `player_skins`, `table_themes`.

`hands` + `hand_actions` + `hand_seeds` together are enough to fully reconstruct and verify any
hand ever played. That is the replayer and the verifier and the stats page, all from one source.

## Realtime

Raw `ws` with a small typed protocol. One connection per client, one room per table. Server
pushes; the client's only outbound messages are intents, seed changes, chat/emote, and heartbeats.

Consider Colyseus if room lifecycle management becomes tedious — but its state-sync model would
need careful handling to preserve rule 2 (redaction), so raw `ws` is the safer default here.

## Deployment

Home machine → `cloudflared` tunnel → Cloudflare (TLS, Access email allowlist) → the internet.
Zero inbound ports open. See `docs/SECURITY-SETUP.md`.
