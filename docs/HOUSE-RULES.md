# House rules

**Every rules decision this game makes lives here.** Decide once, in writing, when nobody is
tilted. Claude Code is instructed never to invent a poker rule — if a situation isn't covered
here, it stops and asks, and the answer gets written down below.

Format: decision, date, and one line of reasoning. Append; don't rewrite history.

---

## Decided

| # | Rule | Decision | Date |
|---|---|---|---|
| 1 | Game | No-Limit Texas Hold'em | 2026-07-26 |
| 2 | Odd chip on a split pot | Goes to the first active seat left of the button | 2026-07-26 |
| 3 | All-in for less than a full raise | Does **not** reopen action for players who have already acted (standard casino rule) | 2026-07-26 |
| 4 | Heads-up blinds | Button posts the small blind, acts first pre-flop, last post-flop | 2026-07-26 |
| 5 | Money | Play money only. Chips are set manually by the host. No real-money path exists in the software, by design | 2026-07-26 |

## To decide before launch

Leave these here until decided, then move them up with a date.

- [ ] **Action clock** — how long to act? (suggested: 25s + 3× 30s timebank chips per session)
- [ ] **Disconnect policy** — auto-check/fold after N seconds? Grace period? Does the table pause
      for an all-in? (suggested: 60s grace, then auto-check/fold; table never pauses)
- [ ] **Sitting out** — how many hands before you're removed from a cash table?
- [ ] **Rebuy / top-up in cash** — any time, or only between hands? Max stack cap?
- [ ] **Run it twice** on all-ins — offered? Unanimous consent required?
- [ ] **Straddles** — allowed? UTG only, or button straddle too?
- [ ] **Seven-deuce / bomb pots** — off by default; who can enable?
- [ ] **String bets** — impossible in software, but confirm the bet-sizing UI can't create ambiguity
- [ ] **Show one card** — allowed at showdown as well as after a fold?
- [ ] **Chat during a live hand** — allowed? Disabled for players still in the hand?
- [ ] **Tournament chip-up rounding** — round up to nearest chip, or chip race?
- [ ] **Tournament late registration** — how many levels?
- [ ] **Tournament payouts** — structure by field size (e.g. 6–7 players pay 2, 8–9 pay 3)
- [ ] **Misdeal conditions** — in software the deal is always correct, but define what happens if
      a server fault voids a hand (suggested: all contributions returned, hand voided, logged)

## Voided hands

Any hand voided for technical reasons is logged here with the hand ID and reason. Transparency
is the point — if it happens and isn't written down, someone will remember it differently.

| Hand ID | Date | Reason | Resolution |
|---|---|---|---|
| — | — | — | — |
