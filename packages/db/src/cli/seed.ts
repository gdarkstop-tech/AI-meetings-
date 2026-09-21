/**
 * Development seed. Creates one workspace, one owner and one member.
 * Refuses to run against NODE_ENV=production.
 */
import { scryptSync, randomBytes } from 'node:crypto';
import { createPool, withTransaction } from '../client.js';
import { addMember, createWorkspace } from '../repositories/workspaces.js';
import { createUser, findUserByEmail } from '../repositories/users.js';
import { writeAudit } from '../repositories/audit.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed a production database.');
  process.exit(1);
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

// Mirrors apps/api/src/auth/password.ts (scrypt, same parameters).
function hash(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize('NFKC'), salt, 64);
  return ['scrypt', 16384, 8, 1, salt.toString('base64'), derived.toString('base64')].join('$');
}

const OWNER_EMAIL = process.env.SEED_OWNER_EMAIL ?? 'owner@example.com';
const MEMBER_EMAIL = process.env.SEED_MEMBER_EMAIL ?? 'member@example.com';
const PASSWORD = process.env.SEED_PASSWORD ?? 'dev-password-change-me';

const pool = createPool({ connectionString });
try {
  if (await findUserByEmail(pool, OWNER_EMAIL)) {
    console.log('[seed] owner already exists; nothing to do.');
  } else {
    await withTransaction(pool, async (client) => {
      const owner = await createUser(client, {
        email: OWNER_EMAIL, name: 'Dev Owner', passwordHash: hash(PASSWORD), locale: 'en',
      });
      const member = await createUser(client, {
        email: MEMBER_EMAIL, name: 'Dev Member', passwordHash: hash(PASSWORD), locale: 'ar',
      });
      const ws = await createWorkspace(client, { name: 'Development workspace', localeDefault: 'en' });
      await addMember(client, { workspaceId: ws.id, userId: owner.id, role: 'owner' });
      await addMember(client, { workspaceId: ws.id, userId: member.id, role: 'member' });
      await writeAudit(client, {
        workspaceId: ws.id, actorType: 'system', actorId: null,
        action: 'workspace.seed', targetType: 'workspace', targetId: ws.id, result: 'success',
      });
      console.log(`[seed] workspace ${ws.id} with ${OWNER_EMAIL} (owner) and ${MEMBER_EMAIL} (member)`);
    });
  }
} finally {
  await pool.end();
}
