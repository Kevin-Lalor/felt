# @poker/engine

Pure No-Limit Hold'em. No I/O, no network, no `Date.now()`, no randomness, **no dependencies**.
The deck arrives as a parameter. Time arrives as a parameter.

Full spec: [`../../docs/ENGINE-SPEC.md`](../../docs/ENGINE-SPEC.md)

```bash
pnpm test:engine      # <2s. Run this constantly.
pnpm test:property    # fast-check, ~60s. Run before every PR.
```

`pokersolver` is a **devDependency only** — it is the oracle the hand evaluator is validated
against in tests. It must never be imported from `src/`.
