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

/** Production host allowlist, seeded from the committed apps/mobile/.env
 *  production defaults. The .env URL values include api.kilo.ai, app.kilo.ai,
 *  cloud-agent-next.kilosessions.ai, ingest.kilosessions.ai, chat.kiloapps.io,
 *  events.kiloapps.io, and notifications.kiloapps.io. url-contract.test.ts
 *  asserts every committed .env URL value against this list, so a missing
 *  host fails the test before any build. Preflight is the runtime safety net:
 *  the release preflight runs assertProductionHost against the real production
 *  values, so an incomplete allowlist fails preflight before any build, never
 *  at runtime in a store build. */
export const PRODUCTION_HOSTS = [
  'api.kilo.ai',
  'app.kilo.ai',
  'chat.kiloapps.io',
  'cloud-agent-next.kilosessions.ai',
  'events.kiloapps.io',
  'ingest.kilosessions.ai',
  'notifications.kiloapps.io',
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
