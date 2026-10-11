# Next session

**Where we are (2026-10-11, evening).** The security review of 11 Oct is closed out, the host
model is decided and built, and the hosting decision has a runbook. In code terms FELT is ready
to go behind Cloudflare. What stands between it and a real poker night is **your Cloudflare
setup, the phone layout, and surviving a restart** — not poker, and not security.

| PR | What | State |
|---|---|---|
| #10 `fix/security-hardening` | The four blockers from the security review, plus the should-fix list | **Merged** |
| #11 `feat/host-kick-and-pause` | Light host (remove + pause), mucked hands hidden, house rules #13–#20 | Open, green — **merge first** |
| `feat/heartbeat` | Server heartbeat, the Cloudflare runbook, ADR 0002, this file | Open, built on #11 — **merge second** |

---

## How close are we to trying it with real people?

Two milestones, because they need different things.

### Milestone 1 — a trial with two or three friends, on laptops

**One evening of your time away.** Nothing in the code blocks it.

- [ ] Merge #11, then the heartbeat PR.
- [ ] On the home computer: `git pull`, `pnpm install`, `pnpm build`.
- [ ] Follow `docs/SECURITY-SETUP.md` top to bottom: buy the domain, create the tunnel, create
      the Access application with the friends' emails, set your own `INVITE_CODE` and `HOST_CODE`.
      Budget an hour or two the first time.
- [ ] The runbook's checks: an email **not** on the list is refused; on a laptop through Access,
      F12 shows `/ws` at status 101.
- [ ] Sit one friend down with two bots (`pnpm bot Mo --code …`) before the others join.

What to tell the friends: it is a test. If the server stops, the table is forgotten (hand
histories are kept), and on a phone it works but looks rough.

**Never tried for real yet:** the game through a real Cloudflare Tunnel and Access, and the game
on a real iPhone in Safari. Everything has been tested in Chromium and against a local server.
The runbook says how to check the first; the trial is how you check the second.

### Milestone 2 — a real night, six to nine friends, half on phones

**Roughly four to six focused sessions away**, in this order:

1. **Persistence (SQLite, "Phase 2").** Today a crash, a Windows update or a sleeping laptop
   forgets every seat and stack mid-game. The public chip log would let you rebuild stacks by
   hand, but nobody wants that at 1am. One or two sessions.
2. **The phone table, 6- and 9-handed.** At 390px it renders, but nobody ever designed it:
   seat plates clip off the edges and the middle is dead space. The wireframe kit has no mobile
   frames, so this starts with frames (that is a design decision for you), then one or two
   sessions to build.
3. **A bot-driven end-to-end test.** `pnpm test:e2e` currently fails on nothing (see the known
   gaps). One spec that plays a hand through a real browser would catch the kind of defect that
   only playing has caught so far. One session.
4. **Decide the rules a cash night will hit** — see "Still to decide" below. Minutes of your time,
   not sessions.
5. **Dress rehearsal:** bots plus a phone plus a laptop through the real tunnel, then the
   Milestone 1 trial, then the real night.

Not needed for a first night: tournaments, leaderboard, notes, stats, throwables, a landing page.

---

## What was done on 11 Oct

**#10 — security hardening (merged).** All four blockers were reproduced on a live server first,
then fixed, and each has a test that fails without the fix:
- **History was readable without a code** through encoded URLs (`/api/%68istory`). The check now
  sits on the routes themselves.
- **Blank codes switched auth off.** A blank, short or matching code now stops the server from
  starting, and unset codes are random 16-character ones.
- **Codes could be guessed.** 8 wrong guesses in 15 minutes locks that visitor out, across the
  table and the API, and visitors are identified by `CF-Connecting-IP`.
- **One person could fill the table.** One player per connection, a cap per address, and idle
  sockets are closed after 10 seconds.

Also:
- The server listens on `127.0.0.1`, so the home network can't skip Access.
- Codes are kept out of URLs and logs.
- Rate limits on chat, emotes, skins, seeds and seat changes.
- Names are limited to European letters, and look-alike names count as the same name.
- noindex, `robots.txt`, and security headers with a CSP.
- Only the host deals.
- History is served from memory.

An independent review then got around the first pass: unlimited host-code guesses, ghost seats
created one socket at a time, rate limits reset by rejoining, and Latin look-alike names. All of
it was fixed before merge.

