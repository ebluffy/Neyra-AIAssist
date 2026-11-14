// Инвайт на регистрацию сайта Neyra (AR-2, AR-35): создаёт инвайт и печатает ссылку.
//
// Регистрация открыта только по инвайтам. Токен не хранится в базе — только sha256,
// лимит использований, срок и необязательная привязка к email. По умолчанию
// инвайт одноразовый и живёт 24 часа.
//
//   node scripts/invite-create.mjs                      # 1 использование, TTL 24 ч
//   node scripts/invite-create.mjs --ttl-hours 48
//   node scripts/invite-create.mjs --uses 5 --ttl-hours 168
//   node scripts/invite-create.mjs --uses unlimited --no-expiry
//   node scripts/invite-create.mjs --email user@example.test
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
const noExpiry = args.includes('--no-expiry');
const usesRaw = (arg('uses', '1') ?? '').trim().toLowerCase();
const maxUses = usesRaw === 'unlimited' ? null : Number.parseInt(usesRaw, 10);
const email = (arg('email', '') ?? '').trim().toLowerCase() || null;

if (!noExpiry && (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 24 * 30)) {
  console.error('Укажите --ttl-hours числом часов от 1 до 720 (или --no-expiry).');
  process.exit(2);
}
if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10000)) {
  console.error('Укажите --uses целым числом от 1 до 10000 или unlimited.');
  process.exit(2);
}
if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Укажите --email корректным адресом.');
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
const expiresAt = noExpiry ? null : new Date(Date.now() + ttlHours * 60 * 60 * 1000);

const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  await client.query(
    'insert into "invite" (id, token_hash, created_by, expires_at, max_uses, used_count, email) values ($1, $2, $3, $4, $5, 0, $6)',
    [randomUUID(), tokenHash, createdBy, expiresAt ? expiresAt.toISOString() : null, maxUses, email],
  );
} catch (error) {
  console.error(`Не удалось создать инвайт: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
if (process.exitCode) process.exit();

console.log(`Инвайт создан. Срок действия — ${expiresAt ? `до ${expiresAt.toISOString()} (UTC)` : 'без срока'}.`);
console.log(`Использований: ${maxUses === null ? 'без лимита' : maxUses}.${email ? ` Только для ${email}.` : ''}`);
if (createdBy) console.log(`Кем выдан: ${createdBy}`);
console.log('Ссылка (передайте её приглашённому):');
console.log(`${baseUrl}/signup?invite=${token}`);
