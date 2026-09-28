# Next session

**Where we are (2026-09-28):** `main` is `3d25bef`. Merged: Phase 0, Phase 1, cosmetics,
the seat-view fix, the play bots, and **sitting out** (PR #8). CI green, branch protection on.

The app plays real hands, and an absent player no longer holds the table up. It is not yet
something six friends can join on a Saturday night, and the gap is **access, mobile and
durability** — not poker.

---

## How we work now

Every session starts **from the repo**, with the Claude GitHub app giving it access. Claude
does all the git — branch, commit, push, open the PR — inside its cloud container. Kevin
reviews and merges on GitHub, from any device. No local git, no local dev tools needed for
the code to move. `CLAUDE.md` → *Git and GitHub* has the rules.

`G:\poker` on the Windows desktop at home is **no longer the source of truth** — GitHub is.
Pull before using that working copy for anything.

Local dev tools are still worth having for one thing: **playing it yourself** — running the
server and sitting at the table on your own machine.

---

## The goal: one actual poker night

Six to nine friends, on Windows PCs, iOS phones, laptops and Macs. Four things have to be
true, and none of them is a feature.

**A. They can reach it.** Cloudflare Tunnel (named tunnel + domain) is decided but not
built. Cloudflare closes idle WebSockets, and **there is no heartbeat anywhere** — nothing
pings, nothing pongs. Reconnect itself already works (the client saves a player token and
rejoins with it), and since PR #8 a dropped player is sat out rather than holding up the
table. The missing piece is keeping the socket alive in the first place.

**B. It works on a phone.** `docs/design/WIREFRAMES.md` calls the mobile table "the most
important missing screen". At 390px today the felt is a tall lozenge with a dead zone in
the middle and seat plates clipped off both edges. It renders; it is not designed. Half the
table will be on iOS.

**C. It survives the night.** Table state — seats, stacks, the live hand — is in memory.
A laptop that sleeps, a crash, or a deploy forgets everyone mid-game. SQLite is Phase 2 and
nothing should ship to real players before it.

**D. People can get in and get seated.** Landing, join flow and host model are all still
undecided (see the wireframe index). **Host model is the blocker** — 1g full admin,
1h lightweight, 1i no host — because it is a rules decision as much as a layout one and
belongs in `HOUSE-RULES.md` before anyone builds against a guess.

Tournament clock, chat, throwables, notes, leaderboard and the analytics pages are all
from the original brief and none are built. **None of them block a first cash game.**

---

## Suggested order

1. **Heartbeat** (server ping, client pong, a timeout that treats silence as a disconnect).
   Prerequisite for the tunnel.
2. **SQLite persistence** (Phase 2). Leaderboard, notes and stats all want it too.
3. **Mobile table layout**, 6- and 9-handed. Design the frames first — the kit has none.
4. **Host model decision** → `HOUSE-RULES.md` → then landing + join flow.
5. **Cloudflare Tunnel + domain.** Go live.
6. **Dress rehearsal:** bots + phone + laptop, then a friends-only beta before a real night.

Steps 1–2 before 5, deliberately. Exposing an in-memory server on a public URL is how you
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
- **Sitting out** (cash): dealt out entirely; coming back costs one full orbit, never less —
  `HOUSE-RULES.md` #6–#12.
- **Git runs in Claude's container** via the GitHub app; Kevin reviews and merges on
  GitHub. Decided 2026-09-28.

---

## Known gaps — all re-verified against `main` on 2026-09-28, not inherited

- **No heartbeat.** No ping/pong or keepalive in `apps/server/src` or `apps/web/src`.
- **Table state is in memory.** `docs/ARCHITECTURE.md` and `ROLLBACK.md` still describe
  SQLite, Drizzle, snapshots and Litestream as though they exist. `CLAUDE.md` carries a
  warning; those two do not.
- **`db:migrate` and `db:snapshot` point at scripts nobody wrote** — the root scripts call
  `@poker/server`, which defines neither. `/ship` step 10 and `ROLLBACK.md` depend on them.
- **`pnpm test:e2e` runs against zero specs.** Playwright is configured with no `.spec.ts`
  anywhere. `/ship` step 7 runs it and passes. First spec should be a bot-driven hand.
- **No `.husky/pre-push`.** Only `commit-msg` exists.
- **`docs/audits/`, `docs/progress/` and `reviews/` are empty.** Four review agents and six
  slash commands in `.claude/` have never been run.
- **`holeCardsArePrivate()` is misnamed** — it returns false for `complete` and defers to
  the caller. It reads like a guarantee it does not give.
- **`packages/tokens/cosmetics.json` catalogues fold styles, chip shuffles, emote packs and
  throwables that nothing reads.** Do not build pickers for options with no implementation.
- **Still missing from wireframe 1j:** the emote/throw control, and the Notes and Stats
  rail tabs.
- **The sitting-out UI has no wireframe.** Its layout was invented on 2026-09-20; it is
  recorded as such in `WIREFRAMES.md` and deserves a real frame.

**Removed, because it was never true:** earlier versions of this file listed "dead money
goes to the wrong pot" in `buildPots`. It does not. A dead contribution level can only sit
*above* a live one — contributors at a higher level are a subset of those below — so
`lastPot` really is the nearest live pot below, as the code's comment says. The claim was
Claude's, made from a misreading, and it sat in this file as fact for a week. The invariant
is now pinned by a property test in `packages/engine/__tests__/property.test.ts`.

---

## The pattern worth carrying forward

This repo keeps asserting more than it checks. CI guards that greped a directory which never
existed; a fairness protocol whose ordering made the published proof meaningless; a seat
view that inferred identity from an array index; a green test suite that could not see a
whole category of defect because every test had the server talk to itself. And, in this very
file, a bug that did not exist — stated as fact because nothing checked it.

The two most recent real defects were both found by **playing**, not by tests: the stack
reading 0 after a mid-hand buy-in, and a "post to come back" rule that made sitting out the
cheapest seat at the table. 20,000 fuzzed hands passed over both.

So: `pnpm bot Mo --style loose`. Before merging anything that touches the table, play a hand
against the bots. The highest-value piece of test debt in the repo is wiring one bot-driven
hand into `test:e2e`, which currently checks nothing. And before writing anything into this
file as a known gap, check it against the tree.

**Read first:** `CLAUDE.md`. It is the contract.
