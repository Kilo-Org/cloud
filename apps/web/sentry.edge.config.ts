// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
// But note tricky corner cases using vercel otel with sentry:
// https://docs.sentry.io/platforms/javascript/guides/nextjs/opentelemetry/custom-setup/

import { consoleLoggingIntegration, init } from '@sentry/nextjs';
import { RESTRICTED_DATA_COLLECTION } from '@kilocode/web-shared/lib/observability/sentry-data-collection';
import { sanitizeSentryRequestData } from '@kilocode/web-shared/lib/observability/sentry-request-data';

if (process.env.NODE_ENV !== 'development') {
  init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

    // Tracing is fully disabled.
    tracesSampleRate: 0,

    // Setting this option to true will print useful information to the console while you're setting up Sentry.
    debug: false,
    normalizeDepth: 5,

    dataCollection: RESTRICTED_DATA_COLLECTION,

    integrations: [
      // send console.log, console.error, and console.warn calls as logs to Sentry
      consoleLoggingIntegration({ levels: ['log', 'error', 'warn'] }),
    ],

    // Apply the same request-data strip the server initializer runs, so an event
    // from an edge runtime entry leaves this process with the same request
    // metadata as a server event.
    beforeSend(event) {
      sanitizeSentryRequestData(event);
      return event;
    },
  });
}
