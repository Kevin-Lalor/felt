# Poker — Claude Code guide

Read this fully before making any change. Everything here is load-bearing.

---

## What this is

A private, invite-only, **play-money** poker app for 6–9 friends. No-Limit Texas Hold'em,
cash games and tournaments. Self-hosted. No rake. No real-money handling of any kind.

**Fairness and trust are the product.** The reason this exists is that commercial play-money
sites feel rigged. Everything we build must be verifiably fair, not just fair.

---

## Hard rules

Violating any of these fails review. Do not work around them; if one blocks you, **stop and ask**.

1. **The server is the sole authority on game state.** The client renders state and sends
   *intents* (`{type:'raise', to: 400}`). It never sends outcomes. Never trust a client-supplied
   amount, seat, card, or timestamp without server-side validation.

2. **Never send a player data they are not entitled to see.** Redaction happens server-side,
   in `apps/server/src/redact.ts`, before serialization. Other players' hole cards must be
   *absent from the payload*, not hidden by the UI. There is a fuzz test enforcing this; it must
   never be skipped or weakened.

3. **Never use `Math.random()`.** Anywhere. Use `randomInt` from `node:crypto`. ESLint bans it in
   `packages/engine` and `apps/server`. This includes tests that generate decks — use a seeded
   deterministic PRNG explicitly imported as `testRng` so it can never be confused with the real one.

4. **No function may take player state as input and return a card.** Cards come off the top of a
   shuffled deck, in order, full stop. There is no "deal a card that makes this interesting" code
   path and there never will be. If you find yourself writing a function whose signature could
   possibly enable one, redesign.

5. **`packages/engine` is pure.** No I/O, no network, no `Date.now()`, no randomness, no logging
   to console. The deck arrives as a parameter. Time arrives as a parameter. This is what makes
   the engine exhaustively testable, and it is non-negotiable.

6. **Every inbound WebSocket message is Zod-parsed and turn-validated** before it reaches the
   engine. Parse first, then check "is this seat allowed to act right now?", then apply. Never
   the other way round.

7. **No raw colours, spacing values, or durations in components.** Semantic tokens only
   (`var(--felt-base)`, not `#0a5c36`). If the token doesn't exist, add it to
   `packages/tokens/semantic.json` first, then use it. Lint fails on hex codes in
   `apps/web/src/components`.

8. **Any change to betting, pot, or hand-evaluation logic requires new property-based tests in
   the same PR.** Not example tests — property tests. Chips conserved, no negative stacks,
   side pots sum to contributions, every pot has an eligible winner.

9. **No real-money code paths, ever.** No card fields, no wallet, no payment provider, no
   cash-out, no crypto. Chips are play money set manually by the host. This boundary is
   deliberate and legal; do not drift across it even for a "just a placeholder" field.

10. **Do not invent poker rules.** Every rules decision lives in `docs/HOUSE-RULES.md`. If a
    situation is ambiguous and not documented there, **stop and ask** — do not guess. Guessing
    here produces bugs that surface at 1am in front of nine people.

---

## Commands

```bash
pnpm dev              # server + web, hot reload, seeded dev table
pnpm test             # everything
pnpm test:engine      # fast (<2s) — run this constantly while working in packages/engine
pnpm test:property    # fast-check, ~60s — run before opening a PR
pnpm test:leak        # redaction fuzzer, 5000 hands — run before any PR touching the protocol
pnpm test:e2e         # Playwright, 4 simulated clients through a full hand
pnpm typecheck
pnpm lint
pnpm build
pnpm verify-hand <handId>   # re-derives a past hand from its seeds; proves the shuffle
pnpm db:migrate
pnpm db:snapshot
```

---

## Architecture

```
packages/engine     Pure NLHE rules. Types, state machine, betting, side pots, hand evaluator.
                    Zero dependencies. Zero I/O. Deterministic. ~100% covered.
packages/protocol   Zod schemas for every client↔server message. The contract. Shared by both.
packages/tokens     Design tokens → CSS custom properties. Single source of visual truth.
apps/server         Fastify (HTTP/auth) + ws (table). Owns authoritative state, redaction,
                    commit-reveal seeds, hand history. NOTE: persistence today is an
                    append-only JSONL file (apps/server/data/history.jsonl). Table state —
                    seats, stacks, the live hand — is IN MEMORY and does not survive a
                    restart. SQLite/Drizzle is planned, not built; docs/ARCHITECTURE.md and
                    ROLLBACK.md describe it as though it exists. Do not build on it.
apps/web            React 19 + Vite PWA. Renders redacted state, sends intents. Zustand store.
tools/verify-hand   Standalone verifier a suspicious friend can run outside the app.
```

