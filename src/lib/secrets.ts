import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/**
 * Secret behind a ticket or guest pass. Generated with a cryptographically secure source,
 * 24 characters of a 32-symbol alphabet = 120 bits.
 */
export function newTicketCode(length = 24): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  }
  return out;
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Compares two secrets without leaking how many leading characters matched. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}
