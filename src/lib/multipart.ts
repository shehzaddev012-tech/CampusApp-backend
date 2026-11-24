import type { FastifyRequest } from 'fastify';

import { AppError, badRequest } from './errors.js';

export interface UploadedFile {
  name: string;
  mime: string;
  data: Buffer;
}

/**
 * Reads a multipart/form-data request: its text fields and its files (any field name).
 * Fails the whole request when a file is too large or there are too many files.
 */
export async function readMultipart(req: FastifyRequest, opts: { maxFiles: number; maxBytes: number }): Promise<{ fields: Record<string, string>; files: UploadedFile[] }> {
  if (!req.isMultipart()) {
    throw badRequest('Send this as a form with files.');
  }
  const fields: Record<string, string> = {};
  const files: UploadedFile[] = [];
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      if (files.length >= opts.maxFiles) {
        throw badRequest(`You can send up to ${opts.maxFiles} files at a time.`);
      }
      const data = await part.toBuffer();
      if (part.file.truncated || data.length > opts.maxBytes) {
        throw new AppError(413, 'file_too_large', `A file is larger than ${Math.round(opts.maxBytes / 1_048_576)} MB.`);
      }
      if (data.length > 0) {
        files.push({ name: (part.filename || 'file').slice(0, 120), mime: part.mimetype, data });
      }
    } else if (typeof part.value === 'string') {
      fields[part.fieldname] = part.value;
    }
  }
  return { fields, files };
}
