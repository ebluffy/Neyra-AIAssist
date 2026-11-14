'use client';

import React, { useEffect, useRef, useState } from 'react';

// Лёгкий фон: редкие белые точки, которые медленно плывут, и мягкое пятно света,
// идущее за курсором. Всё на transform/opacity, отключается при prefers-reduced-motion.
// Позиции точек фиксированы, чтобы серверный и клиентский рендер совпадали.
const DOTS = [
  { left: '8%', top: '18%', size: 3, delay: '0s', duration: '22s' },
  { left: '22%', top: '72%', size: 2, delay: '-6s', duration: '28s' },
  { left: '37%', top: '12%', size: 2.5, delay: '-12s', duration: '24s' },
  { left: '54%', top: '64%', size: 3, delay: '-3s', duration: '30s' },
  { left: '68%', top: '26%', size: 2, delay: '-18s', duration: '26s' },
  { left: '81%', top: '78%', size: 3, delay: '-9s', duration: '32s' },
  { left: '91%', top: '40%', size: 2, delay: '-22s', duration: '23s' },
  { left: '14%', top: '48%', size: 2.5, delay: '-15s', duration: '29s' },
  { left: '63%', top: '88%', size: 2, delay: '-5s', duration: '27s' },
  { left: '45%', top: '36%', size: 2.5, delay: '-25s', duration: '25s' },
  { left: '30%', top: '90%', size: 2, delay: '-11s', duration: '31s' },
  { left: '76%', top: '8%', size: 2.5, delay: '-2s', duration: '21s' },
  { left: '58%', top: '50%', size: 2, delay: '-20s', duration: '33s' },
  { left: '96%', top: '66%', size: 2, delay: '-13s', duration: '24s' },
];

function flag(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(key);
  return raw === null ? fallback : raw === '1';
}

export function AmbientBackground() {
  const glowRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const [particles, setParticles] = useState(true);
  const [ring, setRing] = useState(true);

  useEffect(() => {
    const sync = () => {
      setParticles(flag('neyra:bg-particles', true));
      setRing(flag('neyra:cursor-ring', true));
    };
    sync();
    window.addEventListener('neyra:appearance', sync);
    return () => window.removeEventListener('neyra:appearance', sync);
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    if (reduce || coarse || !ring) return;

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
  }, [ring]);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div ref={glowRef} className="ambient-glow" />
      {particles && DOTS.map((dot, index) => (
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
      {ring && <div ref={ringRef} className="ambient-ring" data-visible="0" />}
    </div>
  );
}
