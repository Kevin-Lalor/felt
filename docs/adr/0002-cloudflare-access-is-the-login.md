# 0002 — Cloudflare Access is the login; the invite code is the second lock

- **Status:** accepted
- **Date:** 2026-10-11
- **Decided by:** Kevin
- **Supersedes:** "Layer 2 — Passkeys and invite tokens" and the session-cookie parts of
  "Layer 3" in earlier versions of `docs/SECURITY-SETUP.md`

## Context

The app has to be reachable by 6–9 friends from their phones and laptops, and by nobody else.
The server runs on Kevin's computer at home. Earlier docs planned an app-level account system —
passkeys, signed single-use invite tokens, refresh-token rotation, an allowlist table — none of
which was built. Meanwhile the only lock in the code was a shared invite code, and a security
review on 11 Oct 2026 showed that lock could be bypassed, blanked and guessed.

## Decision

- The server is reached only through a **named Cloudflare Tunnel** on Kevin's own domain. No
  ports are opened on the router.
- **Cloudflare Access** sits in front of the whole hostname, `/ws` included: an **email
  allowlist**, **one-time PIN** by email as the only login method, and a **30-day** session.
- The **invite code stays**, as a second lock behind Access, and the host code still makes the
  host. Both are hardened (minimum length, lockout on wrong guesses, never in URLs or logs).
- The server listens on **`127.0.0.1`** by default, so nothing on the home network can reach it
  around Access.
- **No other login system.** Passkeys, invite tokens and app sessions are **not planned**.

## Consequences

- Identity — who may come in, and logging them in — is Cloudflare's job, and happens before a
  request reaches home. A bug in the Node server is not reachable by a stranger.
- The app does not know who a player *is* beyond the name they type. Removing someone for good
  means taking their email off the Access policy (`docs/SECURITY-SETUP.md`, "Remove a friend");
  the in-game Remove only lasts until the server restarts (`HOUSE-RULES.md` #14).
- Behind the tunnel every request comes from `127.0.0.1`, so anything that counts per visitor
  uses `CF-Connecting-IP`, trusted only from loopback.
- Cloudflare closes idle WebSockets, so the server pings every socket every 25 seconds.
- If hosting ever moves off Cloudflare, the login question reopens from scratch; the Layer 2
  design in git history is a starting point, not a plan.
