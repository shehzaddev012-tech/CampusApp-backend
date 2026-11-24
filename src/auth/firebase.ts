import { readFile } from 'node:fs/promises';

import type { Config } from '../config.js';
import { unauthorized } from '../lib/errors.js';

export interface GoogleIdentity {
  email: string;
  name: string;
  photoUrl: string | null;
}

/** firebase-admin is loaded lazily so tests and dev mode never need it. */
async function firebaseAdmin(config: Config) {
  const { getApps, initializeApp, cert } = await import('firebase-admin/app');
  if (getApps().length === 0) {
    if (!config.firebaseServiceAccount) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT is not configured.');
    }
    const json = JSON.parse(await readFile(config.firebaseServiceAccount, 'utf8')) as Record<string, string>;
    initializeApp({ credential: cert(json as never) });
  }
  return { auth: (await import('firebase-admin/auth')).getAuth(), messaging: (await import('firebase-admin/messaging')).getMessaging() };
}

/** Verifies a Firebase ID token (from "Continue with Google") and returns who it belongs to. */
export async function verifyFirebaseIdToken(config: Config, idToken: string): Promise<GoogleIdentity> {
  const { auth } = await firebaseAdmin(config);
  try {
    const decoded = await auth.verifyIdToken(idToken, true);
    if (!decoded.email || decoded.email_verified === false) {
      throw new Error('email not verified');
    }
    return {
      email: decoded.email,
      name: (decoded.name as string | undefined) ?? decoded.email.split('@')[0] ?? 'Student',
      photoUrl: (decoded.picture as string | undefined) ?? null,
    };
  } catch {
    throw unauthorized('Google sign-in could not be verified.');
  }
}

export async function getFirebaseMessaging(config: Config) {
  return (await firebaseAdmin(config)).messaging;
}
