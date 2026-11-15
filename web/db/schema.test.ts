import { it, expect } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { user, session, account, verification, invite, adminAudit, roleEnum } from './schema';
it('provides all four Better Auth tables and core columns', () => {
 expect([user,session,account,verification].map(getTableName)).toEqual(['user','session','account','verification']);
 expect(Object.keys(getTableColumns(user))).toEqual(expect.arrayContaining(['id','name','email','emailVerified','role','createdAt','updatedAt']));
 expect(Object.keys(getTableColumns(session))).toEqual(expect.arrayContaining(['token','expiresAt','userId','ipAddress','userAgent']));
 expect(Object.keys(getTableColumns(account))).toEqual(expect.arrayContaining(['accountId','providerId','userId','password','accessToken','refreshToken']));
 expect(Object.keys(getTableColumns(verification))).toEqual(expect.arrayContaining(['identifier','value','expiresAt']));
});
it('uses non-null user role by default and preserves credential uniqueness', () => {
 expect(roleEnum.enumValues).toEqual(['admin','user']); expect(user.role.default).toBe('user'); expect(user.role.notNull).toBe(true);
 expect(user.email.isUnique).toBe(true); expect(session.token.isUnique).toBe(true);
});
it('cascades dependent records on user deletion', () => {
 expect(getTableConfig(session).foreignKeys[0].onDelete).toBe('cascade'); expect(getTableConfig(account).foreignKeys[0].onDelete).toBe('cascade');
});
it('carries admin fields: ban, last login and audit log', () => {
 expect(Object.keys(getTableColumns(user))).toEqual(expect.arrayContaining(['banned','banReason','lastLoginAt']));
 expect(user.banned.default).toBe(false);
 expect(getTableName(adminAudit)).toBe('admin_audit');
 expect(Object.keys(getTableColumns(adminAudit))).toEqual(expect.arrayContaining(['actorId','actorEmail','action','targetType','targetId','details','createdAt']));
 expect(Object.keys(getTableColumns(invite))).toEqual(expect.arrayContaining(['revokedAt']));
});
