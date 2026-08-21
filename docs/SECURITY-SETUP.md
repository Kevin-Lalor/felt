# Security setup — self-hosted, invite-only

Step-by-step for getting your home machine serving the app to exactly nine people and nobody else.

**Four independent layers.** Any one alone would mostly do the job; together they mean a single
mistake in one layer isn't a breach.

| Layer | Stops | Set up in |
|---|---|---|
| 1. Cloudflare Tunnel + Access | Scanners, the whole internet, anyone not on the email allowlist | Week 0, ~45 min |
| 2. Passkeys + invite tokens | Anyone who somehow reaches the app without an invite | Week 0, ~3 hrs |
| 3. Sessions, validation, rate limits | Session theft, malformed input, abuse | Weeks 0 & 3 |
| 4. In-game trust: audit log, public chip adjustments | Suspicion among friends | Weeks 4–6 |

---

## Layer 1 — Cloudflare Tunnel (do this instead of port forwarding)

### Why not port forwarding

Opening a port on your router means: your home IP is public and in scanner logs within hours, you
own TLS certificate renewal forever, a dynamic IP breaks your domain, and every unpatched service
on your LAN is one misconfiguration away from exposure. There is a free option that removes all of
that, so take it.

A tunnel works the other way round: `cloudflared` on your machine makes an **outbound** connection
to Cloudflare and holds it open. Cloudflare forwards requests down that connection. **You open zero
inbound ports.** Your home IP never appears in DNS.

### Setup

**1. Get a domain.** Any registrar, ~€10/yr. Point its nameservers at Cloudflare (free plan).

**2. Install `cloudflared` on the home machine**

```bash
# Debian/Ubuntu
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
  https://pkg.cloudflare.com/cloudflared any main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared

# macOS
brew install cloudflared
```

**3. Create and route the tunnel**

```bash
cloudflared tunnel login                      # opens a browser, pick your domain
cloudflared tunnel create poker               # note the tunnel UUID it prints
cloudflared tunnel route dns poker poker.yourdomain.com
```

**4. Configure** — `~/.cloudflared/config.yml`:

```yaml
tunnel: <UUID from step 3>
credentials-file: /home/you/.cloudflared/<UUID>.json

ingress:
  - hostname: poker.yourdomain.com
    service: http://localhost:3000
    originRequest:
      noTLSVerify: true          # local hop only; Cloudflare↔browser is still TLS
      connectTimeout: 10s
  - service: http_status:404     # everything else is refused
```

**5. Run it as a service** so it survives reboots:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

You now have `https://poker.yourdomain.com` with automatic TLS, no open ports, and your home IP
hidden. Verify: `curl -I https://poker.yourdomain.com` should hit your local server.

### Cloudflare Access — the email allowlist, enforced before traffic reaches you

This is the highest-value 10 minutes in the whole security setup.

Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → **Add an application** →
*Self-hosted*.

