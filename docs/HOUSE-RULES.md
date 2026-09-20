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
| 6 | Sitting out (cash) | You keep your seat and stack and are **dealt out entirely** — no cards, no blinds, no antes. Button and blinds skip the seat. Sitting out is not leaving | 2026-09-20 |
| 7 | Coming back | Press **I'm back**. If the big blind has not passed your seat while you were out, you are dealt into the next hand as normal. If it has, you choose: **post** the big blind now and play the next hand, or **wait** until the big blind reaches you. The post is **dead** — it goes to the pot and is not your bet, so you still owe a call. Coming back costs **one full orbit, never less**: land on the big blind and that is your payment; land on the small blind and you pay it *plus* the dead post; anywhere else you just post. Posting is never cheaper than waiting, and neither is cheaper than staying | 2026-09-20 |
| 8 | Entering sitting-out | Four ways: you press **Sit out**; your action clock expires; you disconnect with no live hand; or you disconnect holding cards and then let the clock expire | 2026-09-20 |
| 9 | Disconnecting mid-hand | Your clock runs its full length, so you have that long to reconnect and play the hand out. Nothing is auto-folded early — a live hand is yours | 2026-09-20 |
| 10 | Sat out mid-hand | Any remaining decisions in that hand resolve **immediately** on the usual policy — check when it is free, fold when facing a bet — with no clock. The table waits for you once per absence, never twice | 2026-09-20 |
| 11 | Sit out while in a hand | Pressing **Sit out** during a live hand finishes that hand normally and takes effect from the next one. Between hands it takes effect at once | 2026-09-20 |
| 12 | Abandoned seats | A seat is **never** taken from a sitting-out player automatically, however long they are gone. Leaving is a separate, deliberate act | 2026-09-20 |

## To decide before launch

Leave these here until decided, then move them up with a date.

- [ ] **Action clock** — how long to act? (suggested: 25s + 3× 30s timebank chips per session)
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

## Notes on rules 6-12

**Why cash and tournament differ.** In a tournament you cannot dodge blinds — sitting out still
posts them and blinds you away, and you are dealt cards that fold on your turn. Rules 6-12 above
describe the **cash** game, where sitting out means dealt out entirely and costs you nothing.
There is no tournament code in the repo yet; when it arrives, the sit-out behaviour is the
variant that changes, and it changes here first.

**Why a post is dead money.** If a returning player's post counted as their bet, sitting out
would become a way to see hands cheaply: sit out, come back on the button, post, and take a free
look. Dead means you pay the blind either way — you only choose *when*.

**Why the small blind posts too.** `missedBlind` is set exactly when the big blind jumps past
your empty seat, so the next blind to reach you on return is the *small* one. Charging only that
would mean paying 1 for an orbit that costs everyone else 3 — sitting out would be the cheapest
seat at the table, and the button labelled "Post" would be the dodge. Paying the small blind live
plus the big blind dead is one orbit's worth, which is what everyone else pays.

**Why the clock still runs for a disconnected player holding cards.** It is the one place the
table has to wait, and it is worth it: a live hand belongs to the player who was dealt it, and
folding it the instant their wifi drops would be worse than 45 seconds of quiet. The cost is
capped by rule 10 — after that one clock they are out, and the table never waits for them again.

## Voided hands

Any hand voided for technical reasons is logged here with the hand ID and reason. Transparency
is the point — if it happens and isn't written down, someone will remember it differently.

| Hand ID | Date | Reason | Resolution |
|---|---|---|---|
| — | — | — | — |
