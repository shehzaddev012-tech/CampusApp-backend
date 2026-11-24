import type { Db } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import type { Routes } from './types.js';

export interface UniversityDto {
  id: string;
  name: string;
  fullName: string;
  accent: string;
  departments: string[];
  studentCount: number;
}

const SELECT = `
  SELECT u.id, u.name, u.full_name, u.accent,
         COALESCE((SELECT array_agg(d.name ORDER BY d.name) FROM departments d WHERE d.university_id = u.id), '{}') AS departments,
         (SELECT count(*)::int FROM memberships m WHERE m.university_id = u.id AND m.status = 'active') AS student_count
    FROM universities u`;

interface Row {
  id: string;
  name: string;
  full_name: string;
  accent: string;
  departments: string[];
  student_count: number;
}

const toDto = (r: Row): UniversityDto => ({
  id: r.id,
  name: r.name,
  fullName: r.full_name,
  accent: r.accent,
  departments: r.departments,
  studentCount: r.student_count,
});

export async function getUniversity(db: Db, id: string): Promise<UniversityDto | null> {
  const { rows } = await db.query<Row>(`${SELECT} WHERE u.id = $1`, [id]);
  return rows[0] ? toDto(rows[0]) : null;
}

export const universitiesRoutes: Routes = async (app, { deps }) => {
  // Public: a new student must see the list before they have an account in a university.
  app.get('/universities', async () => {
    const { rows } = await deps.pool.query<Row>(`${SELECT} ORDER BY u.name`);
    return { universities: rows.map(toDto) };
  });

  app.get<{ Params: { id: string } }>('/universities/:id', async req => {
    const u = await getUniversity(deps.pool, req.params.id);
    if (!u) {
      throw notFound('University not found.');
    }
    return u;
  });
};
