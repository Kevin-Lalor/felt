---
description: Visual + accessibility review of the table at every breakpoint
---

Review the current UI. Target: **$ARGUMENTS** (default: the table view).

1. Start the dev server and capture screenshots at 390×844 (phone portrait), 768×1024 (tablet),
   1440×900 (laptop), 1920×1080 (desktop) — for these states: empty table, 6-handed mid-hand,
   9-handed, all-in with side pots, showdown, a disconnected player.
2. Run the `design:design-critique` skill on the captures. Focus on hierarchy (can I tell whose
   turn it is in under half a second?), density, and whether the action bar is reachable one-handed
   on the phone view.
3. Run the `design:accessibility-review` skill. Check specifically:
   - contrast of every text/chip/card element **against the felt colour currently in use**,
     including custom felt colours
   - touch targets ≥ 44px, and that Fold is not adjacent enough to Call to be mis-tapped
   - `prefers-reduced-motion` respected by every animation
   - keyboard bindings (F/C/R) work and are discoverable
   - four-colour deck mode; nothing conveys state by colour alone
4. Token audit: grep the changed components for hex codes, raw px, and raw ms durations.
   Any hit is a violation of hard rule 7.
5. Post findings as a PR comment, ranked: blocking / should-fix / nice-to-have.
