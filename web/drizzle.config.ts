import { defineConfig } from 'drizzle-kit';
// Generation is offline. migrate reads DATABASE_URL at command time.
export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.ts',
  out: './db/migrations',
  ...(process.env.DATABASE_URL ? { dbCredentials: { url: process.env.DATABASE_URL } } : {}),
});
