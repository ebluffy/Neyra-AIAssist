// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ToastHost } from './ToastHost';
import { dismissToast, emitToast } from '../../lib/toast';

describe('ToastHost stacking', () => {
  const ids: string[] = [];

  afterEach(() => {
    cleanup();
    ids.splice(0).forEach((id) => dismissToast(id));
  });

  it('renders multiple toasts as stack items without fixed positioning', () => {
    ids.push(emitToast({ message: 'first', duration: 0 }));
    ids.push(emitToast({ message: 'second', duration: 0 }));
    render(<ToastHost />);
    const toasts = screen.getAllByRole('status');
    expect(toasts).toHaveLength(2);
    for (const toast of toasts) {
      expect(toast.className).not.toContain('fixed');
    }
  });
});
