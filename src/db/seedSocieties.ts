import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import sharp from 'sharp';

import { processImage } from '../media/image.js';
import type { Storage } from '../storage/index.js';

/**
 * Development data for Module 4: societies for IAC, who is in them, and photo albums with generated
 * pictures (flat colour artwork, so no real photos are needed). Safe to run again: it does nothing once
 * IAC has societies. It adds to existing data and never deletes any.
 */

const SOCIETIES = [
  { name: 'Computer Science Society', about: 'Hackathons, workshops and tech talks', category: 'Tech', members: 14, heads: ['society@iac.test'] },
  { name: 'Sports Society', about: 'Tournaments and fitness meetups', category: 'Sports', members: 11, heads: [] },
  { name: 'Arts & Culture Society', about: 'Music, drama and cultural nights', category: 'Cultural', members: 9, heads: [] },
  { name: 'Debating Society', about: 'Parliamentary and public speaking', category: 'Career', members: 6, heads: [] },
  { name: 'Photography Club', about: 'Photo walks and exhibitions', category: 'Social', members: 8, heads: ['society@iac.test'] },
];

const ALBUMS = [
  { title: 'Hackathon Finals', category: 'Tech', society: 'Computer Science Society', event: 'Hackathon Finals', photos: 9 },
  { title: 'Tech Fest 2025', category: 'Tech', society: 'Computer Science Society', event: null, photos: 7 },
  { title: 'Sports Day', category: 'Sports', society: 'Sports Society', event: null, photos: 6 },
  { title: 'Cultural Night 2025', category: 'Cultural', society: 'Arts & Culture Society', event: null, photos: 8 },
  { title: 'Orientation Week', category: 'Social', society: 'Photography Club', event: null, photos: 5 },
];

const PALETTES = [
  ['#C6F26B', '#14231D', '#F7F6F0', '#4F46E5'],
  ['#FF7A59', '#14231D', '#FFE6A7', '#0E9F6E'],
  ['#8EC5FF', '#14231D', '#F7F6F0', '#FF7A59'],
  ['#F5C84B', '#14231D', '#C6F26B', '#4F46E5'],
  ['#B79CFF', '#14231D', '#F7F6F0', '#F5C84B'],
];

/** A flat, abstract picture (circles and bars). Different every time, always on-brand. */
function art(seed: number): Buffer {
  const pal = PALETTES[seed % PALETTES.length] as string[];
  const rand = (n: number) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed % 1000) / 1000 * n;
  };
  const w = 1200;
  const h = seed % 3 === 0 ? 900 : seed % 3 === 1 ? 1500 : 800;
  let shapes = '';
  for (let i = 0; i < 9; i++) {
    const fill = pal[1 + (i % 3)];
    shapes += i % 2 === 0
      ? `<circle cx="${rand(w)}" cy="${rand(h)}" r="${60 + rand(260)}" fill="${fill}" opacity="0.9"/>`
      : `<rect x="${rand(w)}" y="${rand(h)}" width="${120 + rand(500)}" height="${40 + rand(120)}" rx="20" fill="${fill}" opacity="0.9" transform="rotate(${rand(60) - 30} ${rand(w)} ${rand(h)})"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${pal[0]}"/>${shapes}</svg>`;
  return Buffer.from(svg);
}

export async function seedSocietiesAndAlbums(pool: pg.Pool, ids: Map<string, string>, fillers: string[], storage?: Storage): Promise<void> {
  const exists = await pool.query("SELECT 1 FROM societies WHERE university_id = 'iac' LIMIT 1");
  if (exists.rowCount) {
    return;
  }
  const admin = ids.get('admin@iac.test') as string;
  const byName = new Map<string, string>();

  for (const s of SOCIETIES) {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO societies (university_id, name, about, category, created_by) VALUES ('iac', $1, $2, $3, $4) RETURNING id",
      [s.name, s.about, s.category, admin],
    );
    const id = (rows[0] as { id: string }).id;
    byName.set(s.name, id);
    const members = [ids.get('ayesha@iac.test'), ids.get('bilal@iac.test'), ...fillers].filter(Boolean).slice(0, s.members) as string[];
    for (const uid of members) {
      await pool.query("INSERT INTO society_members (society_id, user_id, university_id) VALUES ($1, $2, 'iac') ON CONFLICT DO NOTHING", [id, uid]);
    }
    for (const email of s.heads) {
      const uid = ids.get(email);
      if (uid) {
        await pool.query(
          "INSERT INTO society_members (society_id, user_id, university_id, role) VALUES ($1, $2, 'iac', 'head') ON CONFLICT (society_id, user_id) DO UPDATE SET role = 'head'",
          [id, uid],
        );
      }
    }
  }

  // Link the events and updates the earlier seed created (they only had the society's name as text).
  await pool.query(
    `UPDATE events e SET society_id = s.id FROM societies s
      WHERE e.university_id = 'iac' AND s.university_id = 'iac' AND e.organizer = s.name AND e.society_id IS NULL`,
  );
  await pool.query(
    `UPDATE posts p SET society_id = s.id FROM societies s
      WHERE p.university_id = 'iac' AND s.university_id = 'iac' AND p.kind = 'society' AND p.source = s.name AND p.society_id IS NULL`,
  );

  if (!storage) {
    return; // no place to keep pictures (tests): societies only
  }

  let n = 0;
  for (const a of ALBUMS) {
    const ev = a.event ? await pool.query<{ id: string }>("SELECT id FROM events WHERE university_id = 'iac' AND title = $1 LIMIT 1", [a.event]) : null;
    const album = await pool.query<{ id: string }>(
      "INSERT INTO albums (university_id, title, category, event_id, society_id, created_by) VALUES ('iac', $1, $2, $3, $4, $5) RETURNING id",
      [a.title, a.category, ev?.rows[0]?.id ?? null, byName.get(a.society) ?? null, ids.get('society@iac.test') ?? admin],
    );
    const albumId = (album.rows[0] as { id: string }).id;
    for (let i = 0; i < a.photos; i++) {
      const image = await processImage(await sharp(art(++n * 7919)).png().toBuffer());
      const photoId = randomUUID();
      const base = `iac/${albumId}/${photoId}`;
      await storage.put(`${base}.jpg`, image.full, 'image/jpeg');
      await storage.put(`${base}_t.jpg`, image.thumb, 'image/jpeg');
      const uploader = fillers[(n * 3) % Math.max(fillers.length, 1)] ?? admin;
      await pool.query(
        `INSERT INTO photos (id, album_id, university_id, uploader_id, storage_key, thumb_key, width, height, bytes, created_at)
         VALUES ($1, $2, 'iac', $3, $4, $5, $6, $7, $8, now() - make_interval(mins => $9))`,
        [photoId, albumId, uploader, `${base}.jpg`, `${base}_t.jpg`, image.width, image.height, image.full.length, (a.photos - i) * 17],
      );
      for (const liker of fillers.slice(0, (n * 5) % 7)) {
        await pool.query('INSERT INTO photo_likes (photo_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [photoId, liker]);
      }
    }
  }
}
