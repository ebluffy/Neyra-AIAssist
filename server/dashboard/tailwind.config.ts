import type { Config } from 'tailwindcss'
import typography from '@tailwindcss/typography'

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'var(--bg)',
        foreground: 'var(--text)',
        card: 'var(--surface)',
        muted: 'var(--muted)',
        border: 'var(--border)',
        accent: 'var(--cyan)',
        'accent-cyan': 'var(--cyan)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        cyan: 'var(--cyan)',
        emerald: 'var(--emerald)',
        amber: 'var(--amber)',
        danger: 'var(--danger)',
      },
      fontFamily: {
        sans: ['Fira Sans', 'system-ui', 'sans-serif'],
        mono: ['Fira Code', 'Consolas', 'monospace'],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg: 'var(--radius-lg)',
      },
      keyframes: {
        'slide-in-left': {
          from: { transform: 'translateX(-100%)', opacity: '0' },
          to: { transform: 'translateX(0)', opacity: '1' },
        },
        'fade-in-up': {
          from: { transform: 'translateY(8px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'dot-blink': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
      },
      animation: {
        'slide-in-left': 'slide-in-left 0.3s ease-out',
        'fade-in-up': 'fade-in-up 0.35s ease-out',
        shimmer: 'shimmer 2s linear infinite',
        'dot-blink': 'dot-blink 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [typography],
} satisfies Config
