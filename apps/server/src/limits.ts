// Who is knocking, and how often. Everything here is per-process and in
// memory: it resets when the server restarts, which is fine for limits whose
// job is to make guessing slow and flooding pointless, not to keep records.

import { isIP } from 'node:net';

// ------------------------------------------------------------ client address

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false;
  return LOOPBACK.has(address) || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

/** The address to count a request against.
 *
 *  Behind cloudflared every request arrives from 127.0.0.1, so the socket peer
 *  says nothing about who is on the other end — one guesser would lock out
 *  the whole table. Cloudflare puts the real client in CF-Connecting-IP. That
 *  header is only believed when the peer IS loopback, i.e. when it came
 *  through the tunnel on this machine: anyone reaching the server directly
 *  (the LAN, when HOST is widened for testing) could write any value they
 *  like into it and dodge their own lockout. */
export function clientAddress(
  peer: string | undefined,
  cfConnectingIp: string | string[] | undefined,
): string {
  if (isLoopback(peer) && typeof cfConnectingIp === 'string') {
    const forwarded = cfConnectingIp.trim();
    if (isIP(forwarded) !== 0) return addressKey(forwarded);
  }
  return peer === undefined ? 'unknown' : addressKey(peer);
}

/** One IPv6 visitor usually holds a whole /64 — every phone on a home network
 *  gets addresses from it, and anyone can pick a fresh one at will. Counting
 *  per /128 would give each of those a fresh wrong-code allowance, so IPv6 is
 *  counted per /64. IPv4 (and IPv4-mapped IPv6) is counted per address. */
export function addressKey(address: string): string {
  if (isIP(address) !== 6) return address;
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4) return lower.slice(7);
  const [head = '', tail = ''] = lower.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = lower.includes('::') ? (tail === '' ? [] : tail.split(':')) : [];
  const groups = lower.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

// ------------------------------------------------------- wrong-code lockout

export type LockoutPolicy = {
  /** Wrong codes allowed inside one window before the lockout starts. */
  maxFailures: number;
  windowMs: number;
  lockoutMs: number;
};

export const DEFAULT_LOCKOUT: LockoutPolicy = {
  maxFailures: 8,
  windowMs: 15 * 60_000,
  lockoutMs: 15 * 60_000,
};

type Attempts = { failures: number; windowStart: number; lockedUntil: number };

/** Counts wrong table codes per client, across the WebSocket join AND the
 *  history API — one budget, so splitting guesses between the two doubles
 *  nothing. Once locked, even the RIGHT code is refused until the lockout
 *  ends; otherwise "locked" would still answer the question being guessed.
 *
 *  A right code does NOT clear the count. It used to, and then any invited
 *  player could guess the HOST code forever: seven wrong guesses, one request
 *  with the invite code they already have, repeat. The count simply ages out
 *  with its window — eight typos in fifteen minutes is generous for a person. */
export class CodeGuard {
  private readonly clients = new Map<string, Attempts>();

  constructor(
    private readonly policy: LockoutPolicy = DEFAULT_LOCKOUT,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds left on this client's lockout, or 0 when not locked. */
  lockedFor(client: string): number {
    const entry = this.clients.get(client);
    if (!entry) return 0;
    return Math.max(0, entry.lockedUntil - this.now());
  }

  /** Record a wrong code. Returns true when this one starts a lockout. */
  fail(client: string): boolean {
    const now = this.now();
    this.prune(now);
    let entry = this.clients.get(client);
    if (!entry || now - entry.windowStart > this.policy.windowMs) {
      entry = { failures: 0, windowStart: now, lockedUntil: 0 };
      this.clients.set(client, entry);
    }
    entry.failures += 1;
    if (entry.failures >= this.policy.maxFailures) {
      entry.lockedUntil = now + this.policy.lockoutMs;
      return true;
    }
    return false;
  }

  /** Forget clients whose window and lockout have both run out, so the map
   *  cannot grow without bound under a spray of addresses. */
  private prune(now: number): void {
    if (this.clients.size < 1000) return;
    for (const [client, entry] of this.clients) {
      if (entry.lockedUntil <= now && now - entry.windowStart > this.policy.windowMs) {
        this.clients.delete(client);
      }
    }
  }
}

// ------------------------------------------------------ connections per client

/** Open WebSockets per client address. One phone and one laptop with a stale
 *  tab is three; several friends in one house share an address too, so the
 *  default leaves room for that. The cap is about one person not being able to
 *  open hundreds, not about one seat per address. */
export class ConnectionCounter {
  private readonly open = new Map<string, number>();

