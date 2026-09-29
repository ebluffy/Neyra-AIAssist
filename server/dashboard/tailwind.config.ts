import type { Config } from 'tailwindcss'
import typography from '@tailwindcss/typography'

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'hsl(240 15% 4%)',
        foreground: 'hsl(220 20% 92%)',
        card: 'hsl(240 12% 7%)',
        muted: 'hsl(240 10% 55%)',
        border: 'hsl(240 15% 14%)',
        accent: 'hsl(270 80% 65%)',
        'accent-cyan': 'hsl(185 90% 60%)',
        'accent-pink': 'hsl(320 85% 65%)',
        'neon-purple': 'hsl(270 90% 70%)',
        'neon-blue': 'hsl(220 90% 65%)',
        surface: 'hsl(240 12% 8%)',
        'surface-2': 'hsl(240 12% 11%)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'monospace'],
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-glow': 'radial-gradient(ellipse at top, hsl(270 80% 20% / 0.3) 0%, transparent 70%)',
        'grid-pattern': 'linear-gradient(hsl(240 15% 14% / 0.4) 1px, transparent 1px), linear-gradient(90deg, hsl(240 15% 14% / 0.4) 1px, transparent 1px)',
      },
      backgroundSize: {
        'grid': '40px 40px',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 8px hsl(270 80% 65% / 0.5)' },
          '50%': { opacity: '0.8', boxShadow: '0 0 24px hsl(270 80% 65% / 0.9), 0 0 48px hsl(270 80% 65% / 0.4)' },
        },
        'slide-in-left': {
          from: { transform: 'translateX(-100%)', opacity: '0' },
          to: { transform: 'translateX(0)', opacity: '1' },
        },
        'fade-in-up': {
          from: { transform: 'translateY(8px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'dot-blink': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
      },
      animation: {
        'pulse-glow': 'pulse-glow 2.5s ease-in-out infinite',
        'slide-in-left': 'slide-in-left 0.3s ease-out',
        'fade-in-up': 'fade-in-up 0.35s ease-out',
        'shimmer': 'shimmer 2s linear infinite',
        'dot-blink': 'dot-blink 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [typography],
} satisfies Config
