// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
// But note tricky corner cases using vercel otel with sentry:
// https://docs.sentry.io/platforms/javascript/guides/nextjs/opentelemetry/custom-setup/

import { consoleLoggingIntegration, init } from '@sentry/nextjs';

if (process.env.NODE_ENV !== 'development') {
  init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

    // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
    tracesSampleRate: 0.05,

    // Setting this option to true will print useful information to the console while you're setting up Sentry.
    debug: false,
    normalizeDepth: 5,

    integrations: [
      // send console.log, console.error, and console.warn calls as logs to Sentry
      consoleLoggingIntegration({ levels: ['log', 'error', 'warn'] }),
    ],
  });
}
