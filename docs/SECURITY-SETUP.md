# Going online — the runbook

The exact steps to put FELT on the internet for a handful of friends, as decided on
**11 Oct 2026**. Follow it top to bottom the first time; the later sections are for game nights.

**The setup, in one breath.** The server runs on Kevin's computer at home and listens only on that
computer (`127.0.0.1`). `cloudflared`, also on that computer, holds an outbound connection to
Cloudflare. Friends open `https://poker.<your domain>`; **Cloudflare Access** stops anyone whose
email is not on the list, before a single byte reaches home. Behind that, the **invite code** is
the second lock. No ports are opened on the router. There is no other login system.

| Layer | Stops | Status |
|---|---|---|
| 1. Cloudflare Tunnel + Access (email allowlist, one-time PIN, 30-day login) | The whole internet, scanners, anyone not invited | **Decided — this runbook** |
| 2. Passkeys, invite tokens, session cookies | — | **NOT PLANNED.** Replaced by Access + the invite code, by decision |
| 3. The app's own checks: invite code with lockout, rate limits, validation, headers | Mistakes in layer 1, a shared code, a misbehaving friend | **Built** (PR "security hardening", Oct 2026) |
| 4. In-game trust: public chip log, hand histories, provable shuffle | Suspicion among friends | **Built**, see the end |

Everything below assumes **Windows** on the home computer, because that is what it is. macOS and
Linux commands are given where they differ.

---

## 1. Buy the domain

The domain has to use **Cloudflare's nameservers** — that is what lets Cloudflare put Access in
front of it. Two ways:

- **Simplest: buy it from Cloudflare.** Dashboard → **Domain Registration** → **Register
  Domains**, search for the name. Cloudflare sells at cost (roughly €10 a year for a `.com`) and
  the nameservers are already right. Cloudflare does **not** sell every ending — many country
  endings are missing — so if the one you want is not offered, use the second way.
- **Otherwise buy it anywhere**, then in Cloudflare: **Add a domain** (free plan) → it gives you
  two nameserver names → at the registrar where you bought it, replace its nameservers with
  those two. It can take from minutes to a day; Cloudflare emails you when the domain is active.

Pick a subdomain for the game. This runbook uses `poker.yourdomain.com`; use your real one
everywhere it appears.

## 2. Install `cloudflared` on the home computer

Windows (PowerShell):

```powershell
winget install --id Cloudflare.cloudflared
```

macOS: `brew install cloudflared`. Debian/Ubuntu: Cloudflare's apt repository —
`https://pkg.cloudflare.com/`.

## 3. Create the tunnel and point it at the game

The tunnel is created in the dashboard (a "remotely managed" tunnel), so there is no config file
to keep on the home computer.

1. Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** (newer dashboards say
   **Networking → Tunnels**) → **Create a tunnel** → type **Cloudflared**.
2. Name it `felt`. Save.
3. The next screen shows an install command with a long token in it, for each operating system.
   Copy the **Windows** one and run it in a PowerShell **opened as Administrator**. It looks like:

   ```powershell
   cloudflared.exe service install <TOKEN>
   ```

   That installs `cloudflared` as a Windows service, so it starts with the computer. The dashboard
   shows the connector as **Healthy** within a minute. **The token is a secret** — anyone with it
   can run your tunnel. Don't paste it anywhere else, and never into this repo.
4. Add the route to the game. On the tunnel: **Public Hostname** → **Add a public hostname**
   (newer dashboards: the **Routes** tab → **Add route** → **Published application**):
   - Subdomain: `poker` · Domain: `yourdomain.com` · Path: *(empty)*
   - Service type: **HTTP** · URL: **`localhost:8090`**

   Not 3000 — earlier versions of this doc said 3000, which is wrong. The game listens on **8090**.
   Saving this creates the DNS record for you.

**Do not stop here and test from your phone.** Until step 4 is done, the hostname is open to the
whole internet with only the invite code in the way.

## 4. Put Cloudflare Access in front — before anyone gets the link

1. **Turn on one-time PIN as a login method.** Zero Trust → **Settings** → **Authentication** →
   **Login methods** → **Add new** → **One-time PIN**. Nothing to configure: Cloudflare emails a
   six-digit code to whoever is trying to log in.
2. **Create the application.** Zero Trust → **Access** (newer dashboards: **Access controls**) →
   **Applications** → **Add an application** → **Self-hosted**.
   - Application name: `FELT`
   - Domain: subdomain `poker`, domain `yourdomain.com`, path empty — the **whole** hostname,
     `/ws` included.
   - **Session duration: 1 month.** This is how long a login lasts before a friend has to type a
     code again — "a login lasts 30 days" was the decision.
   - Login methods: **One-time PIN** only. Turn on **Instant Auth** so friends go straight to the
     email box instead of a menu with one option.
