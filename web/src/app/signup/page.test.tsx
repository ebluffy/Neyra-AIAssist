import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthForm } from '../../components/auth-form';

// Next собирает JSX автоматическим рантаймом; vitest/esbuild — классическим,
// поэтому React должен быть в области видимости страницы.
vi.stubGlobal('React', React);

const state = vi.hoisted(() => ({ mode: 'invite' }));

vi.mock('../../../lib/site-settings', () => ({
  getRegistrationMode: vi.fn(async () => state.mode),
}));

vi.stubEnv('DATABASE_URL', 'postgres://user:pass@127.0.0.1:5432/db');
vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-at-least-32-characters-long');
vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:3000');

async function renderSignup() {
  const { default: Signup } = await import('./page');
  return (await Signup({ searchParams: Promise.resolve({}) })) as React.ReactElement;
}

function propsOf(element: React.ReactElement): { registrationMode?: string; config?: { inviteRequired?: boolean } } {
  return element.props as { registrationMode?: string; config?: { inviteRequired?: boolean } };
}

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (React.isValidElement(node)) return textOf((node.props as { children?: unknown }).children);
  return '';
}

beforeEach(() => {
  state.mode = 'invite';
});

describe('signup page reads the registration mode on the server', () => {
  it('shows the form with a required invite in invite mode', async () => {
    state.mode = 'invite';
    const element = await renderSignup();
    expect(element.type).toBe(AuthForm);
    expect(propsOf(element).registrationMode).toBe('invite');
    expect(propsOf(element).config?.inviteRequired).toBe(true);
  });

  it('drops the invite requirement in open mode', async () => {
    state.mode = 'open';
    const element = await renderSignup();
    expect(element.type).toBe(AuthForm);
    expect(propsOf(element).registrationMode).toBe('open');
    expect(propsOf(element).config?.inviteRequired).toBe(false);
  });

  it('renders the closed message instead of the form in closed mode', async () => {
    state.mode = 'closed';
    const element = await renderSignup();
    expect(element.type).toBe('main');
    const text = textOf(element);
    expect(text).toContain('Регистрация закрыта');
    expect(text).toContain('закрыта администратором Нейры');
  });
});
