# Wireframe index

Claude Code reads this file automatically (it's imported from `CLAUDE.md`). It cannot see the
images until told to open one — so **this index is what makes the wireframes discoverable.**
Every image gets a row. An image with no row here is invisible to the workflow.

Keep images in `docs/design/wireframes/`. Version-controlled, so a wireframe change shows up in
the diff alongside the code change.

## Naming

`<screen>--<state>--<breakpoint>.png`

```
table--6handed--mobile.png
table--allin-sidepots--desktop.png
table--showdown--mobile.png
lobby--empty--mobile.png
settings--player-skin--desktop.png
```

Breakpoints: `mobile` (390×844), `tablet` (768×1024), `desktop` (1440×900).

## Index

| File | Screen | State | Breakpoint | Specifies | Status |
|---|---|---|---|---|---|
| _(add rows as you draw)_ | | | | | |

**Status:** `draft` (don't build from it yet) · `approved` (build this) · `superseded` (kept for
history; note what replaced it). Claude only builds from `approved`.

**Specifies** is the important column — write what the wireframe is actually deciding, e.g.
"seat positions and action bar layout, NOT colour" or "empty-state copy". Without it, Claude
has to guess how literally to take the drawing, and it will guess wrong in both directions.

## What a wireframe decides — and doesn't

**Does decide:** what elements exist on screen, where they sit relative to each other, hierarchy
and relative size, what appears/disappears per state, responsive behaviour, flow between screens.

**Does not decide:** exact colours, exact spacing values, type sizes, border radii, animation
timing. Those come from `packages/tokens` and are the same everywhere. If a wireframe implies a
colour or spacing that isn't in the tokens, that's a conversation, not a licence to hardcode
(hard rule 7).

## States that need a wireframe before week 5

Poker has more states than most apps and the awkward ones are where layouts break. Draw at
minimum:

- [ ] Table, 6-handed, mid-hand, mobile — **the most important screen in the app**
- [ ] Table, 9-handed, mobile (does it still work with nine seats?)
- [ ] Table, heads-up
- [ ] Action bar: facing a bet / can check / all-in only / not your turn
- [ ] Bet-sizing control (slider + pot-fraction shortcuts)
- [ ] Three-way all-in with two side pots — where do the pot labels go?
- [ ] Showdown, including show-one-card
- [ ] A player disconnected / sitting out / busted
- [ ] Empty table, waiting for players
- [ ] Lobby: cash tables + tournaments list
- [ ] Tournament view: blind clock, level, next level, players remaining
- [ ] Settings: table theme picker, player skin picker
- [ ] Hand history browser + replayer
- [ ] Fairness / verify page

Desktop versions of the table and lobby. The rest can be mobile-only — desktop is the easy one
once mobile works.
