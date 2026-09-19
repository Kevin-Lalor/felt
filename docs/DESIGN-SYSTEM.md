# Design system

Three layers, one direction of reference. Full details in `packages/tokens/README.md`.

```
core.json  ──►  semantic.json  ──►  components
(raw values)    (meaning)           (CSS custom properties only)
```

Components may reference **only** `semantic.json`. That constraint is what makes every visual
decision themeable for free, and it's hard rule 7 in `CLAUDE.md`.

---

## Customization layers

| Layer | Set by | Visible to | Contains |
|---|---|---|---|
| **Table theme** | Host, per table | Everyone, identically | Felt colour/texture, rail, background, table shape, card faces, dealer button |
| **Player skin** | Each player | **Everyone at the table** | Avatar + frame, chip style, fold style, chip shuffle, emote pack, throwable pack, nameplate, win celebration |
| **Local preference** | Each player | Only them | Reduced motion, fast mode, four-colour deck, **card back pattern and colour**, large text, sound, layout density, auto-muck |

The split is deliberate: a player skin is visible to others because that's what makes cosmetics
worth choosing. A local preference is invisible because it must never become an advantage.

**Card backs moved** from Table theme to Local preference on 2026-09-19 — a back is only ever
drawn on a face-down card, so it is the back of *other people's* cards as seen by you, and it
carries no information. See `docs/adr/0001-card-backs-are-a-local-preference.md` for the full
reasoning and the condition that would reverse it.

Ships with four themes: Classic Green, Midnight, Vegas, Slate. Hosts can also pick a **custom
felt colour** — gated by the contrast check below.

---

## Measured contrast — read this before touching colour

These are real WCAG ratios computed from the shipped palette, not estimates.

**Text on felt**

| | Classic Green | Midnight | Vegas | Slate |
|---|---|---|---|---|
| `text.on-felt` (white) | 8.01:1 ✅ | 13.10:1 ✅ | 12.61:1 ✅ | 15.37:1 ✅ |
| `text.secondary` | 4.06:1 ⚠️ | 6.65:1 ✅ | 6.40:1 ✅ | 7.80:1 ✅ |
| `text.muted` | **2.47:1 ❌** | 4.04:1 ⚠️ | 3.89:1 ⚠️ | 4.74:1 ✅ |

→ **Rule: only `text.on-felt` and `text.on-felt-secondary` may be used on felt.** `text.muted`
and `text.secondary` are for panels, never the table surface.

**Chips on felt** — every chip colour fails on its own:

| | Classic Green | Midnight | Slate |
|---|---|---|---|
| chip red | 1.58:1 ❌ | 2.59:1 ❌ | 3.04:1 ⚠️ |
| chip blue | 1.58:1 ❌ | 2.59:1 ❌ | 3.04:1 ⚠️ |
| chip black | 2.13:1 ❌ | 1.30:1 ❌ | 1.11:1 ❌ |
| chip green | 1.98:1 ❌ | 3.24:1 ⚠️ | 3.81:1 ⚠️ |

→ **Rule: `chip.outline` (1.5px, rgba(255,255,255,.85)) is mandatory on every chip.** It is not
decoration — it is the only thing making a chip distinguishable from the felt. Removing it to
"clean up the look" breaks the table for anyone with reduced contrast sensitivity, which at a
poker table at 1am is everyone.

**Suits on the white card face** — all pass comfortably, including four-colour mode:
spade 17.76:1, heart 6.02:1, diamond (blue) 5.79:1, club (green) 5.39:1. ✅

**Custom felt picker:** must run this same check against `text.on-felt`, `card.face-bg`, and every
chip colour *including its outline*, and refuse or warn on a failing choice with a suggested
nearest passing shade. Non-negotiable.

---

## Motion

Every animation reads a `motion.*` duration token. Two global modifiers, both generated
automatically by the token build:

- `@media (prefers-reduced-motion: reduce)` → all motion durations become `0ms`
- `[data-motion="fast"]` → all motion durations halved

Poker gets tedious when animations are slow. Default to snappier than feels right, and make sure
**nothing blocks input** — a player must be able to act while chips are still flying.

---

## Hard UI constraints

- **Whose turn is it** must be answerable in under half a second, at a glance, on a phone.
  This is the most important thing on the screen; everything else is secondary.
- **Fold is destructive and irreversible.** `action.fold-separation` (24px) between Fold and
  Call/Check is mandatory and must not be reduced. Confirm dialog on fold-when-you-could-check-free.
- Touch targets ≥ 44px (`action.min-touch`).
- Four-colour deck available (`[data-deck="four-colour"]`); nothing conveys state by colour alone
  — folded, all-in, and sitting-out need a shape or label too.
- Keyboard on desktop: F fold, C check/call, R raise, arrows size the bet, Enter confirms.
- **Mobile-first.** Most of your friends will play on a phone on the couch. Design the phone
  view first; desktop is the easy one.

---

## Storybook

Build a story for every table state before building the cosmetics: empty seat, sitting out,
all-in, showdown, disconnected, heads-up, 9-handed, three-way side pot, mucked hand, show-one-card.

This is the biggest single accelerator for weeks 5 and 9 — it turns "deal hands until you reach
the state you want to style" into "click the story." Worth the setup cost on day one of week 5.

---

## Workflow with the design skills

| Skill | When |
|---|---|
| `design:design-system` | On adding a component family; full audit at week 6 |
| `design:design-critique` | After each visual milestone, **before** showing friends — spend their goodwill on gameplay feedback, not "the buttons are cramped" |
| `design:accessibility-review` | Mandatory gate before any theme ships, especially the custom felt picker |
| `design:ux-copy` | All-in confirmations, disconnect messaging, error states, empty lobby, and the fairness page — that page's copy matters more than its code |
| `design:design-handoff` | Write a spec for Claude to implement against; this is the "you direct, Claude builds" pattern in practice |
