import { createPool } from '../client.js';
import { checkExtensions, migrate } from '../migrate.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const pool = createPool({ connectionString });
try {
  const applied = await migrate(pool, (m) => console.log(`[migrate] ${m}`));
  console.log(applied.length ? `[migrate] ${applied.length} migration(s) applied.` : '[migrate] up to date.');
  const extensions = await checkExtensions(pool);
  for (const ext of extensions) {
    console.log(
      `[extensions] ${ext.name}: ${ext.installed ? `installed ${ext.version}` : ext.available ? 'AVAILABLE BUT NOT INSTALLED' : 'NOT AVAILABLE'}`,
    );
  }
  const missing = extensions.filter((e) => !e.installed);
  if (missing.length) {
    console.error(`[extensions] missing: ${missing.map((m) => m.name).join(', ')}`);
    process.exit(2);
  }
} catch (err) {
  console.error(`[migrate] failed: ${(err as Error).message}`);
  process.exit(1);
} finally {
  await pool.end();
}
