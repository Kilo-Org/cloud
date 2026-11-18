import { registerOTel } from '@vercel/otel';
import { initServerSentry } from '@kilocode/web-shared/lib/observability/sentry-server';

// Import this module only when NEXT_RUNTIME is 'nodejs'.
//
// The server runtime runs Vercel's OpenTelemetry SDK and Sentry side by side. Since
// Sentry SDK 11 the two pipelines are independent: Sentry no longer registers a tracer
// provider and no longer accepts Sentry span processor components, so a span created
// through `@opentelemetry/api` is never turned into a Sentry span. Sentry tracing is off
// here (see `initServerSentry`), so this module only wires the OTel provider.
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
// We intentionally only register OTel in the Node runtime.
// Edge events rely on Sentry's Edge SDK behavior configured in apps/web/sentry.edge.config.ts.
// ref: https://docs.sentry.io/platforms/javascript/guides/nextjs/opentelemetry/custom-setup/
export function registerNodeInstrumentation(serviceName: string): void {
  initServerSentry();

  // Sentry traces are off, and the OTel spans used to be sampled by Sentry's sampler with
  // the same zero rate. Keep that rate explicit so this pipeline never starts recording
  // and exporting spans just because Sentry no longer supplies a sampler.
  registerOTel({ serviceName, traceSampler: 'always_off' });
}
