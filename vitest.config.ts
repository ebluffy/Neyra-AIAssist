import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { setupFiles: ['./vitest.setup.ts'], include: ['packages/*/src/**/*.test.{ts,tsx}', 'web/src/**/*.test.{ts,tsx}', 'web/lib/**/*.test.ts', 'web/db/**/*.test.ts'] } });