3. **Add the policy.** In the same application → **Policies** → **Add a policy**:
   - Policy name: `Friends` · Action: **Allow**
   - Include → **Emails** → type each friend's address, and your own.
   - Session duration: **Same as application session timeout**.
   - Save the policy, then save the application.

Optional but tidy: Zero Trust → **Settings** → **Authentication** → **Global session timeout**,
set to **1 month** too, so nothing shorter sneaks in.

### Check it before telling anyone

From a phone **on mobile data** (not your home wifi):

1. Open `https://poker.yourdomain.com`. You should see **Cloudflare's** login page, not the game.
2. Enter an email that is **not** on the list. You must not get in.
3. Enter yours, type the code from the email. You should land on the FELT join screen.

## 5. Run the game server

On the home computer, in the repo folder (`G:\poker`), after `git pull`:

```powershell
pnpm install
pnpm build                        # builds the web app the server serves
$env:INVITE_CODE = "<invite code>"
$env:HOST_CODE   = "<host code>"
pnpm --filter @poker/server start
```

- **Codes.** Leave both unset the first time: the server makes strong random 16-character ones
  and prints them. Copy them into the two lines above from then on, so they survive restarts.
  If you set your own, each must be **at least 12 characters** and the two must differ; a blank,
  short or matching code stops the server from starting, on purpose.
- **Keep the server on `127.0.0.1`.** That is the default and it is what makes Access mean
  something: `cloudflared` is on the same computer, so it is the only thing that needs to reach
  the game. Setting `HOST=0.0.0.0` lets any device on your home network open the game directly,
  **skipping the Access login** — only ever do that briefly for testing on the LAN, never on a
  game night.
- **Sleep.** The computer must not sleep while hosting (Windows: Settings → System → Power →
  sleep **Never** while plugged in). Table state is in memory: if the server stops, the table is
  forgotten. Hand histories survive in `apps/server/data/history.jsonl`.
- **Friends from one house.** Limits are counted per address, and people on the same wifi share
  one. If several friends play from the same house, raise `MAX_PLAYERS_PER_IP` (default 4) and
  `MAX_CONNECTIONS_PER_IP` (default 8) before starting.

Share `https://poker.yourdomain.com` and the **invite code**. Keep the host code to yourself — it
makes whoever uses it host.

## 6. The game's WebSocket goes through Access

The table runs over a WebSocket at `/ws` on the same hostname. When the page opens it, the browser
sends the Access login cookie (`CF_Authorization`) with the upgrade request, exactly as it does
for the page, because it is the same site. Access checks it and lets the socket through. **There
is no need to exclude `/ws` from Access, and you must not**: earlier versions of this doc
suggested a bypass "relying on cookie auth" — that auth does not exist, and the bypass would leave
the invite code as the only lock on the table.

**How to confirm it works.** On a laptop, logged in through Access: open the game, press F12 →
**Network** → filter **WS** → reload. The `/ws` row should show status **101** and stay open, and
the table should not say *reconnecting…*. In the server window you'll see `"url":"/ws"` lines.

**If it doesn't:**

1. Cloudflare dashboard → your domain → **Network** → **WebSockets** must be **On** (it is by
   default).
2. In the tunnel's route the service must be **HTTP** to `localhost:8090` — not HTTPS. If the
   page itself shows a Cloudflare **502**, try `127.0.0.1:8090` instead of `localhost:8090`.
3. Check that the cookie exists: F12 → **Application** → **Cookies** → `CF_Authorization` for
   `poker.yourdomain.com`. If it is missing or expired, reload the page and log in again.
4. Access is checked when the socket **opens**, not afterwards. A socket that is already open
   keeps working when a login expires; the next reconnect sends the friend to the login page,
   which a socket cannot show. If the table says *reconnecting…* for more than a few seconds,
   **reload the page**.

