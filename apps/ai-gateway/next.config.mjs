import { resolve } from 'path';

const monorepoRoot = resolve(import.meta.dirname, '../..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,

  // Both values MUST be set to the monorepo root and kept in sync; see
  // apps/web/next.config.mjs. The routes are served from packages/web-shared.
  outputFileTracingRoot: monorepoRoot,
  turbopack: {
    root: monorepoRoot,
  },

  // packages/web-shared/src/lib/email.ts reads these at runtime.
  outputFileTracingIncludes: {
    '/**': ['../../packages/web-shared/src/emails/*.html'],
  },

  // Same as apps/web, so gateway clients see identical trailing-slash handling.
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
