import sharp from 'sharp';

import { badRequest } from '../lib/errors.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_INPUT_PIXELS = 100_000_000;
const MAX_SIDE = 2048;
const THUMB_WIDTH = 480;

export interface ProcessedImage {
  full: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
}

/**
 * Turns an uploaded file into a clean JPEG and a small thumbnail.
 *
 * The picture is decoded and written out again, which (a) proves it really is an image, (b) removes
 * location and camera data (EXIF), (c) fixes rotation and (d) throws away anything hidden inside the file.
 * Only the bytes we produce are ever stored or served.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  try {
    const meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (!meta.format || !['jpeg', 'png', 'webp', 'gif'].includes(meta.format)) {
      throw new Error('unsupported');
    }
    const base = () => sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).rotate().flatten({ background: '#ffffff' });
    const full = await base()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    const thumb = await base().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).jpeg({ quality: 72, mozjpeg: true }).toBuffer();
    return { full: full.data, thumb, width: full.info.width, height: full.info.height };
  } catch {
    throw badRequest('That file is not a picture we can use. Send a JPEG, PNG or WebP photo.');
  }
}
