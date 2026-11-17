'use client';

import React, { cloneElement, isValidElement } from 'react';
import { isEnabled, type Flag } from '../../lib/feature-flags';
import { soonToast } from '../../lib/toast';
import { playButtonClickSound } from '../../lib/ui-sounds';

export interface SoonActionProps {
  flag?: Flag;
  featureName?: string;
  actionName?: string;
  description?: string;
  children: React.ReactElement<{
    onClick?: React.MouseEventHandler;
    onKeyDown?: React.KeyboardEventHandler;
    className?: string;
    title?: string;
    'aria-disabled'?: boolean | 'true' | 'false';
  }>;
}

export function SoonAction({
  flag,
  featureName,
  actionName,
  description,
  children,
}: SoonActionProps) {
  const name = featureName || actionName || 'Действие';
  const enabled = flag ? isEnabled(flag) : false;

  if (enabled) {
    return children;
  }

  if (!isValidElement(children)) {
    return null;
  }

  const handleIntercept = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    playButtonClickSound();
    soonToast(name, description);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      playButtonClickSound();
      soonToast(name, description);
    }
  };

  const existingClassName = children.props.className || '';
  const stubClasses = 'opacity-65 cursor-not-allowed select-none';

  return cloneElement(children, {
    onClick: handleIntercept,
    onKeyDown: handleKeyDown,
    'aria-disabled': 'true',
    title: `Скоро: ${name}`,
    className: `${existingClassName} ${stubClasses}`.trim(),
  });
}
