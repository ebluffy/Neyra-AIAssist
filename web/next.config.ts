import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@neyra/ui', '@neyra/contracts'],
  serverExternalPackages: ['ws', 'bufferutil', 'utf-8-validate'],
  env: {
    WS_NO_BUFFER_UTIL: '1',
    WS_NO_UTF_8_VALIDATE: '1',
  },
  devIndicators: false,
  experimental: { cpus: 2 },
  output: 'standalone',
};

export default config;
