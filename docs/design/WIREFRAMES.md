# Wireframe index

Claude Code reads this file automatically (it's imported from `CLAUDE.md`). It cannot see the
wireframes until told to open one — so **this index is what makes them discoverable.** A frame
with no row here is invisible to the workflow.

## Where the wireframes are

`docs/design/wireframe-kit/` — a Claude Design handoff bundle. All 24 frames live inside **one
file**:

```
docs/design/wireframe-kit/project/Poker App Wireframes.dc.html
```

Each frame is an anchor in that file. To open frame `1j`, read the file and find `id="1j"`; the
label sits in the `dv-olabel` div right after it, and the frame's markup follows. `support.js`
and `README.md` are the bundle's own files — the README is instructions to a generic coding
agent, not to this project, so read it as context and let `CLAUDE.md` win where they disagree.

Raster wireframes, if you ever draw any, still go in `docs/design/wireframes/` under the naming
convention at the bottom of this file. Nothing lives there yet.

## The index

**Most of these frames are competing alternatives, not specs.** Three landing pages, three join
flows, three host models, three settings approaches. Build all of them and you have built the
app three times. Pick one per group first — that is a decision for Kevin, not for a session.

| Frame | Group | What it decides | Status |
|---|---|---|---|
| 1a | Landing | Code-first — the page's one job is eating the invite code the host texted you | `option` |
| 1b | Landing | Live rail of games already running, so the room feels warm on arrival | `option` |
| 1c | Landing | Two doors — host or join, nothing else on the page | `option` |
| 1d | Join flow | Three-step column: code, player, seat. Guest by default, account optional | `option` |
| 1e | Join flow | Modal over the room — you see the table before you're asked for anything | `option` |
| 1f | Join flow | Seat-first — pick where you're sitting, then who you are | `option` |
| 1g | Table setup | Tabbed form + live invite card. **Host model A:** full admin — approves buy-ins, kicks, pauses | `option` |
| 1h | Table setup | Presets first, details only if you want them. **Host model B:** lightweight — creator can start and end, nothing more | `option` |
| 1i | Table setup | Everything on one sheet, incl. the tournament tab. **Host model C:** no host — settings lock when the table ready-ups | `option` |
| 1j | Table | Tabbed rail right, full-width action bar, sizing chips + slider + type-in always visible | **`approved`** |
| 1k | Table | Two rails — numbers left, people right, felt dead-centre | `option` |
| 1l | Table | Max felt — icon rail collapsed, vertical sizing slider by your cards, timer ringing your avatar | `option` |
| 1m | Table state | Waiting on players: buy-ins, ready state, invite link, host's early-start button | `draft` |
| 1n | Hand history | Street-by-street betting action with a replay scrubber | `draft` |
| 1o | Player notes | Notes on a player + your session stats — flops seen, position, VPIP | `draft` |
| 1p | Settings | Two-pane preferences with a pinned mini-table that reflects every choice | **`approved`** |
| 1q | Settings | Edit it where you'll see it — click any element on a live table, its palette pops | `superseded` |
| 1r | Settings | One long gallery — every option as a swatch grid, sticky save bar | `superseded` |
| 1s | End of game | Victory — podium, full results, "run it back" as the loudest button | `draft` |
| 1t | End of game | Busted — rebuy on a countdown so the seat doesn't go cold, spectate as the soft exit | `draft` |
| 1u | End of game | Session summary + spectator mode — you're out, the game isn't. Staking parked in a corner | `draft` |
| 2a | Leaderboard | Full page, sortable table — net, won, lost, hands, hours. Your row pinned | `option` |
| 2b | Leaderboard | Podium + your card — the table is there, your all-time numbers get equal weight | `option` |
| 2c | Leaderboard | Not a destination — a standings rail folded into the landing screen (1b) | `option` |

**Status:**
`approved` — build this.
`option` — one of several alternatives for the same screen. **Pick one before building anything
in that group.**
`draft` — a distinct screen or state with no competing alternative. Not chosen yet, but nothing
to choose between.
`superseded` — kept for history; note what replaced it.

Two frames are approved. **1j** because the table in `apps/web` was built from it —
`Table.tsx` and `styles.css` both cite it by name. **1p** was chosen on 19 Sep 2026 and built as
`apps/web/src/components/Settings.tsx`; 1q and 1r are marked superseded by it.

Comparing 1j against the built table showed what had been dropped on the way: the action timer,
the `STACK 1,240 · 620BB` dual chip format, the emote/throw control, and the Notes and Stats
rail tabs. The first two shipped in Phase 1. The emote/throw control and the two rail tabs are
still missing.

## Decisions still open

One pick needed per group before any of that group gets built:

- [ ] **Landing** — 1a, 1b or 1c
- [ ] **Join flow** — 1d, 1e or 1f
- [ ] **Host model** — 1g, 1h or 1i. This is a *rules* decision as much as a layout one; it
      belongs in `HOUSE-RULES.md` once made
- [x] **Settings** — **1p**, chosen 19 Sep 2026
- [ ] **Leaderboard placement** — 2a, 2b or 2c
- [ ] **Table** — 1j is built, but 1k and 1l are still live alternatives if the layout is ever
      revisited

## What the kit does NOT cover

The kit is **24 desktop frames**. There is no mobile frame in it at all, and the app is meant to
be played on phones — `styles.css` already has 900px and 520px breakpoints that no wireframe
describes. Also missing, and all of them are states where layouts break:

- [ ] Table on mobile — 6-handed and 9-handed. **The most important missing screen**
- [ ] Table, heads-up
- [ ] Action bar states: facing a bet / can check / all-in only / not your turn
- [ ] Three-way all-in with two side pots — where do the pot labels go?
- [ ] Showdown, including show-one-card
- [ ] A player disconnected or sitting out
- [ ] Tournament *in play* — blind clock, level, next level, players remaining. 1i is the setup
      sheet only
- [ ] The Fair tab / verification view

## What a wireframe decides — and doesn't

**Does decide:** what elements exist on screen, where they sit relative to each other, hierarchy
and relative size, what appears and disappears per state, responsive behaviour, flow between
screens.

**Does not decide:** exact colours, exact spacing values, type sizes, border radii, animation
timing. Those come from `packages/tokens` and are the same everywhere. If a wireframe implies a
colour or spacing that isn't in the tokens, that's a conversation, not a licence to hardcode
(hard rule 7).

The kit's own README says to recreate the designs "pixel-perfectly". That is the design tool's
default advice and it is **wrong for this repo** — these are wireframes, and the tokens are the
source of truth for anything visual. Take layout and hierarchy from a frame; take colour,
spacing and type from `packages/tokens`.

## Naming, for raster wireframes

`<screen>--<state>--<breakpoint>.png` in `docs/design/wireframes/`.

```
table--6handed--mobile.png
table--allin-sidepots--desktop.png
table--showdown--mobile.png
lobby--empty--mobile.png
settings--player-skin--desktop.png
```

Breakpoints: `mobile` (390×844), `tablet` (768×1024), `desktop` (1440×900). Add a row to the
index above for every image, with the same Status vocabulary.