  constructor(private readonly maxPerClient: number) {}

  tryOpen(client: string): boolean {
    const count = this.open.get(client) ?? 0;
    if (count >= this.maxPerClient) return false;
    this.open.set(client, count + 1);
    return true;
  }

  close(client: string): void {
    const count = (this.open.get(client) ?? 0) - 1;
    if (count <= 0) this.open.delete(client);
    else this.open.set(client, count);
  }
}

// ------------------------------------------------------ token buckets

/** A token bucket: `burst` messages at once, then one every `everyMs`. */
export type Rate = { burst: number; everyMs: number };

type Bucket = { tokens: number; at: number };

/** Buckets by key. Refill is worked out lazily from the clock on each take. */
export class Buckets {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  take(key: string, rate: Rate): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: rate.burst, at: now };
    const refilled = Math.min(rate.burst, bucket.tokens + (now - bucket.at) / rate.everyMs);
    if (refilled < 1) {
      this.buckets.set(key, { tokens: refilled, at: now });
      return false;
    }
    this.buckets.set(key, { tokens: refilled - 1, at: now });
    return true;
  }

  forget(prefix: string): void {
    for (const key of this.buckets.keys()) {
      if (key.startsWith(prefix)) this.buckets.delete(key);
    }
  }
}

// ------------------------------------------------------ per-player message rate

export type ThrottledMessage = 'chat' | 'emote' | 'setSkin' | 'setClientSeed' | 'seatChange';

/** Chat and emotes go to everyone's screen. Every other throttled message
 *  rebuilds and sends the whole table view to every player — a loop of any of
 *  them was a cheap way to make the table stutter for everybody, and a
 *  sit/stand loop also pushed real entries out of the public chip log. The
 *  client sends one seed per hand and one skin per settings change, far
 *  inside these. `seatChange` covers sit, stand up, sit out, I'm back, top up,
 *  show and leave together: a person presses those a few times a hand at most. */
export const DEFAULT_RATES: Record<ThrottledMessage, Rate> = {
  chat: { burst: 3, everyMs: 1_000 },
  emote: { burst: 2, everyMs: 2_000 },
  setSkin: { burst: 4, everyMs: 2_000 },
  setClientSeed: { burst: 3, everyMs: 2_000 },
  seatChange: { burst: 6, everyMs: 1_000 },
};

/** Every message on one connection, whatever it is. Generous for a person or
 *  a bot — an action a turn, a seed a hand — and a ceiling on anything else. */
export const CONNECTION_RATE: Rate = { burst: 40, everyMs: 100 };

/** Keyed by player, not by socket, so reconnecting does not refill the bucket.
 *  Joining as a brand-new player does get fresh buckets — that is bounded by
 *  the cap on players per address, not here. */
export class PlayerRateLimits {
  private readonly buckets: Buckets;

  constructor(
    private readonly rates: Record<ThrottledMessage, Rate> = DEFAULT_RATES,
    now: () => number = Date.now,
  ) {
    this.buckets = new Buckets(now);
  }

  take(playerId: string, kind: ThrottledMessage): boolean {
    return this.buckets.take(`${playerId}:${kind}`, this.rates[kind]);
  }

  forget(playerId: string): void {
    this.buckets.forget(`${playerId}:`);
  }
}
