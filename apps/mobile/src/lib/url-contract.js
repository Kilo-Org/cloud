/** URL scheme and production-host contract for mobile config values.
 *  Plain .js because the Expo config loader cannot consume workspace TS
 *  (same reason env-keys.js and sentry-dsn.js exist). Metro and vitest
 *  import .js fine, so the same file serves the config boundary
 *  (app.config.ts), the runtime boundary (config.ts), and the unit tests. */

/** Config key → allowed URL schemes. URL keys only — appsFlyerDevKey,
 *  appsFlyerAppId, and posthogApiKey are not URLs and get no scheme check. */
export const URL_SCHEMES = {
  apiBaseUrl: ['https:'],
  webBaseUrl: ['https:'],
  kiloChatUrl: ['https:'],
  notificationsUrl: ['https:'],
  cloudAgentWsUrl: ['wss:'],
  sessionIngestWsUrl: ['wss:'],
  // The event-service client accepts both https: and wss:
  // (packages/event-service/src/client.ts:38-49).
  eventServiceUrl: ['https:', 'wss:'],
};

/** Production host allowlist, seeded from the repo-documented production hosts
 *  api.kilo.ai and app.kilo.ai (ENVIRONMENT.md:399-400). If EXPO_TOKEN is
 *  available when this file is authored, complete the list from the EAS
 *  production environment
 *  (`pnpx eas-cli@21.8.0 env:list --environment production --format long`)
 *  by extracting the host of each URL value. Otherwise preflight is the
 *  completeness safety net: the release preflight runs assertProductionHost
 *  against the real production values, so an incomplete allowlist fails
 *  preflight before any build, never at runtime in a store build.
 *  cloud-agent-next.kilosessions.ai and ingest.kilosessions.ai come from the
 *  repo-documented extension defaults
 *  (apps/extension/src/shared/cloud-agent-config.ts:10-11). */
export const PRODUCTION_HOSTS = [
  'api.kilo.ai',
  'app.kilo.ai',
  'cloud-agent-next.kilosessions.ai',
  'ingest.kilosessions.ai',
];

/** Parse a URL value, throwing a clear error for a missing or malformed URL.
 *  @param {string} name
 *  @param {string | undefined} value
 *  @returns {URL}
 */
function parseUrl(name, value) {
  if (!value) {
    throw new Error(`Missing URL for ${name}`);
  }
  try {
    return new URL(value);
  } catch {
    throw new Error(`Invalid URL for ${name}: ${value}`);
  }
}

/** Throws unless the URL scheme is in `schemes`. `allowInsecure` additionally
 *  permits http: and ws: for local development.
 *  @param {string} name
 *  @param {string | undefined} value
 *  @param {string[]} schemes
 *  @param {{ allowInsecure?: boolean }} [options]
 */
// oxlint-disable-next-line max-params -- the options object carries the allowInsecure flag per the URL contract
export function assertUrlScheme(name, value, schemes, { allowInsecure = false } = {}) {
  const parsed = parseUrl(name, value);
  const allowed = allowInsecure ? [...schemes, 'http:', 'ws:'] : schemes;
  if (!allowed.includes(parsed.protocol)) {
    throw new Error(
      `Invalid scheme for ${name}: expected ${schemes.join(' or ')}, got ${parsed.protocol}`
    );
  }
}

/** Throws when the URL host is outside the allowlist.
 *  @param {string} name
 *  @param {string | undefined} url
 *  @param {string[]} allowedHosts
 */
export function assertProductionHost(name, url, allowedHosts) {
  const parsed = parseUrl(name, url);
  if (!allowedHosts.includes(parsed.hostname)) {
    throw new Error(
      `Production host for ${name} (${parsed.hostname}) is outside the allowlist: ${allowedHosts.join(', ')}`
    );
  }
}
