import { withSentryConfig } from '@sentry/nextjs';
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

  // Same as apps/web, so gateway clients see identical trailing-slash handling.
  skipTrailingSlashRedirect: true,
};

/** @type {import('@sentry/nextjs').SentryBuildOptions} */
const sentryConfig = {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
  },
  telemetry: false,
};

export default process.env.NODE_ENV === 'development'
  ? nextConfig
  : withSentryConfig(nextConfig, sentryConfig);
