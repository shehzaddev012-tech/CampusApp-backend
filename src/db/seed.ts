import { fileURLToPath } from 'node:url';
import type pg from 'pg';

import { newTicketCode } from '../lib/secrets.js';
import type { Storage } from '../storage/index.js';
import { createStorage } from '../storage/index.js';
import { seedCampusLife } from './seedCampusLife.js';
import { seedSocietiesAndAlbums } from './seedSocieties.js';
import { createPool } from './pool.js';

/**
 * Development data: three universities, one test account per role, and a believable campus
 * (events, updates, tickets). Test accounts all end in ".test" so the app can list them on its
 * sign-in screen in development. Never run this against production.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (daysFromToday: number, hour: number, minute = 0) => {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return new Date(d.getTime() + daysFromToday * DAY);
};

interface Account {
  email: string;
  name: string;
  uni: string;
  role: 'student' | 'society_head' | 'uni_admin' | 'security';
  status?: 'active' | 'pending';
  dept: string;
  studentId: string;
  batch: string;
}

/** The one university this installation is for: the Institute for Art & Culture, Lahore (iac.edu.pk). */
export const SCHOOLS = ['Architecture, Design & Urbanism', 'Art', 'Informatics & Robotics', 'Digital & Cinematic Art', 'Culture & Languages'] as const;
const UNIVERSITIES = [{ id: 'iac', name: 'IAC', fullName: 'Institute for Art & Culture', accent: '#14231D', departments: [...SCHOOLS] }];

const ACCOUNTS: Account[] = [
  { email: 'admin@iac.test', name: 'Dr. Imran Raza', uni: 'iac', role: 'uni_admin', dept: 'Informatics & Robotics', studentId: 'STAFF-001', batch: '' },
  { email: 'society@iac.test', name: 'Hamza Ali', uni: 'iac', role: 'society_head', dept: 'Informatics & Robotics', studentId: 'IAC-FA21-BCS-077', batch: '' },
  { email: 'security@iac.test', name: 'Gate Security', uni: 'iac', role: 'security', dept: 'Informatics & Robotics', studentId: 'SEC-001', batch: '' },
  { email: 'ayesha@iac.test', name: 'Ayesha Khan', uni: 'iac', role: 'student', dept: 'Informatics & Robotics', studentId: 'IAC-FA22-BCS-104', batch: '' },
  { email: 'bilal@iac.test', name: 'Bilal Ahmed', uni: 'iac', role: 'student', dept: 'Architecture, Design & Urbanism', studentId: 'IAC-FA23-BAR-031', batch: '' },
  { email: 'sara@iac.test', name: 'Sara Malik', uni: 'iac', role: 'student', dept: 'Art', studentId: 'IAC-FA24-BFA-212', batch: '' },
  { email: 'pending@iac.test', name: 'Zain Abbas', uni: 'iac', role: 'student', status: 'pending', dept: 'Culture & Languages', studentId: 'IAC-FA25-BCL-009', batch: '' },
];

async function one<T>(pool: pg.Pool, sql: string, params: unknown[]): Promise<T> {
  return (await pool.query(sql, params)).rows[0] as T;
}

