import { withSentryConfig } from '@sentry/nextjs';
import createMDX from '@next/mdx';
import { statSync } from 'fs';
import NextBundleAnalyzer from '@next/bundle-analyzer';

const withBundleAnalyzer = NextBundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

function validateGitLfs() {
  const anLfsPath = 'public/kilo-anim.mp4';
  const stats = statSync(anLfsPath, { throwIfNoEntry: false });

  if (!stats || stats.size < 1024)
    throw new Error(`${anLfsPath} was not found in LFS (size: ${stats?.size ?? '-'} bytes).`);

  console.log(`✓ LFS file ${anLfsPath} is properly resolved (size: ${stats.size} bytes)`);
}

validateGitLfs();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  devIndicators: { position: 'bottom-right' },

  async rewrites() {
    // Global API rewrites - proxy to global-api.kilo.ai when not on global backend
    // Uses beforeFiles to ensure the rewrite happens BEFORE filesystem routes are checked
    // See: https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites
    const globalApiRewrites =
      process.env.GLOBAL_KILO_BACKEND !== 'true'
        ? [
            {
              source: '/api/fim/completions',
              destination: 'https://global-api.kilo.ai/api/fim/completions',
            },
            {
              source: '/api/marketplace/:path*',
              destination: 'https://global-api.kilo.ai/api/marketplace/:path*',
            },
          ]
        : [];

    return {
      beforeFiles: globalApiRewrites,
      afterFiles: [
        {
          source: '/config.json',
          destination: 'https://opencode.ai/config.json',
        },
        {
          source: '/ingest/static/:path*',
          destination: 'https://us-assets.i.posthog.com/static/:path*',
        },
        {
          source: '/ingest/:path*',
          destination: 'https://us.i.posthog.com/:path*',
        },
        {
          source: '/ingest/decide',
          destination: 'https://us.i.posthog.com/decide',
        },
        {
          source: '/.well-known/appspecific/com.chrome.devtools.json',
          destination: '/api/chrome-devtools',
        },
      ],
      fallback: [],
    };
  },

  redirects: async () => {
    return [
      {
        source: '/cli/install',
        destination:
          'https://raw.githubusercontent.com/Kilo-Org/kilo/refs/heads/dev/install',
        permanent: false,
      },
      {
        source: '/users/sign_up',
        destination: '/get-started',
        permanent: true,
      },
      {
        source: '/welcome/landing',
        destination: '/get-started',
        permanent: true,
      },
    ];
  },

  // Security headers
  async headers() {
    return [
      {
        // Apply to all routes
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
        ],
      },
    ];
  },

  // This is required to support PostHog trailing slash API requests
  skipTrailingSlashRedirect: true,
  // Maximize chance of decent client-side stack traces
  productionBrowserSourceMaps: true,
  // Configure `pageExtensions` to include markdown and MDX files
  pageExtensions: ['js', 'jsx', 'md', 'mdx', 'ts', 'tsx'],

  // Disable built-in ESLint integration
  eslint: {
    ignoreDuringBuilds: true,
  },

  // Configure webpack to suppress warnings
  webpack: config => {
    // Suppress webpack warnings for MDX loader
    config.infrastructureLogging = {
      level: 'error', // Only show errors, not warnings
    };

    // Surpress Sentry warnings on opentelemetry on build
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      /Critical dependency: the request of a dependency is an expression/,
    ];

    return config;
  },

  images: {
    dangerouslyAllowSVG: true,
    contentDispositionType: 'attachment',
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
        port: '',
        pathname: '/*/**',
      },
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
        port: '',
        pathname: '/*/**',
      },
    ],
  },
};

const withMDX = createMDX({
  // Add markdown plugins here, as desired
  options: {
    remarkPlugins: [],
    rehypePlugins: [],
  },
});

const sentryConfig = {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // Auth token for Sentry, required for uploading source maps
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  // tunnelRoute: '/monitoring',

  // Automatically tree-shake Sentry logger statements to reduce bundle size
  disableLogger: true,

  telemetry: false,

  // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
  // See the following for more information:
  // https://docs.sentry.io/product/crons/
  // https://vercel.com/docs/cron-jobs
  automaticVercelMonitors: true,

  // Enable React component stack traces in Sentry
  reactComponentAnnotation: {
    enabled: true,
  },
};

export default withBundleAnalyzer(
  process.env.NODE_ENV === 'development'
    ? withMDX(nextConfig)
    : withSentryConfig(withMDX(nextConfig), sentryConfig)
);
