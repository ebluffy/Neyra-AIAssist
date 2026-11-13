import { relations } from 'drizzle-orm';
import { pgTable, pgEnum, text, timestamp, boolean, index, jsonb } from 'drizzle-orm/pg-core';
export const DEFAULT_ROLE = 'user' as const;
export const roleEnum = pgEnum('role', ['admin', 'user']);
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  role: roleEnum('role').default(DEFAULT_ROLE).notNull(),
  // Блокировка админом: вход запрещён, живые сессии удаляются при блокировке.
  banned: boolean('banned').default(false).notNull(),
  banReason: text('ban_reason'),
  // Последний успешный вход (обновляется хуком after на /sign-in/email).
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
});
export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
}, table => [index('session_user_id_idx').on(table.userId)]);
export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, table => [index('account_user_id_idx').on(table.userId)]);
export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, table => [index('verification_identifier_idx').on(table.identifier)]);
// Одноразовые инвайты на регистрацию (AR-2): хранится только хэш токена.
export const invite = pgTable('invite', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedBy: text('used_by'),
  usedAt: timestamp('used_at', { withTimezone: true }),
  // Отзыв админом: строка остаётся в списке, но инвайт недействителен.
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
// Настройки сайта, управляемые админом (пока — режим регистрации).
export const siteSetting = pgTable('site_setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
// Журнал действий админки. Пишется только сервером; строки переживают удаление аккаунта.
export const adminAudit = pgTable('admin_audit', {
  id: text('id').primaryKey(),
  actorId: text('actor_id').notNull(),
  actorEmail: text('actor_email').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  details: jsonb('details'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [index('admin_audit_created_at_idx').on(table.createdAt)]);
export const userRelations = relations(user, ({ many }) => ({ sessions: many(session), accounts: many(account) }));
export const sessionRelations = relations(session, ({ one }) => ({ user: one(user, { fields: [session.userId], references: [user.id] }) }));
export const accountRelations = relations(account, ({ one }) => ({ user: one(user, { fields: [account.userId], references: [user.id] }) }));
export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;
export type Session = typeof session.$inferSelect;
export type Account = typeof account.$inferSelect;
export type Verification = typeof verification.$inferSelect;
export type Invite = typeof invite.$inferSelect;
export type AdminAudit = typeof adminAudit.$inferSelect;
export type SiteSetting = typeof siteSetting.$inferSelect;
