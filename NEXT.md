# Next session

**Where we are (2026-09-19, end of day):** `main` is `9093f5a`. Everything below is
merged — Phase 0, Phase 1, cosmetics, the seat-view fix, and the play bots. Working
tree clean, CI green, branch protection on.

The app plays real hands. It is not yet something six friends can join on a Saturday
night, and the gap is almost entirely **access, mobile, and durability** — not poker.

---

## The goal: one actual poker night

Six to nine friends, on Windows PCs, iOS phones, laptops and Macs. For that to work,
five things have to be true, and only the last of them is about features.

**A. They can reach it.** Cloudflare Tunnel (named tunnel + domain) is decided but not
built. Cloudflare closes idle WebSockets, so this needs heartbeat + reconnect-with-resync
*first* or the tunnel will just expose the fragility.

**B. It works on a phone.** `docs/design/WIREFRAMES.md` calls the mobile table "the most
important missing screen" and it is right. `styles.css` has 900px and 520px breakpoints
that no wireframe describes and nobody has played against. Half the table will be on iOS.

**C. It survives the night.** Table state — seats, stacks, the live hand — is in memory.
A laptop that sleeps, a crash, or a deploy forgets everyone mid-game. Three hours in,
that is not a bug report, it is the end of the evening. SQLite is Phase 2 and nothing
should ship to real players before it.

**D. People can get in and get seated.** Landing, join flow and host model are all still
undecided (see the wireframe index). **Host model is the blocker** — 1g full admin,
1h lightweight, 1i no host — because it is a rules decision as much as a layout one and
belongs in `HOUSE-RULES.md` before anyone builds against a guess.

**E. The chips are right.** One known engine defect, below. In a game with antes it
quietly pays the wrong player.

Tournament clock, chat, throwables, notes, leaderboard and the analytics pages are all
from the original brief and none are built. **None of them block a first cash game.**

---

## Suggested order

1. **Heartbeat + reconnect-with-resync.** Prerequisite for both A and C.
2. **SQLite persistence** (Phase 2). Leaderboard, notes and stats all want it too.
3. **Mobile table layout**, 6- and 9-handed. Design the frames first — the kit has none.
4. **Host model decision** → `HOUSE-RULES.md` → then landing + join flow.
5. **Dead-money fix** with a property test that would have caught it.
6. **Cloudflare Tunnel + domain.** Go live.
7. **Dress rehearsal:** bots + phone + laptop, then a friends-only beta before a real night.

Steps 1–2 before 6, deliberately. Exposing an in-memory server on a public URL is how you
find out what reconnect does in front of an audience.

---

## Decisions taken

- Default theme **Midnight**; settings surface **wireframe 1p**; table **1j**.
- Hosting: **named Cloudflare Tunnel + domain (~€10/yr)**, self-hosted at home.
- Repo **public**. Branch protection requires `verify`, `fairness invariants`, `coverage`;
  `independent reviewer` stays advisory.
- Card backs are a **local preference**, not a table theme — `docs/adr/0001`.
- CI uses **`CLAUDE_CODE_OAUTH_TOKEN`**, not an API key, so the reviewer runs on the Max
  subscription instead of billing the API.

---

## Known gaps — all re-verified 2026-09-19, not inherited

- **Dead money goes to the wrong pot.** `packages/engine/src/engine.ts`, `lastPot.amount
  += deadMoney`. Pots are built from the smallest contribution upward, so `lastPot` is the
  *most exclusive* side pot. Orphaned antes belong in the **main** pot (`pots[0]`), which
  everyone contests. Chips are conserved either way, which is exactly why no conservation
  property test catches it. Hard rule 8: fix needs a property test in the same PR.
- **Table state is in memory.** `ARCHITECTURE.md` and `ROLLBACK.md` still describe SQLite
  as though it exists. `CLAUDE.md` carries a warning; those two do not.
- **`db:migrate` and `db:snapshot` point at scripts nobody wrote.** `/ship` step 10 and
  `ROLLBACK.md` both depend on `db:snapshot`.
- **`pnpm test:e2e` runs against zero specs.** Playwright is a devDependency with no
  `.spec.ts` anywhere. `/ship` step 7 runs it and passes. First spec should be a bot-driven
  hand — see below.
- **No `.husky/pre-push`.** Only `commit-msg` exists, so nothing local stops red code going up.
- **`docs/audits/`, `docs/progress/` and `reviews/` are empty.** Four review agents and six
  slash commands in `.claude/` have never been run. `/fairness-audit` and `/leak-check` were
  written to catch precisely the defects that later shipped.
- **`holeCardsArePrivate()` is misnamed** — it returns false for `complete` and defers to
  the caller. It reads like a guarantee it does not give.
- **`cosmetics.json` catalogues fold styles, chip shuffles, emote packs and throwables that
  nothing reads.** Do not build pickers for options with no implementation behind them.
- **Still missing from wireframe 1j:** the emote/throw control, and the Notes and Stats
  rail tabs.

---

## The pattern worth carrying forward

Four times now this repo has asserted more than it checked: CI guards that greped a
directory which never existed; a fairness protocol whose ordering made the published proof
meaningless; a seat view that inferred identity from an array index; and a green test suite
that could not see a whole category of defect because every test had the server talk to
itself.

The seat-view bug (stack showing 0 after a 200 buy-in, and a new player seeing the departed
player's chips) was found by **sitting down at a table that was already running** — 5,000
fuzzed hands and a full property suite had all passed over it.

So: `tools/bot.ts` is on `main` now. `pnpm bot Mo --style loose`. Before merging anything
that touches the table, play a hand against them. The highest-value piece of test debt in
the repo is wiring one bot-driven hand into `test:e2e`, which currently checks nothing.

**Read first:** `CLAUDE.md`. It is the contract and it is accurate.
