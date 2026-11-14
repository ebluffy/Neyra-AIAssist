import type { NextConfig } from 'next';
const config: NextConfig = { transpilePackages: ['@neyra/ui', '@neyra/contracts'], experimental: { cpus: 2 }, output: 'standalone' };
export default config;
