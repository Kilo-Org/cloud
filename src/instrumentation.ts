import { captureRequestError } from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');

    const { getClient, SentryContextManager, validateOpenTelemetrySetup } =
      await import('@sentry/nextjs');
    const { SentryPropagator, SentrySampler, SentrySpanProcessor } =
      await import('@sentry/opentelemetry');

    const sentryClient = getClient();
    if (!sentryClient) {
      console.warn('Sentry client not found in instrumentation.ts');
    }

    // Use Vercel's OpenTelemetry SDK (Node runtime) but supply the Sentry-required components
    // (sampler/propagator/context manager/span processor) ourselves.
    //
    // Notes on runtime split:
    // - `@vercel/otel` ships distinct entrypoints for Edge vs Node via conditional exports
    //   (edge -> dist/edge, node -> dist/node):
    //   https://github.com/vercel/otel/blob/v2.1.0/package.json#L14-L42
    // - The Node build wires Node-specific instrumentations such as node:http / node:https
    //   and async context managers (async_hooks), which are not available in Edge runtime.
    //   See bundled code in dist/node/index.js (search for "async_hooks" and "node:http").
    // - While `@vercel/otel` technically supports Edge runtime via its dist/edge build,
    //   it provides only lightweight trace propagation, not full auto-instrumentation.
    //   See: https://www.npmjs.com/package/@vercel/otel (README describes Edge as "lightweight mode")
    //
    // We intentionally only enable the Sentry+OTel custom wiring in Node runtime for now.
    // Edge tracing should rely on Sentry's Edge SDK behavior configured in sentry.edge.config.ts.
    // ref: https://docs.sentry.io/platforms/javascript/guides/nextjs/opentelemetry/custom-setup/
    const { registerOTel } = await import('@vercel/otel');
    registerOTel({
      serviceName: 'kilocode-app',
      traceSampler: sentryClient ? new SentrySampler(sentryClient) : undefined,
      spanProcessors: ['auto', new SentrySpanProcessor()],
      propagators: ['auto', new SentryPropagator()],
      contextManager: new SentryContextManager(),
    });

    validateOpenTelemetrySetup();
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

export const onRequestError = captureRequestError;
