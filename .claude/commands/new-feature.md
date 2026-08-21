---
description: Start a new feature — branch, plan, tests-first, draft PR
---

Start work on: **$ARGUMENTS**

Do these in order. Do not skip ahead.

1. Confirm the working tree is clean and we're on `main` and up to date. If not, stop and say so.
2. Create a branch: `feat/<kebab-name>`.
3. **Enter plan mode.** Produce a plan covering: what changes, which packages, the data/protocol
   shape, the poker rules involved, what could break, and what tests prove it works.
   Explicitly list any `docs/HOUSE-RULES.md` decision this depends on — if one is missing or
   ambiguous, STOP and ask rather than assuming.
4. Wait for approval. Do not write files during planning.
5. If this touches `packages/engine`: write the test file(s) FIRST. Show me only the test names
   and let me confirm they describe the poker I actually play, before you implement anything.
6. Implement in small commits, Conventional Commits format.
7. Run `pnpm typecheck && pnpm lint && pnpm test:engine`. If the change touches the protocol or
   server, also run `pnpm test:leak`.
8. Open a **draft** PR with: what changed, why, which hard rules in CLAUDE.md are relevant, how
   it was tested, and what a reviewer should look at hardest.
