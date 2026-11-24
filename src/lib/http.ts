import type { ZodType } from 'zod';

import { notFound } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates input with a zod schema. A failure becomes a 400 (see the error handler in app.ts). */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  return schema.parse(data);
}

/** A malformed id can never exist, so it is a 404 rather than a database error. */
export function uuid(id: unknown): string {
  if (typeof id !== 'string' || !UUID.test(id)) {
    throw notFound();
  }
  return id;
}

export const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);
