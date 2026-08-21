# @poker/tokens

The single source of visual truth. Three layers, one direction of reference:

```
core.json  ──►  semantic.json  ──►  components (CSS custom properties)
(raw values)    (meaning)           (usage)
```

**Components may only reference `semantic.json`.** Reaching into `core.json` from a component is
a design-system violation and the lint rule will catch it. If you need a value that doesn't exist,
add it to `semantic.json` first — that act of naming is what keeps the system coherent.

## Layers of customization

| Layer | Set by | Seen by | Examples |
|---|---|---|---|
| **Table theme** | Host, per table | Everyone, identically | felt, rail, background, card faces/backs |
| **Player skin** | Each player | **Everyone** — that's the point | avatar, chip style, fold style, chip shuffle, emote/throwable pack |
| **Local preference** | Each player | Only them | reduced motion, fast mode, four-colour deck, large text, sound, density |

A player skin being visible to others is what makes cosmetics worth having. A local preference
being invisible is what stops them being a competitive advantage.

## Build

`pnpm tokens` resolves `{refs}`, applies the active theme's overrides, and emits:

- `dist/tokens.css` — `:root { --felt-base: …; }` plus `[data-theme="midnight"] { … }` blocks
- `dist/tokens.ts` — typed constants for the rare case JS needs a value
- `dist/tokens.d.ts` — a union of every valid token name, so a typo is a type error

Tailwind v4's `@theme` consumes `tokens.css` directly. Switching a table theme is one attribute
on `<body>` — no rebuild, no re-render storm.

## Custom felt colours

The host can pick any felt colour. The picker runs a contrast check against `text.on-felt`,
`card.face-bg`, and every chip colour. If the choice fails WCAG AA, the picker warns and offers
the nearest passing shade. **This check is not optional** — a custom felt that makes chip
denominations unreadable is how you lose an argument about a pot at midnight.