**Data flow for one action:** client sends intent → server Zod-parses → server checks auth +
seat + turn → server applies to engine (pure function, returns new state + events) → server
persists → server redacts per seat → server broadcasts. The client never computes game outcomes.

---

## Fairness protocol

Each hand:

1. Commitments are **chained one hand ahead**. `commit = SHA256(serverSeed)` for hand N is minted
   and broadcast when hand N-1 starts (and for hand 1, in the `Table` constructor). The server
   therefore commits **before it can know the client seeds** that commitment will be mixed with.
   This ordering is the whole guarantee: generating the seed at deal time, after reading
   `player.clientSeed`, lets a modified server grind decks while every published check still
   passes. `startNextHand()` must only ever CONSUME a commitment, never mint the one it uses.
2. Deck order = Fisher–Yates over the canonical 52-card deck, driven by an HMAC-SHA256
   counter-mode stream with rejection sampling:
   `block[n] = HMAC-SHA256(serverSeed, clientSeeds.join('|') + '+' + handNumber + ':' + n)`,
   where every seated player contributes a `clientSeed` they control. Clients rotate their seed
   automatically as each new commitment appears; a pinned seed opts out, and every seat's
   `postCommit` flag records which.
3. At hand end, server reveals `serverSeed`. Anyone can check `SHA256(revealed) === commit` and
   re-derive the deck.
4. Seeds are recorded **positionally** (`[{ seat, name, seed, postCommit }]`), never keyed by a
   player name — names change on reconnect and that made honest hands unverifiable. Names are
   frozen for the duration of a hand, and every hand carries a stable `handId`.

**Never change this protocol without updating `tools/verify-hand.ts` and `docs/FAIRNESS.md` in the
same PR.** A verifier that disagrees with the server is worse than no verifier.
`apps/server/__tests__/table-integrity.test.ts` drives a real hand and shells out to the verifier,
so drift fails CI rather than a game night.

---

## Design references

Wireframes and visual references live in `docs/design/wireframes/` and are indexed in
`docs/design/WIREFRAMES.md`. **Before building or changing any UI, read that index** and then
read the specific wireframe image for the screen you're working on with the Read tool.

@docs/design/WIREFRAMES.md

A wireframe is the source of truth for **layout, hierarchy, and what's on screen**. It is *not*
the source of truth for colour, spacing, or type — those come from `packages/tokens`. Where a
wireframe and the token system disagree, the tokens win and you flag the conflict.

If a wireframe is ambiguous about a state that matters (all-in, side pots, disconnected,
heads-up, 9-handed), **stop and ask** rather than inventing the layout.

## Style

- TypeScript strict. No `any`. No non-null assertions without a comment justifying it.
- Prefer pure functions and explicit returns over mutation.
- **Name things the way a poker player would**, not the way a programmer would: `seat`, `button`,
  `smallBlind`, `street`, `pot`, `sidePots`, `action`, `toCall`, `muck` — not `index`, `flag`,
  `node`, `data2`. Domain language is how a non-CS reviewer reviews code they didn't write.
- Errors: engine throws typed `EngineError` for illegal states (a bug); server returns typed
  protocol errors for illegal player input (not a bug). Never conflate the two.
- Comments explain *why*, not *what*. Especially for poker edge cases — write the rule out.

---

## Working agreement

- One feature = one plan = one branch = one PR = one session.
- **Enter plan mode before any non-trivial change.** Show the plan, wait for approval.
- For anything in `packages/engine`: **write the tests first**, show the test names for approval,
  then implement.
- Small commits, Conventional Commits format (`feat:`, `fix:`, `test:`, `refactor:`, `chore:`).
- Never leave the repo in a non-running state at the end of a session.
- If you change an architectural decision, update this file and add an ADR in `docs/adr/`.
- If a task would take more than ~90 minutes of work, stop and propose splitting it.

## Never do

- Weaken, skip, or `.skip()` a fairness or leak test to make CI pass.
- Add a dependency to `packages/engine`.
- Store secrets in the repo. Everything sensitive is env-only; `.env.example` documents keys.
- Add a public signup route. Registration is invite-token-only, always.
- Deploy from a dirty working tree or an untagged commit.