**#11 — light host and hidden mucked hands.**
- **Remove** a player:
  - Their hand is dead at once.
  - Unmatched chips go back (#19).
  - If any host is in their pot, it waits until the hand ends (#18).
  - It's logged publicly, and their token is barred until restart.
- **Pause** dealing.
- **Mucked hands** are kept out of history (#16). The verifier still checks every shown card, and
  a folder can still check their own fold.
- Two rounds of review (a security pass and a rules pass, then a four-lens adversarial pass)
  found and fixed seven real problems. Among them:
  - a second-device bypass of #18;
  - the showdown order after a removal;
  - someone sitting in an emptied seat being able to show the last player's mucked hand.
- A table fuzzer ran 24,000 hands with 17,207 removals: no chip lost or created.

**Heartbeat PR.**
- The server pings every socket every 25 s and closes the ones that stop answering, which keeps
  Cloudflare from closing idle tables. Checked live: a silent phone was closed at 46 s and sat
  out with its seat and chips kept, and an idle laptop stayed connected.
- A reconnect on a new network no longer gets the player sat out when the old socket finally
  dies.
- The client rejoins as soon as a phone tab comes back to the foreground.
- `docs/SECURITY-SETUP.md` is now the exact runbook for the decided setup.
- `docs/adr/0002` records why Access replaced the planned passkey design.

---

## What's next, in order

1. **Merge #11, then the heartbeat PR.**
2. **Milestone 1** (above): the Cloudflare setup and a small trial. This is your evening, not a
   session.
3. **SQLite persistence.** Table state survives a restart. This also unblocks the leaderboard,
   notes and stats later.
4. **Mobile table frames** (your design call), then the build.
5. **One bot-driven `test:e2e` spec**, plus a Playwright config that points only at it.
6. **Dress rehearsal → Milestone 2.**

---

## Still to decide

From `docs/HOUSE-RULES.md` → *To decide before launch*, the ones a cash night will actually hit:

- **Action clock.** It is 45 s with no time bank today ("to be tuned" in the code). The
  suggestion on file is 25 s plus 3 × 30 s time-bank chips.
- **Rebuys** (#17). Who approves them, any time or only between hands, and is there a stack cap?
  Today a seated player tops up between hands on their own, up to the table maximum, and the chip
  log shows it.
- **When the server seed is revealed.** It is revealed after every hand, which proves the shuffle
  and also lets anyone with the verifier rebuild mucked hands (#16).
- **Chat during a live hand**, and **show one card at showdown.**

From `docs/design/WIREFRAMES.md`: landing page (1a/1b/1c) and join flow (1d/1e/1f). Neither
blocks a first night; the existing join screen works behind Access.

---

## Decisions taken

- Default theme **Midnight**; settings surface **wireframe 1p**; table **1j**.
- **Hosting** (2026-10-11):
  - A **named Cloudflare Tunnel + domain (~€10/yr)**, self-hosted on Kevin's computer at home.
  - **Cloudflare Access** in front: email allowlist, one-time PIN, 30-day login.
  - The invite code is a second lock, and the server is bound to `127.0.0.1`.
  - No port forwarding and no other login system. The passkey/invite-token design is **not
    planned** (`docs/adr/0002`).
- **Light host** (#13–#15, #18): remove and pause, nothing more. A removal waits while any host
  is in that pot. 2026-10-11.
- **Removing mid-hand** (#14, #19, #20): the hand is dead at once, and the bet still has to be
  called. Chips no live player matched go back, so nobody wins more than they risked.
  2026-10-11.
- **Mucked hands stay hidden** in hand history (#16). 2026-10-11.
- **Rebuys: not decided** (#17). 2026-10-11.
- Repo **public**. Branch protection requires `verify`, `fairness invariants`, `coverage`;
  `independent reviewer` stays advisory.
- Card backs are a **local preference**, not a table theme (`docs/adr/0001`).
- CI uses **`CLAUDE_CODE_OAUTH_TOKEN`**, not an API key, so the reviewer runs on the Max
  subscription instead of billing the API.
- **Sitting out** (cash): dealt out entirely; coming back costs one full orbit, never less
  (#6–#12).
- **Git runs in Claude's container** via the GitHub app; Kevin reviews and merges on GitHub.
  2026-09-28.

---

## How we work now

Every session starts **from the repo**, with the Claude GitHub app giving it access. Claude does
all the git: branch, commit, push, open the PR. Kevin reviews and merges on GitHub, from any
device. `G:\poker` is **not** the source of truth; pull before using it. Local tools are still
worth having for one thing: **playing it yourself**, and now for hosting.

---

## Known gaps — all re-verified against the heartbeat branch on 2026-10-11, not inherited

- **Table state is in memory.**
  - No SQLite anywhere in `apps/server`. A restart forgets every seat and stack; only
    `apps/server/data/history.jsonl` survives.
  - `docs/ARCHITECTURE.md` and `ROLLBACK.md` still describe SQLite, Drizzle, snapshots and
    Litestream as though they exist.
- **`db:migrate` and `db:snapshot` point at scripts nobody wrote.** The root scripts call
  `@poker/server`, which defines neither. `/ship` step 10 and `ROLLBACK.md` depend on them.
- **`pnpm test:e2e` fails rather than passing on nothing.**
  - There is no Playwright config, so `playwright test` picks up the Vitest `*.test.ts` files,
    crashes importing them, and exits 1.
  - `/ship` step 7 runs it.
  - `CLAUDE.md` now says so; earlier versions of this file said it passed.
- **No `.husky/pre-push`.** Only `commit-msg` exists.
- **`docs/audits/`, `docs/progress/` and `reviews/` are still empty** (a `.gitkeep` each). The
  review agents have now been run, but their reports live in the PRs.
- **`holeCardsArePrivate()` is misnamed** (`apps/server/src/redact.ts`). It returns false for
  `complete` and defers to the caller.
- **`packages/tokens/cosmetics.json` catalogues fold styles, chip shuffles and throwables that
  nothing reads.** Don't build pickers for options with no implementation.
- **Still missing from wireframe 1j:** the emote/throw control on the table (quick emotes live in
  the Chat tab), and the Notes and Stats rail tabs.
- **Two pieces of UI were built without a wireframe:** the sitting-out controls and the Host tab.
  Both are recorded as invented in `WIREFRAMES.md`.
- **Mucked hands are hidden, not secret.** The revealed seed lets anyone with the verifier rebuild
  them. This is deliberate until reveal timing is decided.
- **`/api/fairness` counts mucked hands in its totals.** Comparing totals before and after a hand
  says whether anyone dealt in had a pocket pair. That is less than the seed already gives away,
  but worth knowing if reveal timing changes.
- **Removing a player is not a ban.** Their token is refused until restart, but they can rejoin as
  a new player with the invite code. The ban is the Access allowlist; the Remove dialog and the
  runbook both say so.
- **Limits are per address.** Friends on one wifi share an address: 4 players and 8 connections by
  default (`MAX_PLAYERS_PER_IP`, `MAX_CONNECTIONS_PER_IP`).
- **The phone table is not designed** (Milestone 2).

**Removed, because it was never true:** "dead money goes to the wrong pot" in `buildPots`. A dead
contribution level can only sit *above* a live one, and a property test pins it.

**Removed, because it is done:** no heartbeat; the three open corners of rule #14 (decided as
#18–#20).

---

## The pattern worth carrying forward

This repo keeps asserting more than it checks:
- CI guards that grepped a directory which never existed.
- A fairness protocol whose ordering made the published proof meaningless.
- A seat view that inferred identity from an array index.
- `test:e2e` described as passing when it fails.
- In this very file, a bug that did not exist, stated as fact because nothing checked it.

Two habits caught what tests didn't:
- **Playing.** Two real defects were found that way: a stack reading 0 after a mid-hand buy-in,
  and a sit-out rule that made sitting out the cheapest seat at the table. 20,000 fuzzed hands
  passed over both.
- **Adversarial review with reproduction.** On 11 Oct, reviewers who had to reproduce every claim
  found:
  - the encoded-URL history bypass;
  - a second-device way around rule #18;
  - a rule implemented narrower than written;
  - an empty seat that could show a stranger's mucked hand.

So: `pnpm bot Mo --style loose` before merging anything that touches the table, a review agent on
anything touching the server, and check every "known gap" against the tree before writing it
here.

**Read first:** `CLAUDE.md`. It is the contract.
