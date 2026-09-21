import { createPool } from '../client.js';
import { checkExtensions } from '../migrate.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const pool = createPool({ connectionString });
try {
  const rows = await checkExtensions(pool);
  console.table(rows);
  process.exit(rows.every((r) => r.installed) ? 0 : 2);
} finally {
  await pool.end();
}
