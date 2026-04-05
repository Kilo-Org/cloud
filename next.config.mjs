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
        // PostHog reverse proxy rewrites — specific routes MUST come before the catch-all
        {
          source: '/ingest/static/:path*',
          destination: 'https://us-assets.i.posthog.com/static/:path*',
        },
        {
          source: '/ingest/decide',
          destination: 'https://us.i.posthog.com/decide',
        },
        // Catch-all must be last — otherwise it swallows /decide and /static
        {
          source: '/ingest/:path*',
          destination: 'https://us.i.posthog.com/:path*',
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
        destination: 'https://raw.githubusercontent.com/Kilo-Org/kilo/refs/heads/dev/install',
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

  // discord.js uses optional native modules (zlib-sync, bufferutil, utf-8-validate)
  // that cannot be bundled by webpack. Mark them as external so Node.js resolves them at runtime.
  serverExternalPackages: [
    'discord.js',
    '@discordjs/ws',
    'zlib-sync',
    'bufferutil',
    'utf-8-validate',
  ],

  // This is required to support PostHog trailing slash API requests
  skipTrailingSlashRedirect: true,
  // Maximize chance of decent client-side stack traces
  productionBrowserSourceMaps: true,
  // Configure `pageExtensions` to include markdown and MDX files
  pageExtensions: ['js', 'jsx', 'md', 'mdx', 'ts', 'tsx'],

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
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/build/

  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Tree-shake Sentry debug statements to reduce bundle size
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
  },

  telemetry: false,
};

export default withBundleAnalyzer(
  process.env.NODE_ENV === 'development'
    ? withMDX(nextConfig)
    : withSentryConfig(withMDX(nextConfig), sentryConfig)
);
