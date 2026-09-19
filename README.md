# ♠ FELT — home-game poker

Private, invite-only, **play-money** No-Limit Hold'em for 6–9 friends. Self-hosted,
provably fair, nothing to download — friends join from a link on their phone.

**Fairness is the product**: every shuffle is commit-reveal (the server publishes a hash
of its seed *before* dealing, and every player's own seed goes into the deck derivation),
every hand history is public after the hand, every chip adjustment is logged in the open,
and a standalone verifier lets any suspicious friend re-derive any deck ever dealt.

**Start with [`CLAUDE.md`](./CLAUDE.md).** It is the contract for how this codebase works.

- [Architecture](./docs/ARCHITECTURE.md) · [House rules](./docs/HOUSE-RULES.md) ·
  [Engine spec](./docs/ENGINE-SPEC.md) · [Fairness protocol](./docs/FAIRNESS.md) ·
  [Security setup](./docs/SECURITY-SETUP.md) · [Rollback](./ROLLBACK.md)

## Status

Playable cash game, implemented and verified end-to-end:

| Piece | State |
|---|---|
| `packages/engine` | Full NLHE: betting, min-raise rules, short all-in (no reopen), side pots, split pots + odd chip, heads-up blinds, antes, hand evaluator validated against an oracle on 200k hands. Pure TS, zero deps, 58 tests incl. fast-check property suites (chip conservation at 20k random hands). |
| `packages/protocol` | Zod schemas for every client↔server message. |
| `packages/tokens` | Design tokens → CSS custom properties, 4 table themes. |
| `apps/server` | Fastify + WebSocket authoritative server: per-seat **redaction** (opponent hole cards are absent from payloads, enforced by a 5k-hand leak fuzzer), commit-reveal shuffle, invite-code gate, action clock with auto check/fold, public chip log, JSONL hand histories, history/fairness APIs. |
| `apps/web` | React 19 + Vite PWA: join screen, live table (9 seats, you anchored bottom-centre), action bar with pot odds + sizing presets + keyboard shortcuts (F/C/R/A), chat + emotes, show-one-card after folds, Fair tab (commit/seeds/reveal), public hand history browser. |
| `tools/verify-hand.ts` | Independent re-implementation of the shuffle derivation — verifies any recorded hand offline. |

Not built yet (see the build plan): passkeys + Cloudflare Access hardening, tournaments,
cosmetic packs/themes UI, SQLite persistence (histories are JSONL), Playwright e2e.

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
invite code: 7F3A91     (share this with friends)
host code:   A1B2C3D4   (keep this one — it makes you host)
```

Open http://localhost:8090, join with the **host code**, tap a seat, buy in.
Friends on your Wi-Fi join `http://<your-lan-ip>:8090` with the **invite code**.
The host deals the first hand; every following hand deals itself.

Configuration (blinds, buy-ins, table name, fixed codes) via env — see `.env.example`.

For development: `pnpm dev` runs the server (hot reload) and Vite together;
the web dev server on :5173 proxies to the game server on :8090.

## Play with friends over the internet

Don't port-forward. Use a Cloudflare Tunnel — outbound-only, free TLS, your home IP
never exposed:

```bash
winget install Cloudflare.cloudflared   # or brew install cloudflared
cloudflared tunnel --url http://localhost:8090
```

`cloudflared` prints a `https://something.trycloudflare.com` URL. Text your friends:

> `https://something.trycloudflare.com` — code **7F3A91**

That's the whole onboarding. On a phone, "Add to Home Screen" installs it as an app.
For a permanent setup (your own domain + Cloudflare Access email allowlist in front),
follow `docs/SECURITY-SETUP.md`.

## Trust, but verify

- **Fair tab in-app**: the pre-deal commitment, every player's seed, and the post-hand
  reveal for the current session. Set your own seed any time.
- **Offline**: `pnpm verify-hand 214` re-derives hand #214's entire deck from the
  revealed seeds and checks it against what was actually dealt. The verifier shares no
  code with the server — see `docs/FAIRNESS.md`.
- **Histories**: `GET /api/history` — every hand, hole cards included, downloadable.

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
