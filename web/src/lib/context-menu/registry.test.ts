// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const emitToast = vi.fn();
vi.mock('../toast', () => ({
  emitToast: (...args: unknown[]) => emitToast(...args),
  soonToast: vi.fn(),
}));

import { copyText } from './registry';

afterEach(() => {
  emitToast.mockReset();
  vi.unstubAllGlobals();
});

describe('copyText (AR-78)', () => {
  it('reports success only after the clipboard write resolves', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await copyText('hello', 'Скопировано');
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(emitToast).toHaveBeenCalledWith({ message: 'Скопировано', tone: 'success' });
  });

  it('does not claim success when the clipboard rejects', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('denied');
        }),
      },
    });
    await copyText('hello', 'Скопировано');
    expect(emitToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
    expect(emitToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger' }));
  });
});
