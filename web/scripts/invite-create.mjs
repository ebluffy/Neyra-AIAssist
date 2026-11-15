// Инвайт на регистрацию сайта Neyra (AR-2): создаёт одноразовый инвайт и печатает ссылку.
//
// Регистрация открыта только по инвайтам. Токен не хранится в базе — только sha256,
// срок действия и факт использования. Ссылка одноразовая, по умолчанию живёт 24 часа.
//
//   node scripts/invite-create.mjs                      # TTL 24 ч
//   node scripts/invite-create.mjs --ttl-hours 48
//   node scripts/invite-create.mjs --by admin@example.test
//
// Нужны DATABASE_URL и BETTER_AUTH_URL (origin сайта). На площадке:
//   set -a; . /opt/neyra/web/.env; set +a
//   cd /opt/neyra/web/app/web && node scripts/invite-create.mjs

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}
const ttlHours = Number.parseFloat(arg('ttl-hours', '24'));
const createdBy = (arg('by', '') ?? '').trim().toLowerCase() || null;

if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 24 * 30) {
  console.error('Укажите --ttl-hours числом часов от 0 до 720.');
  process.exit(2);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Не задана DATABASE_URL. На площадке: set -a; . /opt/neyra/web/.env; set +a');
  process.exit(2);
}
const baseUrl = (process.env.BETTER_AUTH_URL || '').replace(/\/$/, '');
if (!/^https?:\/\/[^\s/]+$/i.test(baseUrl)) {
  console.error('Задайте BETTER_AUTH_URL — HTTP(S) origin сайта (без пути).');
  process.exit(2);
}

const token = randomBytes(24).toString('base64url');
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  await client.query(
    'insert into "invite" (id, token_hash, created_by, expires_at) values ($1, $2, $3, $4)',
    [randomUUID(), tokenHash, createdBy, expiresAt.toISOString()],
  );
} catch (error) {
  console.error(`Не удалось создать инвайт: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
if (process.exitCode) process.exit();

console.log(`Инвайт создан. Срок действия — до ${expiresAt.toISOString()} (UTC).`);
if (createdBy) console.log(`Кем выдан: ${createdBy}`);
console.log('Одноразовая ссылка (передайте её приглашённому):');
console.log(`${baseUrl}/signup?invite=${token}`);
