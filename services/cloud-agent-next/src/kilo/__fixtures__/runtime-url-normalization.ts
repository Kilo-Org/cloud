/**
 * Immutable compatibility fixtures copied from Kilo CLI `route()` behavior.
 * Sources: Kilo v7.4.20 release artifact and current CLI main (2026-09-04).
 *
 * Both versions normalize a configured base then append absolute API paths.
 * Provider-specific `/api/gateway/v1/...` compatibility aliases are tested by
 * the Cloud facade resolver, not asserted as behavior of `route()` itself.
 * Keep this independent of the mutable CLI checkout: older installed CLIs are
 * part of the Cloud Agent compatibility contract.
 */
export const historicalRouteFixtures = [
  { version: '7.4.20', path: '/api/profile' },
  { version: '7.4.20', path: '/api/defaults' },
  { version: '7.4.20', path: '/api/openrouter/models' },
  { version: '7.4.20', path: '/api/session' },
  { version: 'current', path: '/api/profile' },
  { version: 'current', path: '/api/defaults' },
  { version: 'current', path: '/api/openrouter/models' },
  { version: 'current', path: '/api/session' },
] as const;

/** Exact relevant `route()` normalization contract from both sources. */
export function historicalCliRoute(base: string, path: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  return url.toString();
}
