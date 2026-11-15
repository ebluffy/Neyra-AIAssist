import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Honest Actions & Zero Fake Successes Audit (§5)', () => {
  const srcDir = path.resolve(__dirname, '..');

  function getSourceFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '.next') {
          files.push(...getSourceFiles(full));
        }
      } else if (
        (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) &&
        !e.name.includes('.test.') &&
        !e.name.includes('.spec.')
      ) {
        files.push(full);
      }
    }
    return files;
  }

  it('ensures no destructive or mutation actions use fake success toasts without real API fetch', () => {
    const files = getSourceFiles(srcDir);
    const fakeSuccessKeywords = [
      /сохранено/i,
      /отправлено/i,
      /объединено/i,
      /отозвано/i,
      /удалено/i,
      /сброшено/i,
    ];

    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // If line invokes emitToast
        if (line.includes('emitToast(')) {
          // Look around 10 lines window for success tone or fake success words
          const window = lines.slice(Math.max(0, i - 5), Math.min(lines.length, i + 8)).join('\n');
          for (const kw of fakeSuccessKeywords) {
            if (kw.test(window)) {
              // Now inspect the containing function/block (search backwards 50 lines) to ensure fetch is present
              const enclosing = lines.slice(Math.max(0, i - 45), i + 5).join('\n');
              const hasFetch = enclosing.includes('fetch(') || enclosing.includes('navigator.clipboard');
              if (!hasFetch) {
                violations.push({
                  file: path.relative(srcDir, file),
                  line: i + 1,
                  text: line.trim(),
                });
              }
            }
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('ensures SoonAction and soonToast are used for unbacked actions', () => {
    const settingsDialogContent = fs.readFileSync(
      path.join(srcDir, 'components', 'settings-dialog.tsx'),
      'utf-8',
    );

    // Verify stubbed actions use soonToast or SoonAction
    expect(settingsDialogContent).toContain('soonToast');
    expect(settingsDialogContent).toContain('SoonAction');

    // Context menu registry should also use soonToast
    const registryContent = fs.readFileSync(
      path.join(srcDir, 'lib', 'context-menu', 'registry.ts'),
      'utf-8',
    );
    expect(registryContent).toContain('soonToast');
  });

  // AR-71: «Удалить навсегда» раньше только закрывала диалог и разлогинивала,
  // обещая безвозвратное удаление данных.
  it('AR-71: delete-account dialog does not promise deletion it cannot do', () => {
    const content = fs.readFileSync(
      path.join(srcDir, 'components', 'settings-dialog.tsx'),
      'utf-8',
    );
    const modalStart = content.indexOf('{/* Delete Account Modal */}');
    expect(modalStart).toBeGreaterThan(-1);
    const modal = content.slice(modalStart);

    expect(content).not.toMatch(/безвозвратн/i);
    expect(modal).not.toContain('onSignOut');
    const soon = modal.indexOf('<SoonAction');
    const button = modal.indexOf('Удалить навсегда');
    expect(soon).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(soon);
  });

  // AR-72: переключатели приватности и онбординг не должны изображать
  // сохранение настроек, которого нет.
  it('AR-72: privacy switches stay read-only and onboarding does not fake success', () => {
    const settings = fs.readFileSync(
      path.join(srcDir, 'components', 'settings-dialog.tsx'),
      'utf-8',
    );
    expect(settings).not.toContain("writeFlag('neyra:remember-context'");
    expect(settings).not.toContain("writeFlag('neyra:sync-discord'");
    expect(settings).toContain('label="Память контекста"');
    expect(settings).toMatch(/label="Память контекста"\s+disabled/);
    expect(settings).toMatch(/label="Запрет обучения"\s+disabled/);

    const onboarding = fs.readFileSync(path.join(srcDir, 'app', 'onboarding', 'page.tsx'), 'utf-8');
    expect(onboarding).not.toMatch(/успешно настроен/i);
    expect(onboarding).not.toContain("setItem('neyra:remember-context'");
    expect(onboarding).not.toContain("setItem('neyra:sync-discord'");
    expect(onboarding).toContain("fetch('/api/me'");
    expect(onboarding).toMatch(/disabled/);
  });

  // AR-74: своё имя меняется через /api/me, а не через админскую ручку.
  it('AR-74: profile name is saved through the own-user route', () => {
    const settings = fs.readFileSync(
      path.join(srcDir, 'components', 'settings-dialog.tsx'),
      'utf-8',
    );
    expect(settings).toContain("fetch('/api/me'");
    expect(settings).not.toContain('/api/admin/users/${encodeURIComponent(user.id)}');
    expect(settings).toContain('router.refresh()');
  });

  // AR-75: витрина OpenCode CLI без функции не показывается до #77.
  it('AR-75: OpenCode CLI block and its modals stay behind the flag', () => {
    const providers = fs.readFileSync(
      path.join(srcDir, 'components', 'admin', 'providers-section.tsx'),
      'utf-8',
    );
    expect(providers).toContain("isEnabled('providersCatalog')");
    expect(providers.match(/providersCatalogEnabled &&/g)).toHaveLength(3);
  });
});
