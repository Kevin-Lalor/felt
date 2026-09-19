# 0001 — Card backs are a local preference, not part of the table theme

- **Status:** accepted
- **Date:** 2026-09-19
- **Supersedes:** the "Table theme" row of the three-layer model in `docs/DESIGN-SYSTEM.md`,
  insofar as it listed card backs

## Context

`docs/DESIGN-SYSTEM.md` splits cosmetics into three layers, and the split is deliberate:

| Layer | Set by | Visible to |
|---|---|---|
| Table theme | Host, per table | Everyone, identically |
| Player skin | Each player | Everyone at the table |
| Local preference | Each player | Only them |

Card backs were originally grouped with card faces under **Table theme** — one table, one deck,
everyone looking at the same cards.

That grouping does not survive contact with how the back is actually used. A card back is only
ever drawn on a **face-down** card, which means the back you spend the evening looking at is on
*other people's* cards, not your own. Your own cards are face-up to you. So "the table's card
back" is really "the back of everyone else's cards, as seen by you" — which is exactly the shape
of a local preference.

## Decision

Card back **pattern** and **colour** move to the **Local preference** layer. Each player picks
their own; nobody else sees the choice. Card *faces* stay in the table theme, alongside the
four-colour deck mode, which was already a local preference.

The table theme still supplies a default (`--card-back-bg` per theme), and a player who picks no
colour follows it. Choosing a pattern or colour overrides the theme for that player only.

## Why this is safe

The three-layer split exists so that a local preference can never become an advantage
(`DESIGN-SYSTEM.md`: *"A local preference is invisible because it must never become an
advantage."*). A card back carries no information:

- every face-down card in the app renders with the same back, so no back distinguishes one
  hidden card from another;
- the back is chosen client-side and never enters the protocol, so it cannot signal anything to
  another player;
- redaction is unaffected — hole cards are still absent from other players' payloads, and the
  back is drawn over nothing.

If a future change ever made the back vary per card, per seat, or per street, this decision must
be revisited, because that is the point at which a back starts carrying information.

## Consequences

- `prefs.ts` gains `cardBack` and `cardBackColour`; both are `localStorage`-only and applied as
  `data-card-back` / `data-card-back-colour` on the document root.
- `packages/tokens/semantic.json` gains eight `card.back-*` colour tokens so the picker has
  something token-backed to offer (hard rule 7).
- The host loses the ability to impose a card back on the table. Nobody asked for it and no
  wireframe shows it, so this costs nothing today.
- `docs/DESIGN-SYSTEM.md` is updated in the same commit.
