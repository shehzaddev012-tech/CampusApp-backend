import 'dotenv/config';

import { hashPassword, passwordProblem } from '../auth/password.js';
import { ROLES, type Role } from '../domain.js';
import { createPool } from './pool.js';

/**
 * Creates (or updates) a person who signs in with email + password, already verified and approved.
 * Use it for the first admin of a university and for test accounts.
 *
 *   npm run create-user -- --email admin@uni.edu --name "Dr. Admin" --password "Strong#Pass1" \
 *       --uni iac --role uni_admin [--student-id ADM-001] [--department "Art"]
 */
function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key?.startsWith('--')) {
      out[key.slice(2)] = argv[i + 1] ?? '';
      i++;
    }
  }
  return out;
}

const a = args();
const email = (a.email ?? '').trim().toLowerCase();
const name = (a.name ?? '').trim();
const password = a.password ?? '';
const uni = (a.uni ?? '').trim();
const role = (a.role ?? 'student') as Role;

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

if (!email || !name || !password || !uni) {
  fail('Required: --email --name --password --uni   (optional: --role --student-id --department --batch)');
}
if (!ROLES.includes(role)) {
  fail(`--role must be one of: ${ROLES.join(', ')}`);
}
const problem = passwordProblem(password, email);
if (problem) {
  fail(problem);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  fail('DATABASE_URL is not set (see .env).');
}
const pool = createPool(databaseUrl);

try {
  const university = await pool.query<{ id: string }>('SELECT id FROM universities WHERE id = $1', [uni]);
  if (!university.rowCount) {
    fail(`No university "${uni}". Create it first (or run the seed).`);
  }
  const department = a.department ?? (await pool.query<{ name: string }>('SELECT name FROM departments WHERE university_id = $1 ORDER BY name LIMIT 1', [uni])).rows[0]?.name ?? 'General';
  const hash = await hashPassword(password);

  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash, email_verified_at) VALUES ($1, $2, $3, now())
     ON CONFLICT ((lower(email))) DO UPDATE
       SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash,
           email_verified_at = COALESCE(users.email_verified_at, now()), failed_logins = 0, locked_until = NULL
     RETURNING id`,
    [email, name, hash],
  );
  const id = (user.rows[0] as { id: string }).id;

  await pool.query(
    `INSERT INTO memberships (user_id, university_id, student_id, department, batch, role, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     ON CONFLICT (user_id) DO UPDATE
       SET university_id = EXCLUDED.university_id, student_id = EXCLUDED.student_id, department = EXCLUDED.department,
           batch = EXCLUDED.batch, role = EXCLUDED.role, status = 'active'`,
    [id, uni, a['student-id'] ?? `${role.toUpperCase().slice(0, 3)}-${id.slice(0, 6)}`, department, a.batch ?? '', role],
  );
  console.log(`Ready: ${name} <${email}> is ${role} at ${uni}. They can sign in with the email and password you gave.`);
} finally {
  await pool.end();
}
