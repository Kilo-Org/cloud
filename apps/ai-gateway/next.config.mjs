import { withSentryConfig } from '@sentry/nextjs/config';
import { resolve } from 'path';

const monorepoRoot = resolve(import.meta.dirname, '../..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,

  // Inlined at build time, so no request or runtime variable can change them:
  // - the gateway authenticates by bearer token only and never reads the NextAuth
  //   session cookie (packages/web-shared/src/lib/user/server.ts);
  // - it names the STS `ai-gateway` workload of its Vercel identity. STS grants the web
  //   internal sender scopes to that workload only, and that grant is the real check; the
  //   inline only spares other builds a mint STS would refuse
  //   (packages/web-shared/src/lib/web-internal-sts.ts).
  env: {
    KILO_BROWSER_SESSIONS: 'disabled',
    KILO_STS_WORKLOAD: 'ai-gateway',
  },

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

  // The apps/web security headers that matter for API-only JSON and SSE
  // responses. The others (X-Frame-Options, COOP, COEP, CORP,
  // Permissions-Policy, X-XSS-Protection) govern how browsers render, frame,
  // or embed documents and subresources, which this app does not serve.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

/** @type {import('@sentry/nextjs/config').SentryBuildOptions} */
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
