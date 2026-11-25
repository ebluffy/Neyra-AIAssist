import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema';
import { readDatabaseUrl } from './env';
function createDatabase() {
  const pool = new Pool({ connectionString: readDatabaseUrl(), connectionTimeoutMillis: 5000 });
  return { pool, db: drizzle(pool, { schema }) };
}
let database: ReturnType<typeof createDatabase> | undefined;
// No pool/config access at import time. pg opens sockets only when a query runs.
export function getDatabase() { return database ??= createDatabase(); }
