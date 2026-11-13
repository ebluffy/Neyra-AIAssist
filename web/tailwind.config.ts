import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}', '../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        'surface-3': 'var(--surface-3)',
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        text: 'var(--text)',
        'text-muted': 'var(--text-muted)',
        'text-subtle': 'var(--text-subtle)',
        accent: 'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        'accent-ink': 'var(--accent-ink)',
        'accent-quiet': 'var(--accent-quiet)',
        danger: 'var(--danger)',
        'danger-quiet': 'var(--danger-quiet)',
        success: 'var(--success)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      boxShadow: {
        panel: 'var(--shadow-panel)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg: 'var(--radius-lg)',
        full: 'var(--radius-full)',
      },
      transitionTimingFunction: {
        'ease-out': 'var(--ease-out)',
      },
      transitionDuration: {
        fast: 'var(--dur-fast)',
        DEFAULT: 'var(--dur)',
      },
    },
  },
  plugins: [],
};

export default config;
