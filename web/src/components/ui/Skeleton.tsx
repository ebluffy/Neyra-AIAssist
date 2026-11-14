import React, { type HTMLAttributes } from 'react';

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'rectangular' | 'circular' | 'text';
}

export function Skeleton({
  variant = 'rectangular',
  className = '',
  ...props
}: SkeletonProps) {
  const variantClass = {
    rectangular: 'rounded-[var(--radius-sm)]',
    circular: 'rounded-full',
    text: 'rounded-[var(--radius-sm)] h-4 w-full',
  }[variant];

  return (
    <div
      aria-hidden="true"
      className={`animate-pulse bg-[var(--surface-3)] ${variantClass} ${className}`}
      {...props}
    />
  );
}
