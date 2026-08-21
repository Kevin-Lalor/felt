# Rollback

Test this once, on a quiet evening, before you need it. An untested rollback is not a rollback.

## 1. Roll back the app

```bash
git tag --sort=-creatordate | head -5     # find the last known-good tag
git checkout v0.4.1
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart poker              # or: docker compose up -d --build
curl -sf https://poker.example.com/healthz && echo OK
```

Do NOT `git reset` anything already deployed. If the bad code is on `main`:

```bash
git revert <bad-sha>        # creates a new commit; history stays honest
git push
```

## 2. Roll back the database

Snapshots live in `./snapshots/` (nightly, 7-day retention) plus continuous Litestream replication.

```bash
sudo systemctl stop poker
cp data/poker.db data/poker.db.broken-$(date +%s)     # keep the evidence
cp snapshots/poker-2026-07-25.db data/poker.db
sudo systemctl start poker
```

Litestream point-in-time restore:

```bash
litestream restore -timestamp 2026-07-25T21:00:00Z -o data/poker.db <replica-url>
```

## 3. If a game is live right now

1. Post in the group chat: "pausing, back in 5."
2. Pause the table from the admin panel (`/admin` → Table → Pause). This freezes state and
   stops the action clock; it does not end the hand.
3. Roll back the app only (step 1). Do NOT roll back the database mid-session — you will
   destroy the current hand and everyone's stacks.
4. Resume the table. If the current hand is unrecoverable, void it: every player's contribution
   is returned from the pot. Announce it. `/admin` → Table → Void Hand does this and logs it.

## 4. Afterwards

Write what happened in `docs/incidents/YYYY-MM-DD.md`. One paragraph is enough. The point is
the next person (you, in three months) knows what to check first.
