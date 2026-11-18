import { resolve } from 'path';

const monorepoRoot = resolve(import.meta.dirname, '../..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // Both values MUST be set to the monorepo root and kept in sync; see apps/web/next.config.mjs.
  outputFileTracingRoot: monorepoRoot,
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
