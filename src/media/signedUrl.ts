import { createHmac } from 'node:crypto';

import type { Config } from '../config.js';
import { safeEqual } from '../lib/secrets.js';

export type PhotoSize = 'full' | 'thumb';

/** What a signed link points at: album photos, other pictures (book photos ...), or a note's document. */
export type LinkScope = 'photo' | 'media' | 'doc' | 'chat';

const ROUTE: Record<LinkScope, string> = { photo: 'files', media: 'media', doc: 'docs', chat: 'chat-files' };
const DAY = 86_400_000;

const sign = (config: Config, scope: LinkScope, id: string, variant: string, exp: number) =>
  createHmac('sha256', config.jwtSecret).update(`${scope}|${id}|${variant}|${exp}`).digest('base64url').slice(0, 27);

/**
 * A link to one file that works without a sign-in header (so an <Image> or the phone's PDF viewer can
 * open it) and stops working after a day or two. The expiry is rounded to the day, so the same file keeps
 * the same link all day and the phone can cache it. Links are only handed to approved members of the
 * right university.
 */
export function signedPath(config: Config, scope: LinkScope, id: string, variant: string, now = Date.now()): string {
  const exp = (Math.floor(now / DAY) + 2) * DAY;
  return `/v1/${ROUTE[scope]}/${id}/${variant}?exp=${exp}&sig=${sign(config, scope, id, variant, exp)}`;
}

export function verifySignature(config: Config, scope: LinkScope, id: string, variant: string, exp: string | undefined, sig: string | undefined, now = Date.now()): boolean {
  if (!exp || !sig || !/^\d{10,15}$/.test(exp)) {
    return false;
  }
  const expiry = Number(exp);
  return expiry > now && safeEqual(sign(config, scope, id, variant, expiry), sig);
}

export const signedPhotoPath = (config: Config, photoId: string, size: PhotoSize, now = Date.now()) => signedPath(config, 'photo', photoId, size, now);

export function verifyPhotoSignature(config: Config, photoId: string, size: string, exp: string | undefined, sig: string | undefined, now = Date.now()): size is PhotoSize {
  return (size === 'full' || size === 'thumb') && verifySignature(config, 'photo', photoId, size, exp, sig, now);
}
