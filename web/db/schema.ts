import { relations } from 'drizzle-orm';
import { pgTable, pgEnum, text, timestamp, boolean, integer, index, jsonb } from 'drizzle-orm/pg-core';
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
  // Завершение онбординга: серверный признак, а не localStorage браузера.
  onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
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
// Инвайты на регистрацию (AR-2, AR-35): хранится только хэш токена.
// max_uses = null — без лимита; 1 — одноразовый. expires_at = null — без срока.
// email = null — подходит любому; иначе код принимается только для этого адреса.
export const invite = pgTable('invite', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  maxUses: integer('max_uses'),
  usedCount: integer('used_count').default(0).notNull(),
  email: text('email'),
  // Последнее использование: показывается в списке.
  usedBy: text('used_by'),
  usedAt: timestamp('used_at', { withTimezone: true }),
  // Отзыв админом: строка остаётся в списке, но инвайт недействителен.
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
// AR-39/AR-40: каждое успешное использование инвайта отдельной строкой.
// Журнал админки хранит действие invite.use; эта таблица — источник для
// восстановления used_by/used_at, если регистрация сорвалась после списания.
export const inviteUse = pgTable('invite_use', {
  id: text('id').primaryKey(),
  inviteId: text('invite_id').notNull().references(() => invite.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
  usedAt: timestamp('used_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [index('invite_use_invite_idx').on(table.inviteId, table.usedAt)]);

// Чаты и сообщения сайта: история должна переживать перезагрузку и другое устройство.
export const folder = pgTable('folder', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  position: integer('position').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [index('folder_user_idx').on(table.userId, table.position)]);
export const conversation = pgTable('conversation', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  title: text('title').default('Новый диалог').notNull(),
  model: text('model'),
  pinned: boolean('pinned').default(false).notNull(),
  folderId: text('folder_id').references(() => folder.id, { onDelete: 'set null' }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, table => [
  index('conversation_user_updated_idx').on(table.userId, table.updatedAt),
  index('conversation_user_pinned_idx').on(table.userId, table.pinned),
]);
export const message = pgTable('message', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversation.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  model: text('model'),
  status: text('status').default('done').notNull(),
  errorCode: text('error_code'),
  attachments: jsonb('attachments'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [index('message_conversation_created_idx').on(table.conversationId, table.createdAt)]);

// Ссылка на диалог только для вошедших. В базе хранится hash токена, не сам токен.
export const share = pgTable('share', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversation.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [
  index('share_conversation_idx').on(table.conversationId),
  index('share_user_idx').on(table.userId),
]);

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
