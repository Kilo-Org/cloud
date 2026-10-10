/**
 * Bootstrap wiring for the telemetry pipeline: installs the Sentry adapter as
 * the active sink and wraps the global fetch so every failed http(s) request
 * reports once at warning level.
 *
 * Imported only by the root layout — never by a node test — because
 * `@sentry/react-native` does not parse under vitest/rolldown. The tRPC links
 * carry their own reporting (see lib/trpc.ts), so this wrapper skips
 * `/api/trpc` URLs to avoid double-reporting. It also skips the app's own
 * telemetry transports — the SDK vendors and the latency sink — because their
 * failures are never user-facing (see `isTelemetryHost`).
 */

import * as Sentry from '@sentry/react-native';

import { LATENCY_INGEST_URL } from '@/lib/config';
import { setTelemetrySink } from '@/lib/telemetry/error-sink';
import { createNetworkErrorFetch } from '@/lib/telemetry/network-errors';
import { LATENCY_INGEST_URL_DEFAULT } from '@/lib/url-contract';

const HTTP_URL_PATTERN = /^https?:\/\//iu;
const TRPC_PATH = '/api/trpc';

// Telemetry transports. The SDK must never observe itself: a failed Sentry
// upload reported back to Sentry (or a PostHog flush) is an infinite loop.
const TELEMETRY_HOST_TOKENS = ['posthog', 'sentry', 'appsflyer', 'expo'];

/** The `host[:port]` authority of a URL, or undefined when it has none. */
function authorityOf(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Authorities of the app's own latency sink. `postLatencyBatch` is
 * fire-and-forget and swallows every outcome (latency-ingest.ts), so a gateway
 * 5xx from this host never reaches the user — reporting it files an issue
 * (KILO-APP-293) for a request nobody waited on. Both the resolved endpoint (an
 * `LATENCY_INGEST_URL` override) and the committed production default are
 * excluded, so an override is covered without losing the default. The
 * authority carries the port, so a `localhost:8816` dev override does not
 * silence the API on the same host at another port.
 */
function telemetryAuthorities(): ReadonlySet<string> {
  const authorities = new Set<string>();
  for (const url of [LATENCY_INGEST_URL, LATENCY_INGEST_URL_DEFAULT]) {
    const authority = authorityOf(url);
    if (authority !== undefined) {
      authorities.add(authority);
    }
  }
  return authorities;
}

const TELEMETRY_AUTHORITIES = telemetryAuthorities();

// Fast Refresh re-evaluates this module, which would reset a module-local
// guard and wrap an already-wrapped `globalThis.fetch`, stacking wrappers and
// duplicating reports. Anchor the guard on `globalThis` instead: Fast Refresh
// keeps the runtime's globals, so a fresh module instance still sees the
// install. (Same pattern as session-attention.ts.)
const INSTALLED_KEY = '__kiloErrorReportingInstalled__';
const globalScope = globalThis as typeof globalThis & { [INSTALLED_KEY]?: boolean };

function isTelemetryHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (TELEMETRY_HOST_TOKENS.some(token => hostname.includes(token))) {
      return true;
    }
    return TELEMETRY_AUTHORITIES.has(parsed.host.toLowerCase());
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
 * Install the Sentry telemetry sink and the global fetch wrapper. Idempotent
 * across Fast Refresh: the guard lives on `globalThis`, so re-evaluating this
 * module does not re-wrap an already-wrapped fetch.
 */
export function installErrorReporting(): void {
  if (globalScope[INSTALLED_KEY] === true) {
    return;
  }
  globalScope[INSTALLED_KEY] = true;
  installSentrySink();
  installFetchWrapper();
}
