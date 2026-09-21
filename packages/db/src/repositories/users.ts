import type { Queryable } from '../client.js';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  locale: 'ar' | 'en';
  timezone: string;
  status: 'active' | 'suspended';
  last_login_at: Date | null;
  created_at: Date;
}

export async function createUser(
  db: Queryable,
  input: { email: string; name: string; passwordHash: string; locale?: 'ar' | 'en'; timezone?: string },
): Promise<UserRow> {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (email, name, password_hash, locale, timezone)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [input.email, input.name, input.passwordHash, input.locale ?? 'en', input.timezone ?? 'UTC'],
  );
  return rows[0];
}

export async function findUserByEmail(db: Queryable, email: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  return rows[0] ?? null;
}

export async function findUserById(db: Queryable, id: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function touchLastLogin(db: Queryable, userId: string): Promise<void> {
  await db.query('UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1', [userId]);
}

export async function updateUserPreferences(
  db: Queryable,
  userId: string,
  prefs: { locale?: 'ar' | 'en'; timezone?: string },
): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    `UPDATE users
        SET locale = COALESCE($2, locale),
            timezone = COALESCE($3, timezone),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [userId, prefs.locale ?? null, prefs.timezone ?? null],
  );
  return rows[0] ?? null;
}
