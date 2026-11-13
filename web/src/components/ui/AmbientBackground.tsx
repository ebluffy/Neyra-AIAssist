'use client';

import React, { useEffect, useRef } from 'react';

// Лёгкий фон: редкие белые точки, которые медленно плывут, и мягкое пятно света,
// идущее за курсором. Всё на transform/opacity, отключается при prefers-reduced-motion.
// Позиции точек фиксированы, чтобы серверный и клиентский рендер совпадали.
const DOTS = [
  { left: '8%', top: '18%', size: 2, delay: '0s', duration: '26s' },
  { left: '22%', top: '72%', size: 1.5, delay: '-6s', duration: '32s' },
  { left: '37%', top: '12%', size: 1.5, delay: '-12s', duration: '28s' },
  { left: '54%', top: '64%', size: 2, delay: '-3s', duration: '34s' },
  { left: '68%', top: '26%', size: 1.5, delay: '-18s', duration: '30s' },
  { left: '81%', top: '78%', size: 2, delay: '-9s', duration: '36s' },
  { left: '91%', top: '40%', size: 1.5, delay: '-22s', duration: '27s' },
  { left: '14%', top: '48%', size: 1.5, delay: '-15s', duration: '33s' },
  { left: '63%', top: '88%', size: 1.5, delay: '-5s', duration: '31s' },
  { left: '45%', top: '36%', size: 1.5, delay: '-25s', duration: '29s' },
];

export function AmbientBackground() {
  const glowRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    if (reduce || coarse) return;

    let frame = 0;
    const onMove = (event: PointerEvent) => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const x = `${event.clientX}px`;
        const y = `${event.clientY}px`;
        if (glowRef.current) {
          glowRef.current.style.setProperty('--glow-x', x);
          glowRef.current.style.setProperty('--glow-y', y);
        }
        if (ringRef.current) {
          ringRef.current.style.setProperty('--ring-x', x);
          ringRef.current.style.setProperty('--ring-y', y);
          ringRef.current.dataset.visible = '1';
        }
      });
    };
    const onLeave = () => {
      if (ringRef.current) ringRef.current.dataset.visible = '0';
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div ref={glowRef} className="ambient-glow" />
      {DOTS.map((dot, index) => (
        <span
          key={index}
          className="ambient-dot"
          style={{
            left: dot.left,
            top: dot.top,
            width: dot.size,
            height: dot.size,
            animationDelay: dot.delay,
            animationDuration: dot.duration,
          }}
        />
      ))}
      <div ref={ringRef} className="ambient-ring" data-visible="0" />
    </div>
  );
}
