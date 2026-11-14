import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildIdentityClaims,
  signIdentityJwt,
  createIdentityToken,
  verifyIdentityToken,
} from './identity';

describe('web/lib/identity', () => {
  const dummyUser = {
    id: 'user-uuid-1234',
    role: 'admin',
    name: 'Тестовый Пользователь',
    email: 'test@example.com',
  };
  const secret = 'super-secret-key-at-least-32-chars-long!';
  const defaultIssuer = 'neyra-web';

  beforeEach(() => {
    vi.stubEnv('NEYRA_IDENTITY_JWT_ISSUER', defaultIssuer);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds identity claims with 60s TTL, iss, and correct fields (§8)', () => {
    const fixedNow = 1700000000;
    const claims = buildIdentityClaims(dummyUser, {
      chat_id: 'chat-42',
      message_id: 'msg-99',
      task: 'chat',
      now: fixedNow,
    });

    expect(claims.iss).toBe('neyra-web');
    expect(claims.sub).toBe('user-uuid-1234');
    expect(claims.role).toBe('admin');
    expect(claims.name).toBe('Тестовый Пользователь');
    expect(claims.chat_id).toBe('chat-42');
    expect(claims.message_id).toBe('msg-99');
    expect(claims.task).toBe('chat');
    expect(claims.iat).toBe(fixedNow);
    expect(claims.exp).toBe(fixedNow + 60);
    expect(claims.exp - claims.iat).toBe(60);
  });

  it('requires NEYRA_IDENTITY_JWT_ISSUER to build claims', () => {
    vi.stubEnv('NEYRA_IDENTITY_JWT_ISSUER', '');
    expect(() => buildIdentityClaims(dummyUser)).toThrow(
      'Идентификатор эмитента NEYRA_IDENTITY_JWT_ISSUER обязателен'
    );
  });

  it('generates random UUIDs for chat_id and message_id if omitted', () => {
    const claims = buildIdentityClaims(dummyUser);
    expect(claims.chat_id).toBeDefined();
    expect(claims.message_id).toBeDefined();
    expect(claims.chat_id.length).toBeGreaterThan(0);
    expect(claims.message_id.length).toBeGreaterThan(0);
  });

  it('falls back to email or user id when name is absent', () => {
    const userWithoutName = { id: 'usr-1', email: 'mail@test.com' };
    const claims = buildIdentityClaims(userWithoutName);
    expect(claims.name).toBe('mail@test.com');
    expect(claims.role).toBe('user');
  });

  it('throws descriptive error if user or user.id is missing', () => {
    expect(() => buildIdentityClaims({ id: '' })).toThrow(
      'Пользователь и его идентификатор (sub) обязательны'
    );
  });

  it('throws descriptive error if secret is missing', async () => {
    const claims = buildIdentityClaims(dummyUser);
    const prevEnv = process.env.NEYRA_IDENTITY_JWT_SECRET;
    delete process.env.NEYRA_IDENTITY_JWT_SECRET;

    try {
      await expect(signIdentityJwt(claims)).rejects.toThrow(
        'Секрет NEYRA_IDENTITY_JWT_SECRET не задан'
      );
    } finally {
      if (prevEnv !== undefined) {
        process.env.NEYRA_IDENTITY_JWT_SECRET = prevEnv;
      }
    }
  });

  it('signs and verifies identity token using HS256', async () => {
    const fixedNow = 1700000000;
    const token = await createIdentityToken(dummyUser, secret, {
      chat_id: 'chat-abc',
      task: 'dialog',
      now: fixedNow,
    });

    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3);

    const { payload, protectedHeader } = await verifyIdentityToken(token, secret, {
      currentDate: new Date(fixedNow * 1000),
    });
    expect(protectedHeader.alg).toBe('HS256');
    expect(payload.iss).toBe('neyra-web');
    expect(payload.sub).toBe(dummyUser.id);
    expect(payload.role).toBe(dummyUser.role);
    expect(payload.name).toBe(dummyUser.name);
    expect(payload.chat_id).toBe('chat-abc');
    expect(payload.task).toBe('dialog');
    expect(payload.exp).toBe(1700000060);
  });

  it('rejects verification if token issuer is missing or does not match expected issuer', async () => {
    const fixedNow = 1700000000;
    const token = await createIdentityToken(dummyUser, secret, {
      issuer: 'custom-issuer',
      now: fixedNow,
    });

    // Matches custom-issuer
    const verified = await verifyIdentityToken(token, secret, {
      issuer: 'custom-issuer',
      currentDate: new Date(fixedNow * 1000),
    });
    expect(verified.payload.iss).toBe('custom-issuer');

    // Mismatched expected issuer rejects
    await expect(
      verifyIdentityToken(token, secret, {
        issuer: 'different-issuer',
        currentDate: new Date(fixedNow * 1000),
      })
    ).rejects.toThrow();

    // Default env issuer when token has custom-issuer rejects
    await expect(
      verifyIdentityToken(token, secret, {
        currentDate: new Date(fixedNow * 1000),
      })
    ).rejects.toThrow();
  });
});