The server pings every socket every 25 seconds, which keeps the connection from going idle — and
Cloudflare closes idle WebSockets. A socket that stops answering is closed within a minute, and
the player is sat out as if they had disconnected (HOUSE-RULES #8, #9).

## 7. Adding and removing friends

**Add a friend.** Zero Trust → Access → Applications → `FELT` → **Policies** → `Friends` → add
their email under Include → **Emails** → Save. Send them the link and the invite code. Their first
visit asks for their email and emails them a code; after that they are in for 30 days.

**Remove a friend.** Do all three:

1. **Off the list.** Same place — delete their email from the policy and Save. They can no longer
   log in.
2. **End their current login.** Zero Trust → **My Team** → **Users** → find them →
   **Revoke session**. Without this, a login they already have keeps working until it expires.
3. **Off the table, if they are on it.** In the game, Host tab → **Remove** (HOUSE-RULES #14). An
   already-open socket is not cut by Access, so this is what closes it.

**Change the invite code** if they might have shared it: restart the server with a new
`INVITE_CODE`. Everyone already seated keeps playing; new joins need the new code.

---

## Layer 2 — passkeys, invite tokens, session cookies: NOT PLANNED

Earlier versions of this document described passkeys, signed single-use invite tokens, an owner
bootstrap, refresh-token rotation and an allowlist table, as if they were coming. **They are not.**
On 11 Oct 2026 the decision was Cloudflare Access with an email allowlist and one-time PIN, plus
the invite code. Access does the identity part — who is allowed in, and logging them in — better
than this app could, and it does it before the request reaches home. None of that design will be
built; if the hosting decision ever changes, design it again from the new situation.

## Layer 3 — what the app itself does

All of this is in `apps/server/src` and has tests in `apps/server/__tests__/security.test.ts`.

- **The invite code** is required to join the table and to read hand history (sent in a header,
  never in a URL). It is compared in constant time and case-insensitively.
- **Wrong codes lock you out.** 8 wrong codes in 15 minutes locks that visitor out for 15 minutes,
  even with the right code — across the join and the history API together. Behind the tunnel the
  visitor is identified by `CF-Connecting-IP` (IPv6 by its /64); that header is only believed
  when the request came from this computer, i.e. through `cloudflared`.
- **One connection, one player.** At most 8 open connections and 4 players per address (both
  configurable, see step 5). A connection that hasn't joined within 10 seconds is closed.
- **Rate limits** per player: chat 3 at once then 1/s; emotes 2 then one per 2 s; skin and seed
  changes; sitting, standing, sitting out and back, top-ups and shows together 6 then 1/s. And
  every connection has an overall budget — a flood closes it.
- **Validation.** Every message is parsed against the protocol before anything else looks at it
  (hard rule 6). Names are normalised and limited to European Latin letters, so look-alikes from
  other alphabets are refused, and names that look the same count as the same name. Emotes come
  from a fixed list.
- **Headers.** helmet with a Content-Security-Policy (no inline scripts, no `eval`, no framing),
  `X-Robots-Tag: noindex`, and a `robots.txt` that disallows everything. Query strings are blanked
  in the server log.
- **Only the host deals** the first hand or deals early; otherwise the server deals on its own.

## Layer 4 — in-game trust

- **Every chip adjustment is public** in the Chips tab: buy-ins, top-ups, posts, and removals by
  the host.
- **Hand histories** are open to the table after each hand, with every card shown down or shown
  by choice. Mucked hands stay hidden (HOUSE-RULES #16).
- **The shuffle is provable.** Commit-reveal with every player's seed in it; `pnpm verify-hand`
  re-derives any hand outside the app (`docs/FAIRNESS.md`).
- **Nobody sees live hole cards but their owner** — the host included. Every view goes through the
  same redaction (`apps/server/src/redact.ts`). The one honest exception: the server runs on
  Kevin's computer, so whoever controls that computer could read its memory. That is what
  commit-reveal protects against for the *deck*; it cannot hide cards from the machine dealing
  them.
- **Disconnects and sitting out** follow HOUSE-RULES #6–#12, written down before they come up.

---

## First-night checklist

- [ ] Domain active on Cloudflare
- [ ] `cloudflared` installed as a service; tunnel `felt` **Healthy**
- [ ] Route `poker.yourdomain.com` → HTTP `localhost:8090`
- [ ] One-time PIN login method on; Access application covers the whole hostname; session 1 month
- [ ] Policy `Friends` lists every email, yours included
- [ ] From mobile data: an email **not** on the list is refused; yours gets in
- [ ] Server started with your own `INVITE_CODE` and `HOST_CODE`, listening on `127.0.0.1`
- [ ] Laptop on Access: F12 shows `/ws` at **101**; the table is not *reconnecting…*
- [ ] A friend joins from their phone and plays a hand against a bot (`pnpm bot Mo --code …`)
- [ ] Computer set not to sleep

## Ongoing

- Before a game night: `git pull`, `pnpm install`, `pnpm build`, restart the server.
- Dependabot PRs and `pnpm audit` — review them on the weekly session.
- If the home computer is ever compromised: change both codes, rotate the tunnel token (delete
  and recreate the tunnel), and revoke everyone's Access sessions.
- Run `/leak-check` before any PR touching the protocol.
