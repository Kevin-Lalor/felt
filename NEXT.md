# Next session

**Where we are (2026-10-11):** `main` is `2292a68`. Merged: Phase 0, Phase 1, cosmetics,
the seat-view fix, the play bots, and **sitting out** (PR #8). CI green, branch protection on.

**Three PRs open, to merge in order** — each is built on the one before:

1. `fix/security-hardening` — the four blockers from the 11 Oct security review (history
   readable without a code, blank codes, guessable codes, one person filling every seat) and the
   should-fix list: loopback by default, codes out of URLs and logs, rate limits, name rules,
   noindex and security headers, host-only dealing.
2. `feat/host-kick-and-pause` — the light host (HOUSE-RULES #13–#15), mucked hands hidden from
   history (#16), rebuys left undecided (#17), and `killHand` in the engine.
3. `feat/heartbeat` — server ping every 25 s, the `docs/SECURITY-SETUP.md` runbook for the
   decided hosting, and this file.

The app plays real hands, an absent player no longer holds the table up, and once these merge it
is safe to expose behind Access. It is still not something six friends can join on a Saturday
night: the gap is now **mobile and durability**, plus doing the Cloudflare setup — not poker.

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

**A. They can reach it.** **Decided 11 Oct 2026:** the server runs on Kevin's computer at
home, reached through a named Cloudflare Tunnel on Kevin's own domain, with Cloudflare Access in
front — an email allowlist, one-time PIN by email, a login that lasts 30 days. No port
forwarding, no other login system; the invite code stays as a second lock behind Access.
`docs/SECURITY-SETUP.md` is now the exact runbook. The heartbeat is built (PR 3), so idle sockets
stay open and dead ones are noticed. **Still to do: the setup itself** — buy the domain, create
the tunnel and the Access application, and check `/ws` through Access as the runbook says.

**B. It works on a phone.** `docs/design/WIREFRAMES.md` calls the mobile table "the most
important missing screen". At 390px today the felt is a tall lozenge with a dead zone in
the middle and seat plates clipped off both edges. It renders; it is not designed. Half the
table will be on iOS.

**C. It survives the night.** Table state — seats, stacks, the live hand — is in memory.
A laptop that sleeps, a crash, or a deploy forgets everyone mid-game. SQLite is Phase 2 and
nothing should ship to real players before it.

**D. People can get in and get seated.** **Host model decided 11 Oct 2026: light host** —
remove a player and pause dealing, nothing more (`HOUSE-RULES.md` #13–#15), built in PR 2.
Landing and join flow are still undecided (see the wireframe index); the existing join screen
works for a first night behind Access.

Tournament clock, chat, throwables, notes, leaderboard and the analytics pages are all
from the original brief and none are built. **None of them block a first cash game.**

---

## Suggested order

1. ~~**Heartbeat**~~ — done in PR 3. Browsers answer the server's pings themselves, so there is
   no client pong code; the client also rejoins at once when a phone comes back to the tab.
2. **SQLite persistence** (Phase 2). Leaderboard, notes and stats all want it too.
3. **Mobile table layout**, 6- and 9-handed. Design the frames first — the kit has none.
4. ~~**Host model decision**~~ — light host, decided and built (PR 2). Landing + join flow next.
5. **Cloudflare Tunnel + domain + Access** — follow `docs/SECURITY-SETUP.md`. Go live.
6. **Dress rehearsal:** bots + phone + laptop, then a friends-only beta before a real night.

Step 2 before 5, deliberately. Exposing an in-memory server on a public URL is how you
find out what a restart does in front of an audience.

---

## Decisions taken

- Default theme **Midnight**; settings surface **wireframe 1p**; table **1j**.
- Hosting: **named Cloudflare Tunnel + domain (~€10/yr)**, self-hosted on Kevin's computer at
  home, **Cloudflare Access** in front (email allowlist, one-time PIN, 30-day login), invite code
  as a second lock, server bound to `127.0.0.1`. No port forwarding, no other login system — the
  passkey/invite-token design is **not planned**. Decided 2026-10-11.
- Host model: **light host** — remove and pause, nothing more (`HOUSE-RULES.md` #13–#15).
  Decided 2026-10-11.
- **Mucked hands stay hidden** in hand history (#16). The seed is still revealed after every hand,
  so they stay derivable with the verifier; when to reveal it is an open decision. 2026-10-11.
- **Rebuys: not decided** (#17) — "who approves rebuys" is on the to-decide list. 2026-10-11.
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

## Known gaps — all re-verified against the PR 3 branch on 2026-10-11, not inherited

- **Table state is in memory.** No SQLite anywhere in `apps/server`. A restart forgets every seat
  and stack; only `apps/server/data/history.jsonl` survives. `docs/ARCHITECTURE.md` and
  `ROLLBACK.md` still describe SQLite, Drizzle, snapshots and Litestream as though they exist.
- **`db:migrate` and `db:snapshot` point at scripts nobody wrote** — the root scripts call
  `@poker/server`, which defines neither. `/ship` step 10 and `ROLLBACK.md` depend on them.
- **`pnpm test:e2e` does not pass on nothing — it fails.** There is no Playwright config file, so
  `playwright test` picks up the Vitest `*.test.ts` files, crashes importing them, and exits 1
  with "No tests found". Earlier versions of this file (and `CLAUDE.md`'s command list) said it
  passes; it never did. `/ship` step 7 runs it. First spec should be a bot-driven hand, with a
  config that points only at it.
- **No `.husky/pre-push`.** Only `commit-msg` exists.
- **`docs/audits/`, `docs/progress/` and `reviews/` are still empty** (each holds a `.gitkeep`).
  The `security-reviewer` and `poker-rules-verifier` agents were run during the 11 Oct work, but
  their reports live in the PRs, not in those folders.
- **`holeCardsArePrivate()` is misnamed** (`apps/server/src/redact.ts`) — it returns false for
  `complete` and defers to the caller. It reads like a guarantee it does not give.
- **`packages/tokens/cosmetics.json` catalogues fold styles, chip shuffles and throwables that
  nothing reads.** No code imports the file; only comments mention it. Do not build pickers for
  options with no implementation.
- **Still missing from wireframe 1j:** the emote/throw control on the table (the quick emotes
  live in the Chat tab), and the Notes and Stats rail tabs.
- **Two pieces of UI have no wireframe:** the sitting-out controls (20 Sep) and the Host tab
  (11 Oct). Both are recorded as invented in `WIREFRAMES.md` and deserve real frames.
- **Mucked hands are hidden, not secret.** The revealed server seed lets anyone with the verifier
  rebuild every card dealt. Deliberate for now; when to reveal is on the to-decide list.
- **`/api/fairness` counts every hand dealt, mucked ones included.** Only totals leave the server,
  but comparing them before and after a hand says whether anyone dealt in had a pocket pair.
  That is less than the revealed seed already gives away; worth knowing if reveal timing changes.
- **Removing a player is not a ban.** Their token is refused until the server restarts, and they
  can rejoin as a new player with the invite code. The real ban is the Access allowlist — the
  Remove dialog and the runbook both say so.
- **Limits are per address.** Friends on one wifi share an address: 4 players and 8 connections
  by default (`MAX_PLAYERS_PER_IP`, `MAX_CONNECTIONS_PER_IP`).
- **The mobile table is not designed.** At 390px it renders but was never laid out — goal B.

**Removed, because it was never true:** earlier versions of this file listed "dead money
goes to the wrong pot" in `buildPots`. It does not. A dead contribution level can only sit
*above* a live one — contributors at a higher level are a subset of those below — so
`lastPot` really is the nearest live pot below, as the code's comment says. The claim was
Claude's, made from a misreading, and it sat in this file as fact for a week. The invariant
is now pinned by a property test in `packages/engine/__tests__/property.test.ts`.

**Removed, because it is done:** "No heartbeat" (PR 3).

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
