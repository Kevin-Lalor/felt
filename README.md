# ♠ FELT — home-game poker

Private, invite-only, **play-money** No-Limit Hold'em for 6–9 friends. Self-hosted,
provably fair, nothing to download — friends join from a link on their phone.

**Fairness is the product**: every shuffle is commit-reveal (the server publishes a hash
of its seed *before* dealing, and every player's own seed goes into the deck derivation),
every finished hand's history is open to everyone at the table (seeds and all, with only the
hole cards that were shown), every chip adjustment is logged in the open,
and a standalone verifier lets any suspicious friend re-derive any deck ever dealt.

**Start with [`CLAUDE.md`](./CLAUDE.md).** It is the contract for how this codebase works.

- [Architecture](./docs/ARCHITECTURE.md) · [House rules](./docs/HOUSE-RULES.md) ·
  [Engine spec](./docs/ENGINE-SPEC.md) · [Fairness protocol](./docs/FAIRNESS.md) ·
  [Security setup](./docs/SECURITY-SETUP.md) · [Rollback](./ROLLBACK.md)

## Status

Playable cash game, implemented and verified end-to-end:

| Piece | State |
|---|---|
| `packages/engine` | Full NLHE: betting, min-raise rules, short all-in (no reopen), side pots, split pots + odd chip, heads-up blinds, antes, hand evaluator validated against an oracle on 200k hands. Pure TS, zero deps, 140 tests incl. fast-check property suites (chip conservation at 20k random hands). |
| `packages/protocol` | Zod schemas for every client↔server message. |
| `packages/tokens` | Design tokens → CSS custom properties, 4 table themes. |
| `apps/server` | Fastify + WebSocket authoritative server: per-seat **redaction** (opponent hole cards are absent from payloads, enforced by a 5k-hand leak fuzzer), commit-reveal shuffle, invite-code gate behind Cloudflare Access, host controls (remove a player, pause dealing), sit out / wait for BB, action clock with auto check/fold, public chip log, JSONL hand histories, history/fairness APIs. |
| `apps/web` | React 19 + Vite PWA: join screen, live table (9 seats, you anchored bottom-centre), action bar with pot odds + sizing presets + keyboard shortcuts (F/C/R/A), chat + emotes, show-one-card after folds, Fair tab (commit/seeds/reveal), hand history browser, Settings (felt themes, card backs, chips, display). |
| `tools/verify-hand.ts` | Independent re-implementation of the shuffle derivation — verifies any recorded hand offline. |

Not built yet (see the build plan): tournaments, SQLite persistence (histories are JSONL and
table state is in memory — a restart forgets the table), Playwright e2e.

Not planned: app-level accounts or passkeys. Cloudflare Access is the login and the invite code
is the second lock behind it — see [ADR 0002](./docs/adr/0002-cloudflare-access-is-the-login.md).

## Run it

Requires Node ≥ 22 and pnpm 9 (`npm i -g pnpm@9`).

```bash
pnpm install
pnpm tokens                      # design tokens → CSS
pnpm --filter @poker/web build   # build the client
pnpm --filter @poker/server start
```

The server prints your two codes at startup:

```
invite code: H4RV9WNC2TZEPK6M   (share this with friends)  [random — new every restart]
host code:   D8SGJ3YBX5FQA7NR   (keep this one — it makes you host)  [random — new every restart]
```

(Those two are made-up examples of the format, not codes to any table.) Left unset, both codes
are random 16-character strings, new on every start. To keep them across restarts, set
`INVITE_CODE` and `HOST_CODE` — each at least 12 characters, and different from each other, or
the server refuses to start. Never commit the ones you play with.

Open http://localhost:8090, join with the **host code**, tap a seat, buy in.
The host deals the first hand; every following hand deals itself.

The server listens on `127.0.0.1` only, so other devices — even on your own Wi-Fi — can't reach
it directly. That is deliberate: the only way in should be through Cloudflare Access (below).
For a quick test on the LAN you can start it with `HOST=0.0.0.0`, but that skips the Access
login for anyone on your network, so never leave it that way on a game night.

Configuration (blinds, buy-ins, table name, fixed codes, host address) via env — see
`.env.example`.

For development: `pnpm dev` runs the server (hot reload) and Vite together;
the web dev server on :5173 proxies to the game server on :8090.

## Play with friends over the internet

Follow [`docs/SECURITY-SETUP.md`](./docs/SECURITY-SETUP.md) — it is the runbook, and the
order matters. In short:

1. A **named Cloudflare Tunnel** on your own domain. No ports opened on the router, your home
   IP never exposed.
2. **Cloudflare Access** in front of the whole hostname, *before* anyone gets the link: an email
   allowlist with a one-time PIN as the login. This is the front door.
3. The **invite code** as the second lock behind it.

Then text your friends the URL and the invite code. On a phone, "Add to Home Screen" installs
it as an app. Removing someone for good means taking their email off the Access allowlist; the
in-game Remove only lasts until the server restarts.

Don't use a quick `trycloudflare.com` tunnel for real games: it has no Access login in front,
which leaves the invite code as the only lock.

## Trust, but verify

- **Fair tab in-app**: the pre-deal commitment, every player's seed, and the post-hand
  reveal for the current session. Set your own seed any time.
- **Offline**: `pnpm verify-hand 214` re-derives hand #214's entire deck from the
  revealed seeds and checks it against what was actually dealt. The verifier shares no
  code with the server — see `docs/FAIRNESS.md`.
- **Histories**: `GET /api/history` (needs the invite or host code) — every recent hand with
  its commitment, seeds and reveal, downloadable. Hole cards appear only where they were shown
  at showdown or by choice; folded and mucked cards stay private.

## Tests

```bash
pnpm test            # everything
pnpm test:engine     # fast engine suite — run constantly
pnpm test:property   # fast-check at full depth (20k hands) + 200k-hand oracle run
pnpm test:leak       # redaction fuzzer at 5,000 hands
pnpm typecheck && pnpm lint
```

CI (GitHub Actions) runs typecheck, lint, tests, build, a `Math.random` ban grep,
a skipped-fairness-test grep, the property + leak suites, an engine coverage gate,
and an independent Claude reviewer on every PR.
