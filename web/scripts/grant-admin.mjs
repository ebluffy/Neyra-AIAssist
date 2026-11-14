#!/usr/bin/env node
// Выдача и снятие роли администратора сайта Neyra.
//
// Роль не выдаётся при регистрации: адрес почты не доказывает владение, а открытая
// регистрация позволила бы постороннему занять перечисленный адрес. Поэтому админ
// назначается этой командой с сервера, после того как человек зарегистрировался сам.
//
//   node scripts/grant-admin.mjs user@example.com          # выдать admin
//   node scripts/grant-admin.mjs user@example.com --revoke # вернуть user
//
// Нужен DATABASE_URL. На площадке:
//   set -a; . /opt/neyra/web/.env; set +a
//   cd /opt/neyra/web/app/web && node scripts/grant-admin.mjs user@example.com

import { Client } from 'pg';

const email = (process.argv[2] ?? '').trim().toLowerCase();
const revoke = process.argv.includes('--revoke');

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Укажите корректный email: node scripts/grant-admin.mjs user@example.com [--revoke]');
  process.exit(2);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Не задана DATABASE_URL. На площадке: set -a; . /opt/neyra/web/.env; set +a');
  process.exit(2);
}

const role = revoke ? 'user' : 'admin';
const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  const result = await client.query('update "user" set role = $1 where lower(email) = $2', [role, email]);
  if (result.rowCount === 0) {
    console.error(`Пользователь ${email} не найден. Сначала он должен зарегистрироваться на сайте.`);
    process.exitCode = 1;
  } else {
    console.log(`${email}: роль ${role} (обновлено записей: ${result.rowCount})`);
  }
} catch (error) {
  console.error(`Не удалось обновить роль: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
