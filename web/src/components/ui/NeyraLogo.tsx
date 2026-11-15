import React from 'react';

export function NeyraLogo({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect width="32" height="32" rx="8" fill="var(--surface-3)" stroke="var(--border)" strokeWidth="1" />
      {/* «N» с точкой на верхнем конце правой ножки: буква плюс узел связи */}
      <path
        d="M9.5 22.5V9.5L22.5 22.5V15.5"
        stroke="var(--accent)"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="22.5" cy="12" r="2.4" fill="var(--accent)" />
    </svg>
  );
}
