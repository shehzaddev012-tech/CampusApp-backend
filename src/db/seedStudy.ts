import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';
import sharp from 'sharp';

import { processImage } from '../media/image.js';
import type { Storage } from '../storage/index.js';
import { createStorage } from '../storage/index.js';
import { createPool } from './pool.js';

/**
 * Development data for Module 6: a few notes (with a real, readable PDF), books with photos, study groups and
 * openings. Safe to run again: it does nothing once IAC has notes. Run it with `npm run seed:study`.
 */

const NOTES = [
  { by: 'ayesha@iac.test', title: 'Data Structures: Trees and Graphs', course: 'CS201', kind: 'notes', description: 'Lecture notes for weeks 5 to 8, with worked examples.' },
  { by: 'bilal@iac.test', title: 'Marketing Principles: Mid-term 2025', course: 'MKT101', kind: 'past_paper', description: 'The paper from last semester, with the marking scheme.' },
  { by: 'sara@iac.test', title: 'Circuit Analysis: Assignment 3', course: 'EE210', kind: 'assignment', description: '' },
];

const BOOKS = [
  { by: 'ayesha@iac.test', title: 'Introduction to Algorithms', author: 'Cormen, Leiserson, Rivest, Stein', course: 'CS301', price: 1800, condition: 'good', description: 'Third edition. Some highlighting in the first chapters.', hue: '#3b6ea5' },
  { by: 'bilal@iac.test', title: 'Principles of Marketing', author: 'Kotler and Armstrong', course: 'MKT101', price: 1200, condition: 'like_new', description: 'Hardly used. Can meet at the library.', hue: '#c0762f' },
  { by: 'sara@iac.test', title: 'Fundamentals of Electric Circuits', author: 'Alexander and Sadiku', course: 'EE210', price: 0, condition: 'fair', description: 'Free to a junior who needs it. Cover is worn.', hue: '#4d8a5f' },
];

const GROUPS = [
  { by: 'ayesha@iac.test', title: 'CS201 exam prep', course: 'CS201', meeting: 'Library, 2nd floor, Thursdays 4 PM', capacity: 6, description: 'Going through past papers together.', joined: ['bilal@iac.test', 'sara@iac.test'] },
  { by: 'bilal@iac.test', title: 'Marketing case study club', course: 'MKT101', meeting: 'Cafeteria, Fridays 1 PM', capacity: 8, description: 'We pick one case a week and discuss it.', joined: ['ayesha@iac.test'] },
];

const JOBS = [
  { company: 'Northwind Software', title: 'Junior Web Developer', kind: 'job', location: 'Lahore', description: 'Work with a small team building web apps in TypeScript and Node.', applyUrl: 'https://example.com/careers/junior-web-developer', applyEmail: null, days: 21 },
  { company: 'Brightside Studio', title: 'Design Intern', kind: 'internship', location: 'Remote', description: 'A three-month paid internship for students with a design portfolio.', applyUrl: null, applyEmail: 'internships@example.com', days: 14 },
  { company: 'Campus Cafe', title: 'Weekend Barista', kind: 'part_time', location: 'On campus', description: 'Saturdays and Sundays, flexible around classes.', applyUrl: 'https://example.com/careers/barista', applyEmail: null, days: null },
];

/** A small valid PDF with a few lines of real text. */
function samplePdf(title: string, lines: string[]): Buffer {
  const text = [`BT /F1 20 Tf 60 740 Td (${title}) Tj ET`, ...lines.map((l, i) => `BT /F1 12 Tf 60 ${700 - i * 20} Td (${l}) Tj ET`)].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}

