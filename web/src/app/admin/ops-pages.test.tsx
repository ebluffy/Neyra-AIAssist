// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import AdminModulesPage from './modules/page';
import AdminWebhooksPage from './webhooks/page';
import AdminBackupsPage from './core-backups/page';
import LegacyPage from '../legacy/page';
import { setFlagOverride } from '../../lib/feature-flags';

const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

describe('Admin Ops & Legacy Pages (AR-83, AR-85)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockNotFound.mockClear();
    window.localStorage?.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('calls notFound() when opsModules is disabled, renders honest state when enabled', () => {
    setFlagOverride('opsModules', false);
    expect(() => render(<AdminModulesPage />)).toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalled();

    cleanup();
    setFlagOverride('opsModules', true);
    render(<AdminModulesPage />);
    expect(screen.getByText('Подсистемы ядра (Ops Modules)')).toBeTruthy();
    expect(screen.getByText('Модули ядра не подключены')).toBeTruthy();
    expect(screen.queryByText('2.4.1')).toBeNull();
    expect(screen.queryByText(/14 мс/)).toBeNull();
  });

  it('calls notFound() when opsWebhooks is disabled, renders honest state when enabled', () => {
    setFlagOverride('opsWebhooks', false);
    expect(() => render(<AdminWebhooksPage />)).toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalled();

    cleanup();
    setFlagOverride('opsWebhooks', true);
    render(<AdminWebhooksPage />);
    expect(screen.getByText('Событийные вебхуки (Webhooks)')).toBeTruthy();
    expect(screen.getByText('Вебхуки ядра не настроены')).toBeTruthy();
    expect(screen.queryByText(/internal\.local/)).toBeNull();
  });

  it('calls notFound() when opsBackups is disabled, renders honest state when enabled', () => {
    setFlagOverride('opsBackups', false);
    expect(() => render(<AdminBackupsPage />)).toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalled();

    cleanup();
    setFlagOverride('opsBackups', true);
    render(<AdminBackupsPage />);
    expect(screen.getByText('Резервные копии ядра (Core Backups)')).toBeTruthy();
    expect(screen.getByText('Резервные копии не найдены')).toBeTruthy();
    expect(screen.queryByText(/tar\.gz/)).toBeNull();
  });

  it('calls notFound() when legacyUi is disabled, renders honest notice when enabled', () => {
    setFlagOverride('legacyUi', false);
    expect(() => render(<LegacyPage />)).toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalled();

    cleanup();
    setFlagOverride('legacyUi', true);
    render(<LegacyPage />);
    expect(screen.getByText(/Устаревший интерфейс управления/)).toBeTruthy();
  });
});