- Application domain: `poker.yourdomain.com`
- Session duration: 1 month (so friends aren't re-authenticating every game night)
- **Policy:** Action *Allow*, Include → **Emails** → paste your nine friends' addresses
- Identity provider: **One-time PIN** (Cloudflare emails a code — no accounts to create, works
  for everyone) or Google if they all have Gmail

Result: an uninvited request never reaches your machine at all. It's stopped at Cloudflare's edge.
This is a genuinely different kind of protection from application-level auth — it means a
zero-day in your Node server is not reachable by a stranger.

**Bypass path for the API:** WebSockets work fine through Access, but if you hit friction, add a
second Access application for `poker.yourdomain.com/ws` with a *Service Auth* policy, or exclude
the WS path and rely on cookie auth there (layer 2 still covers it).

### Alternative: Tailscale

If you want maximum lockdown and don't mind friction: install Tailscale on your machine and have
friends join your tailnet. The app is then unreachable from the public internet entirely. It's
more secure and a worse experience — every friend needs the Tailscale app running to play. For a
casual "tap the link on the couch" home game, **Cloudflare Tunnel + Access is the better trade**.

---

## Layer 2 — Passkeys and invite tokens

### Why passkeys

Face ID / fingerprint / device PIN, no password to leak or reuse, phishing-resistant by
construction (the credential is bound to your domain), and on a phone the experience is one tap.
For a nine-person app there is no reason to build password auth.

`@simplewebauthn/server` + `@simplewebauthn/browser` handle the protocol. Keep a **magic-link
email fallback** for the friend with the awkward device — one route, low cost, saves an evening
of debugging someone's Android.

### The invite flow

```
You (owner)                     Friend
    │
    ├─ POST /admin/invites  { email }
    │     server: signs a token = HMAC(secret, {email, jti, exp})
    │             stores {jti, email, exp, usedAt: null}
    │
    ├─ send link ──────────────► https://poker.you.com/join?t=<token>
    │                                │
    │                                ├─ GET /join?t=…
    │                                │   server: verify signature, not expired, not used,
    │                                │           email on allowlist
    │                                │
    │                                ├─ passkey registration ceremony
    │                                │
    │                                └─ POST /join/complete
    │                                    server: ATOMICALLY mark token used AND create the
    │                                            account, in one transaction
```

**The atomicity matters.** A check-then-use pattern is a race: two simultaneous requests both see
`usedAt: null` and both create accounts. In SQLite:

```sql
UPDATE invites SET used_at = ?, used_by = ?
WHERE jti = ? AND used_at IS NULL;
-- if changes() === 0, the token was already used. Reject. No account created.
```

Do the account creation in the same transaction. This is the kind of thing the
`security-reviewer` agent is specifically told to look for.

### Rules for the invite system

- **No public signup route exists.** Not hidden, not behind a feature flag — absent from the
  router. `POST /register` should 404.
- Tokens: single-use, 7-day expiry, bound to one email, signed with a secret from env.
- The **allowlist table** is the authority. Membership is re-checked on every session refresh,
  not just at login — so when you remove someone, they're out within a minute rather than
  whenever their session happens to expire.
- Only the owner role can mint invites. Every invite minted, redeemed, or revoked writes to the
  audit log.

### Bootstrapping yourself

First run: if the `users` table is empty and `OWNER_EMAIL` is set in env, the server allows one
passkey registration for that email and assigns the `owner` role. Then that path closes
permanently (guard on `users.count === 0`). Simple, and it can only ever fire once.

---

## Layer 3 — Sessions, transport, validation

### Cookies

```ts
{
  httpOnly: true,          // JS can't read it — XSS can't steal the session
  secure: true,            // HTTPS only
  sameSite: 'lax',         // CSRF protection; 'lax' keeps the invite link flow working
  path: '/',
  maxAge: 60 * 15          // access token: 15 minutes
}
```

Refresh token in a separate httpOnly cookie, longer-lived, **rotated on every use**, with **reuse
detection**: if a refresh token is presented twice, that means it was stolen — invalidate the
entire session family and force re-authentication. This is standard and worth doing properly.

### WebSocket

Authenticate the upgrade from the **same session cookie**. Never a token in the query string —
query strings end up in access logs, browser history, and referrer headers.

```ts
server.on('upgrade', async (req, socket, head) => {
  const session = await sessionFromCookie(req.headers.cookie)
  if (!session || !(await isOnAllowlist(session.userId))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, session))
})
```

### Every inbound message

```ts
ws.on('message', raw => {
  // 1. bound the size before parsing anything
  if (raw.length > 4096) return close(ws, 'oversized')

  // 2. parse — never trust the shape
  const parsed = ClientMessage.safeParse(JSON.parse(raw))
  if (!parsed.success) return send(ws, { type: 'error', code: 'malformed' })

  // 3. authorize: does this connection own this seat?
  if (!ownsSeat(session.userId, parsed.data.seat)) return audit('seat-spoof', session)

  // 4. is it even their turn?
  if (table.state.actingSeat !== parsed.data.seat) return send(ws, { type:'error', code:'notYourTurn' })

  // 5. only now does the engine see it
  const result = applyAction(table.state, parsed.data)
})
```

**Order matters.** Parse → authorize → turn-check → apply. Never mutate before validating.

### Rate limits

| Surface | Limit |
|---|---|
| Login / invite redemption | 5 per 15 min per IP |
| Chat | 1 msg/sec, 280 chars |
| Emotes | 1 per 2 sec |
| Throwables | 1 per 3 sec, 5 per hand |
| Reconnects | 10 per minute |
| Avatar upload | 3 per day, 2 MB, re-encoded server-side |

### Headers

`helmet` with a strict CSP: no inline scripts, no `unsafe-eval`, `frame-ancestors 'none'`,
`object-src 'none'`. Vite's build supports this fine with nonces.

### Avatar uploads (a real attack surface)

Never serve user-uploaded bytes as-is. On upload: verify the content type from the file's magic
bytes not the header, cap dimensions and size, **re-encode** through `sharp` to a fixed size and
format, strip all EXIF (it contains GPS), and serve from a path that cannot execute anything.

---

## Layer 4 — In-game trust

Security is not only about outsiders. Half the point of this project is that your friends believe
the game is straight.

- **Every chip adjustment is publicly visible in-app.** Who, when, how much, why. If you top
  someone up mid-cash-game, everyone sees the entry. This is a database table and a list view,
  and it is the single most effective anti-suspicion feature you can build.
- **Audit log** for every admin action, written before the action takes effect, immutable,
  visible to the owner and summarized publicly.
- **Hand histories public** to all players after each hand completes. Nothing hidden.
- **Seats randomized** at table start by default.
- **No spectator sees hole cards.** An observer sees exactly what a folded player sees. If you
  ever want a commentary mode, it goes on a delay — never live.
- **Admins do not get live hole cards either.** If any admin view could expose them, that's a
  CRITICAL finding. Build the admin panel on top of the same redaction function.
- **Written disconnect and timebank policy** in `HOUSE-RULES.md`, decided before it comes up in
  anger.

---

## Week 0 checklist

- [ ] Domain bought, nameservers pointed at Cloudflare
- [ ] `cloudflared` installed and running as a service
- [ ] `poker.yourdomain.com` serving a hello-world from localhost:3000
- [ ] Cloudflare Access application created, One-time PIN, nine emails on the policy
- [ ] Verified: an email **not** on the list is refused at the Cloudflare edge
- [ ] Secrets generated (`openssl rand -hex 32`) and in `.env`, `.env` in `.gitignore`
- [ ] Owner bootstrap works; the bootstrap path closes after first use
- [ ] Passkey registration + login working end to end
- [ ] Invite token: mint → redeem → second redemption of the same token is rejected
- [ ] Session cookie flags verified in dev tools (httpOnly, Secure, SameSite)
- [ ] WebSocket upgrade rejects an unauthenticated connection
- [ ] Rate limit on the login route verified by hammering it
- [ ] `pnpm audit` clean, Dependabot enabled on the repo
- [ ] Removed a test user from the allowlist and confirmed they're kicked within a minute

## Ongoing

- `pnpm audit` in CI on every PR; Dependabot PRs reviewed weekly (Saturday session)
- Rotate `SESSION_SECRET` and `INVITE_TOKEN_SECRET` if a machine is ever compromised — this
  invalidates all sessions and pending invites, which is the correct behaviour
- Run `/leak-check` before any PR touching the protocol
- Full security review pass in week 10, and once a quarter after that
