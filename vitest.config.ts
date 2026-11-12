import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/*/src/**/*.test.{ts,tsx}', 'web/src/**/*.test.{ts,tsx}'] } });