export async function seedStudy(pool: pg.Pool, storage: Storage): Promise<void> {
  if ((await pool.query("SELECT 1 FROM study_notes WHERE university_id = 'iac' LIMIT 1")).rowCount) {
    return;
  }
  const idOf = async (email: string) => (await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0]?.id;
  const deptOf = async (id: string) => (await pool.query<{ department: string }>("SELECT department FROM memberships WHERE user_id = $1 AND university_id = 'iac'", [id])).rows[0]?.department ?? '';
  const admin = await idOf('admin@iac.test');
  if (!admin) {
    return; // the base seed has not been run
  }

  for (const [i, n] of NOTES.entries()) {
    const uid = await idOf(n.by);
    if (!uid) {
      continue;
    }
    const id = randomUUID();
    await pool.query(
      `INSERT INTO study_notes (id, university_id, uploader_id, title, course, department, kind, description, created_at)
       VALUES ($1, 'iac', $2, $3, $4, $5, $6, $7, now() - make_interval(hours => $8))`,
      [id, uid, n.title, n.course, await deptOf(uid), n.kind, n.description, (i + 1) * 9],
    );
    const pdf = samplePdf(n.title, [`Course: ${n.course}`, 'Shared on CampusHub (sample data).', 'This is a real PDF made by the seed script.']);
    const key = `iac/docs/${id}.pdf`;
    await storage.put(key, pdf, 'application/pdf');
    await pool.query("INSERT INTO note_files (note_id, university_id, storage_key, name, mime, bytes, position) VALUES ($1, 'iac', $2, $3, 'application/pdf', $4, 0)", [id, key, `${n.course}-notes.pdf`, pdf.length]);
    const voters = ['ayesha@iac.test', 'bilal@iac.test', 'sara@iac.test'].filter(e => e !== n.by).slice(0, 2 - (i % 2));
    for (const v of voters) {
      const vid = await idOf(v);
      if (vid) {
        await pool.query("INSERT INTO note_votes (note_id, university_id, user_id) VALUES ($1, 'iac', $2) ON CONFLICT DO NOTHING", [id, vid]);
      }
    }
  }

  for (const [i, b] of BOOKS.entries()) {
    const uid = await idOf(b.by);
    if (!uid) {
      continue;
    }
    const id = randomUUID();
    await pool.query(
      `INSERT INTO books (id, university_id, seller_id, title, author, course, price, condition, description, created_at)
       VALUES ($1, 'iac', $2, $3, $4, $5, $6, $7, $8, now() - make_interval(hours => $9))`,
      [id, uid, b.title, b.author, b.course, b.price, b.condition, b.description, (i + 1) * 5],
    );
    const cover = await sharp({ create: { width: 900, height: 1200, channels: 3, background: b.hue } })
      .composite([{ input: Buffer.from(`<svg width="900" height="1200" xmlns="http://www.w3.org/2000/svg"><rect x="70" y="90" width="760" height="1020" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="10"/><rect x="130" y="170" width="640" height="14" fill="#ffffff" fill-opacity="0.8"/><rect x="130" y="210" width="420" height="14" fill="#ffffff" fill-opacity="0.6"/></svg>`) }])
      .png()
      .toBuffer();
    const image = await processImage(cover);
    const mediaId = randomUUID();
    const base = `iac/media/${mediaId}`;
    await storage.put(`${base}.jpg`, image.full, 'image/jpeg');
    await storage.put(`${base}_t.jpg`, image.thumb, 'image/jpeg');
    await pool.query("INSERT INTO media (id, university_id, owner_id, storage_key, thumb_key, width, height, bytes) VALUES ($1, 'iac', $2, $3, $4, $5, $6, $7)", [mediaId, uid, `${base}.jpg`, `${base}_t.jpg`, image.width, image.height, image.full.length]);
    await pool.query("INSERT INTO book_photos (book_id, media_id, university_id, position) VALUES ($1, $2, 'iac', 0)", [id, mediaId]);
  }

  for (const [i, g] of GROUPS.entries()) {
    const uid = await idOf(g.by);
    if (!uid) {
      continue;
    }
    const id = randomUUID();
    await pool.query(
      `INSERT INTO study_groups (id, university_id, created_by, title, course, description, meeting, capacity, created_at)
       VALUES ($1, 'iac', $2, $3, $4, $5, $6, $7, now() - make_interval(hours => $8))`,
      [id, uid, g.title, g.course, g.description, g.meeting, g.capacity, (i + 1) * 12],
    );
    for (const who of [g.by, ...g.joined]) {
      const mid = await idOf(who);
      if (mid) {
        await pool.query("INSERT INTO study_group_members (group_id, university_id, user_id) VALUES ($1, 'iac', $2) ON CONFLICT DO NOTHING", [id, mid]);
      }
    }
  }

  for (const [i, j] of JOBS.entries()) {
    await pool.query(
      `INSERT INTO jobs (university_id, posted_by, company, title, kind, location, description, apply_url, apply_email, deadline, created_at)
       VALUES ('iac', $1, $2, $3, $4, $5, $6, $7, $8, ${j.days ? `now() + make_interval(days => ${j.days})` : 'NULL'}, now() - make_interval(hours => $9))`,
      [admin, j.company, j.title, j.kind, j.location, j.description, j.applyUrl, j.applyEmail, (i + 1) * 6],
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pool = createPool(process.env.DATABASE_URL ?? '');
  try {
    await seedStudy(pool, createStorage(process.env.UPLOADS_DIR ?? './uploads'));
    console.log('Study and career sample data is in place.');
  } finally {
    await pool.end();
  }
}
