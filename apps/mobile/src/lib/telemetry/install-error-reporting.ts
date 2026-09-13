/**
 * Bootstrap wiring for the telemetry pipeline: installs the Sentry adapter as
 * the active sink and wraps the global fetch so every failed http(s) request
 * reports once at warning level.
 *
 * Imported only by the root layout — never by a node test — because
 * `@sentry/react-native` does not parse under vitest/rolldown. The tRPC links
 * carry their own reporting (see lib/trpc.ts), so this wrapper skips
 * `/api/trpc` URLs to avoid double-reporting.
 */

import * as Sentry from '@sentry/react-native';

import { setTelemetrySink } from '@/lib/telemetry/error-sink';
import { createNetworkErrorFetch } from '@/lib/telemetry/network-errors';

const HTTP_URL_PATTERN = /^https?:\/\//iu;
const TRPC_PATH = '/api/trpc';

// Telemetry transports. The SDK must never observe itself: a failed Sentry
// upload reported back to Sentry (or a PostHog flush) is an infinite loop.
const TELEMETRY_HOST_TOKENS = ['posthog', 'sentry', 'appsflyer', 'expo'];

let installed = false;

function isTelemetryHost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return TELEMETRY_HOST_TOKENS.some(token => hostname.includes(token));
  } catch {
    return false;
  }
}

/** True for app http(s) requests this wrapper owns (not tRPC, not telemetry). */
function isReportableAppUrl(url: string): boolean {
  if (!HTTP_URL_PATTERN.test(url)) {
    return false;
  }
  if (url.includes(TRPC_PATH)) {
    return false;
  }
  return !isTelemetryHost(url);
}

function installSentrySink(): void {
  setTelemetrySink(event => {
    const options = {
      level: event.level,
      tags: event.tags,
      contexts: event.contexts,
      extra: event.extra,
      // Sentry's CaptureContext wants a mutable `string[]`; TelemetryEvent's
      // fingerprint is readonly, so copy it.
      fingerprint: event.fingerprint === undefined ? undefined : [...event.fingerprint],
    };
    // The sink type returns void; call into Sentry without returning its id
    // (typescript-eslint/strict-void-return).
    if (event.error !== undefined) {
      Sentry.captureException(event.error, options);
    } else {
      Sentry.captureMessage(event.message ?? 'Telemetry event', options);
    }
  });
}

function installFetchWrapper(): void {
  const wrapped = createNetworkErrorFetch(globalThis.fetch, {
    source: 'fetch',
    shouldReport: isReportableAppUrl,
  });
  try {
    globalThis.fetch = wrapped;
  } catch {
    // A non-writable global fetch: define an own property instead.
    try {
      Object.defineProperty(globalThis, 'fetch', {
        value: wrapped,
        configurable: true,
        writable: true,
      });
    } catch {
      // Still non-writable: leave the global unwrapped. tRPC reporting stands.
    }
  }
}

/**
 * Install the Sentry telemetry sink and the global fetch wrapper. Idempotent:
 * Fast Refresh may call this repeatedly.
 */
export function installErrorReporting(): void {
  if (installed) {
    return;
  }
  installed = true;
  installSentrySink();
  installFetchWrapper();
}