export async function seed(pool: pg.Pool, opts: { reset?: boolean; storage?: Storage } = {}): Promise<void> {
  if (opts.reset) {
    await pool.query('TRUNCATE users, universities RESTART IDENTITY CASCADE');
  }

  for (const u of UNIVERSITIES) {
    await pool.query('INSERT INTO universities (id, name, full_name, accent) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [u.id, u.name, u.fullName, u.accent]);
    for (const d of u.departments) {
      await pool.query('INSERT INTO departments (university_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [u.id, d]);
    }
  }

  const ids = new Map<string, string>();
  const add = async (email: string, name: string) => {
    const r = await one<{ id: string }>(pool, 'INSERT INTO users (email, name) VALUES ($1, $2) ON CONFLICT ((lower(email))) DO UPDATE SET name = EXCLUDED.name RETURNING id', [email, name]);
    ids.set(email, r.id);
    return r.id;
  };

  for (const a of ACCOUNTS) {
    const id = await add(a.email, a.name);
    await pool.query(
      `INSERT INTO memberships (user_id, university_id, student_id, department, batch, role, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (user_id) DO NOTHING`,
      [id, a.uni, a.studentId, a.dept, a.batch, a.role, a.status ?? 'active'],
    );
  }

  // Extra students so events have believable attendance. Not listed as test accounts.
  const fillers: string[] = [];
  for (let i = 1; i <= 30; i++) {
    const email = `student${String(i).padStart(2, '0')}@seed.local`;
    const id = await add(email, `Student ${String(i).padStart(2, '0')}`);
    fillers.push(id);
    await pool.query(
      `INSERT INTO memberships (user_id, university_id, student_id, department, batch, role, status)
       VALUES ($1, 'iac', $2, $3, '', 'student', 'active') ON CONFLICT (user_id) DO NOTHING`,
      [id, `SEED-${i}`, SCHOOLS[i % SCHOOLS.length]],
    );
  }

  const admin = ids.get('admin@iac.test') as string;
  const society = ids.get('society@iac.test') as string;
  const security = ids.get('security@iac.test') as string;
  const already = (await one<{ n: number }>(pool, "SELECT count(*)::int AS n FROM posts WHERE university_id = 'iac'", [])).n;
  if (already > 0) {
    await seedSocietiesAndAlbums(pool, ids, fillers, opts.storage); // adds Module 4 data to an older seed
    await seedCampusLife(pool, ids, fillers); // and Module 5
    return;
  }

  // ── updates ───────────────────────────────────────────────────────────────
  const now = Date.now();
  // [authorId, kind, title, body, source, authorRole, channel, pinned, createdAt]
  const posts: [string, string, string, string, string, string, string | null, boolean, Date][] = [
    [security, 'alert', 'Heavy rain expected', 'Evening classes are shifted online today. Please stay safe and avoid travelling after 4 PM.', 'Campus Security', 'security', null, false, new Date(now - 20 * 60_000)],
    [admin, 'official', 'Mid-term schedule is out', 'Mid-term exams start on Monday. The full datesheet and seating plan are on your department channel.\n\nBring your student card and arrive 15 minutes early. Phones are not allowed in the hall.', 'Examination Office', 'uni_admin', null, true, new Date(now - 2 * HOUR)],
    [society, 'society', 'Hackathon registrations are open', '24 hours, teams of 3 to 4. Cash prizes and internship interviews for the top teams. Register before Friday.', 'Computer Science Society', 'society_head', null, false, new Date(now - DAY)],
    [admin, 'official', 'Library open until 10 PM this week', 'Extended hours during exams. Bring your student card for entry after 6 PM.', 'Central Library', 'uni_admin', null, false, new Date(now - DAY - 3 * HOUR)],
    [society, 'society', 'Photo walk this Friday', 'Golden hour around the old campus. Bring any camera, phones are welcome.', 'Photography Club', 'society_head', null, false, new Date(now - 2 * DAY)],
    [admin, 'official', 'Informatics & Robotics: lab timings changed', 'Lab sessions for the School of Informatics and Robotics move to 2 PM starting next week. Check the timetable for your section.', 'School of Informatics and Robotics', 'uni_admin', 'Informatics & Robotics', false, new Date(now - 3 * DAY)],
  ];
  for (const p of posts) {
    await pool.query(
      `INSERT INTO posts (university_id, kind, title, body, author_id, author_name, author_role, source, channel, pinned, created_at)
       SELECT 'iac', $2::text, $3::text, $4::text, u.id, u.name, $6::text, $5::text, $7::text, $8::boolean, $9::timestamptz
         FROM users u WHERE u.id = $1::uuid`,
      p,
    );
  }

  // ── events ────────────────────────────────────────────────────────────────
  const events = [
    { key: 'tech', title: 'Tech Fest 2026', org: 'Computer Science Society', cat: 'Tech', blurb: 'Robotics, hackathon finals and talks from industry engineers. Bring your student card.', venue: 'Main Auditorium', s: new Date(now - 45 * 60_000), e: new Date(now + 4 * HOUR), cap: 60, going: 24 },
    { key: 'cricket', title: 'Inter-Department Cricket', org: 'Sports Society', cat: 'Sports', blurb: 'Eight departments, one trophy. Come and cheer for your department.', venue: 'University Ground', s: at(3, 14), e: at(3, 17), cap: 40, going: 9, vol: [10, 4] },
    { key: 'career', title: 'Career Fair: Meet 40 Companies', org: 'Career Services', cat: 'Career', blurb: 'Bring your CV. Interviews on the spot. Free for all students.', venue: 'Block C Hall', s: at(7, 9, 30), e: at(7, 16), cap: null, going: 18 },
    { key: 'cultural', title: 'Cultural Night', org: 'Arts & Culture Society', cat: 'Cultural', blurb: 'Live music, drama and food stalls from every region of the country.', venue: 'Open Air Theatre', s: at(10, 19), e: at(10, 22), cap: 12, going: 12, waitlist: 4 },
    { key: 'freshers', title: 'Freshers Welcome Meetup', org: 'Student Council', cat: 'Social', blurb: 'Meet your batch, your seniors and your societies over tea.', venue: 'Cafeteria Lawn', s: at(14, 16), e: at(14, 18), cap: 150, going: 6, vol: [8, 3] },
    { key: 'hack', title: 'Hackathon Finals', org: 'Computer Science Society', cat: 'Tech', blurb: '24 hours, 32 teams. Thank you to everyone who built something great.', venue: 'Lab Block', s: at(-3, 10), e: at(-3, 18), cap: 120, going: 20 },
  ];
  const created: Record<string, string> = {};
  for (const ev of events) {
    const row = await one<{ id: string }>(
      pool,
      `INSERT INTO events (university_id, title, organizer, category, blurb, venue, starts_at, ends_at, capacity, volunteers_needed, created_by)
       VALUES ('iac', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [ev.title, ev.org, ev.cat, ev.blurb, ev.venue, ev.s, ev.e, ev.cap, ev.vol?.[0] ?? 0, society],
    );
    created[ev.key] = row.id;
    const going = fillers.slice(0, ev.going);
    for (const uid of going) {
      await pool.query(
        `INSERT INTO rsvps (event_id, user_id, student_name, status, code, volunteer)
         SELECT $1, u.id, u.name, 'going', $3, $4 FROM users u WHERE u.id = $2`,
        [row.id, uid, newTicketCode(), (ev.vol?.[1] ?? 0) > going.indexOf(uid)],
      );
    }
    for (const uid of fillers.slice(ev.going, ev.going + (ev.waitlist ?? 0))) {
      await pool.query("INSERT INTO rsvps (event_id, user_id, student_name, status) SELECT $1, u.id, u.name, 'waitlist' FROM users u WHERE u.id = $2", [row.id, uid]);
    }
  }
  await pool.query(
    `INSERT INTO event_schedule (event_id, at, title, speaker) VALUES
      ($1, $2, 'Opening keynote', 'Dr. Sana Malik'), ($1, $3, 'Robotics showcase', 'Mechatronics Lab'),
      ($1, $4, 'Hackathon demos', 'Top 8 teams'), ($1, $5, 'Closing and awards', 'Student Council')`,
    [created.tech, new Date(now - 45 * 60_000), new Date(now + 20 * 60_000), new Date(now + 90 * 60_000), new Date(now + 3 * HOUR)],
  );
  void admin;
  await seedSocietiesAndAlbums(pool, ids, fillers, opts.storage);
  await seedCampusLife(pool, ids, fillers);
}

// CLI: `npm run seed` (add `-- --reset` to wipe first)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await import('dotenv/config');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set (see .env.example).');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed development data in production.');
    process.exit(1);
  }
  const pool = createPool(url);
  try {
    await seed(pool, { reset: process.argv.includes('--reset'), storage: createStorage(process.env.UPLOADS_DIR ?? './uploads') });
    console.log('Seed complete. Test accounts: ayesha@iac.test (student), society@iac.test, admin@iac.test, security@iac.test ...');
  } finally {
    await pool.end();
  }
}
