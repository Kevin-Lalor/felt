// The two table codes, and the rules that make them worth having.
//
// The invite code lets you sit at the table and read its hand history; the
// host code does that and makes you host. Behind Cloudflare Access they are
// the second lock, not the first — but a lock that opens for an empty string
// is not a lock. Starting with HOST_CODE= (empty) used to switch the history
// check off entirely, because '' === '' for any request that sent no code.

import { randomInt, timingSafeEqual } from 'node:crypto';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const MIN_CODE_LENGTH = 12;
/** The join message caps the code at 64 characters. */
const MAX_CODE_LENGTH = 64;
const GENERATED_CODE_LENGTH = 16;
/** No 0/O, 1/I/L or U: a code read out over the phone or copied off a text
 *  should not have two plausible spellings. 30 symbols × 16 ≈ 78 bits. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export type TableCodes = {
  inviteCode: string;
  hostCode: string;
  /** Which codes were generated this boot, so startup can print them once. */
  generated: { invite: boolean; host: boolean };
};

/** Codes compare case-insensitively: the join box upper-cases what you type,
 *  and phones love to capitalise the first letter of anything. Leading and
 *  trailing spaces from a pasted text are not part of a code either. */
export function normaliseCode(code: string): string {
  return code.trim().toUpperCase();
}

export function generateCode(): string {
  let out = '';
  for (let i = 0; i < GENERATED_CODE_LENGTH; i++) {
    out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

/** Unset → a strong random code for this boot. Set → it must be a real code:
 *  not blank, at least 12 characters, printable, and the two must differ —
 *  equal codes would make every invited friend a host. Anything else refuses
 *  to start, because a server that quietly runs with a weak lock is worse than
 *  one that will not run. */
export function resolveCodes(env: Record<string, string | undefined>): TableCodes {
  const invite = checkCode('INVITE_CODE', env['INVITE_CODE']);
  const host = checkCode('HOST_CODE', env['HOST_CODE']);
  const inviteCode = invite ?? generateCode();
  const hostCode = host ?? generateCode();
  if (inviteCode === hostCode) {
    throw new ConfigError(
      'INVITE_CODE and HOST_CODE are the same. Every friend with the invite code would be host. Use two different codes.',
    );
  }
  return { inviteCode, hostCode, generated: { invite: invite === null, host: host === null } };
}

function checkCode(name: string, raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const code = normaliseCode(raw);
  if (code.length === 0) {
    throw new ConfigError(
      `${name} is set but empty. Remove it to get a random code, or set one of at least ${MIN_CODE_LENGTH} characters.`,
    );
  }
  if (code.length < MIN_CODE_LENGTH) {
    throw new ConfigError(`${name} must be at least ${MIN_CODE_LENGTH} characters (it is ${code.length}).`);
  }
  if (code.length > MAX_CODE_LENGTH) {
    throw new ConfigError(`${name} must be at most ${MAX_CODE_LENGTH} characters.`);
  }
  // It travels in an HTTP header for the history API, which only carries
  // visible ASCII.
  if (!/^[\x21-\x7E]+$/.test(code)) {
    throw new ConfigError(`${name} may only use visible ASCII characters — no spaces or accents.`);
  }
  return code;
}

/** Constant-time: the comparison should not leak how much of a guess was right. */
export function codeMatches(candidate: string, actual: string): boolean {
  const left = Buffer.from(normaliseCode(candidate), 'utf8');
  const right = Buffer.from(actual, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
