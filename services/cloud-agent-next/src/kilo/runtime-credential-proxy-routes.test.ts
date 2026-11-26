import { describe, expect, it } from 'vitest';
import {
  classifyRuntimeCredentialProxyPath,
  inferRuntimeCredentialProxyRoute,
  resolveRuntimeCredentialProxyRoute,
  type RuntimeCredentialProxyRoute,
} from './runtime-credential-proxy-routes.js';

const targets = {
  backendBaseUrl: 'https://backend.example.test',
  providerBaseUrl: 'https://provider.example.test/api/openrouter',
  sessionIngestBaseUrl: 'https://ingest.example.test',
};
const organizationId = 'org-session';

// kilo 7.8.17 (provider/models.ts, api/profile.ts, api/modes.ts) and
// kilo2 0.0.0-v2-25 (gateway-core/server.ts, defaults.ts, modes.ts).
const organizationReads = [
  [
    `/api/organizations/${organizationId}/models`,
    `${targets.backendBaseUrl}/api/organizations/${organizationId}/models`,
  ],
  [
    `/api/organizations/${organizationId}/defaults`,
    `${targets.backendBaseUrl}/api/organizations/${organizationId}/defaults`,
  ],
  [
    `/api/organizations/${organizationId}/modes`,
    `${targets.backendBaseUrl}/api/organizations/${organizationId}/modes`,
  ],
  [
    `/api/openrouter/organizations/${organizationId}/models`,
    `${targets.providerBaseUrl}/organizations/${organizationId}/models`,
  ],
  [
    `/api/gateway/organizations/${organizationId}/models`,
    `${targets.providerBaseUrl}/organizations/${organizationId}/models`,
  ],
  // v1 appends an API org base to the configured facade provider base.
  [
    `/api/openrouter/api/organizations/${organizationId}/models`,
    `${targets.providerBaseUrl}/organizations/${organizationId}/models`,
  ],
] as const;

describe('runtime organization facade routes', () => {
  it.each(organizationReads)(
    'maps the runtime GET %s to its canonical upstream',
    (pathname, expected) => {
      const route = inferRuntimeCredentialProxyRoute(pathname);
      expect(route).not.toBeNull();
      if (route === null) throw new Error('Missing facade route');
      expect(classifyRuntimeCredentialProxyPath(route, pathname)?.audience).toBe('kilo-api');
      const input = {
        targets,
        route,
        method: 'GET',
        pathname,
        search: '?version=test',
        kiloSessionId: 'ses_root',
        organizationId,
      };

      expect(resolveRuntimeCredentialProxyRoute(input)?.toString()).toBe(
        `${expected}?version=test`
      );
      expect(
        resolveRuntimeCredentialProxyRoute({ ...input, organizationId: 'org-other' })
      ).toBeNull();
      expect(
        resolveRuntimeCredentialProxyRoute({ ...input, organizationId: undefined })
      ).toBeNull();
      expect(resolveRuntimeCredentialProxyRoute({ ...input, method: 'POST' })).toBeNull();
      expect(
        resolveRuntimeCredentialProxyRoute({ ...input, pathname: `${pathname}/extra` })
      ).toBeNull();
    }
  );

  it.each([
    [
      'https://api.kilo.ai',
      `https://api.kilo.ai/api/gateway/organizations/${organizationId}/models`,
    ],
    [
      'http://localhost:3000/api',
      `http://localhost:3000/api/openrouter/organizations/${organizationId}/models`,
    ],
  ])('maps the v1 catalog alias with provider target %s', (providerBaseUrl, expected) => {
    expect(
      resolveRuntimeCredentialProxyRoute({
        targets: { ...targets, providerBaseUrl },
        route: 'provider',
        method: 'GET',
        pathname: `/api/openrouter/api/organizations/${organizationId}/models`,
        search: '',
        kiloSessionId: 'ses_root',
        organizationId,
      })?.toString()
    ).toBe(expected);
  });

  it.each([
    `/api/openrouter/api/organizations/${organizationId}/defaults`,
    `/api/openrouter/api/organizations/${organizationId}/modes`,
    `/api/openrouter/api/organizations/${organizationId}/models/validate`,
    `/api/openrouter/api/organizations/${organizationId}%2fother/models`,
    `/api/openrouter/api/organizations/${organizationId}%252fother/models`,
    `/api/openrouter/api/organizations/${organizationId}/../models`,
    `/api/openrouter/api/organizations/${organizationId}//models`,
  ])('does not broaden the provider alias to %s', pathname => {
    expect(
      resolveRuntimeCredentialProxyRoute({
        targets,
        route: 'provider',
        method: 'GET',
        pathname,
        search: '',
        kiloSessionId: 'ses_root',
        organizationId,
      })
    ).toBeNull();
  });
});

describe('runtime facade path classification', () => {
  const resolve = (route: RuntimeCredentialProxyRoute, pathname: string) =>
    resolveRuntimeCredentialProxyRoute({
      targets,
      route,
      method: 'GET',
      pathname,
      search: '',
      kiloSessionId: 'ses_root',
      organizationId,
    })?.toString();

  // Each encoded form decodes to an allowed catalog route. The audience and the
  // upstream must both come from that decoded route.
  it.each([
    [
      '/api/openrouter/organizations/org%2Dsession/models',
      `/api/openrouter/organizations/${organizationId}/models`,
    ],
    [
      `/api/gateway/organizations/${organizationId}/mod%65ls`,
      `/api/gateway/organizations/${organizationId}/models`,
    ],
    [
      `/api/gateway/%61pi/organizations/${organizationId}/models`,
      `/api/gateway/api/organizations/${organizationId}/models`,
    ],
    [
      `/api/%6Fpenrouter/api/organizations/${organizationId}/models`,
      `/api/openrouter/api/organizations/${organizationId}/models`,
    ],
  ])('selects the catalog audience for the decoded form of %s', (encoded, canonical) => {
    const classified = classifyRuntimeCredentialProxyPath('provider', encoded);
    expect(classified).toEqual({ path: canonical, audience: 'kilo-api' });
    expect(classifyRuntimeCredentialProxyPath('provider', canonical)).toEqual(classified);
    if (classified === null) throw new Error('Missing classification');
    // The resolvers check the decoded path again; that check returns it unchanged.
    expect(classifyRuntimeCredentialProxyPath('provider', classified.path)).toEqual(classified);
    expect(resolve('provider', classified.path)).toBe(
      `${targets.providerBaseUrl}/organizations/${organizationId}/models`
    );
    expect(resolve('provider', encoded)).toBe(resolve('provider', canonical));
  });

  it.each([
    'api/openrouter/models',
    `/api/openrouter/organizations/${organizationId}%2fother/models`,
    `/api/openrouter/organizations/${organizationId}%2Fother/models`,
    `/api/openrouter/organizations/${organizationId}%5cother/models`,
    `/api/openrouter/organizations/${organizationId}\\other/models`,
    `/api/openrouter/organizations/${organizationId}%252fother/models`,
    '/api/openrouter/organizations/org%252Dsession/models',
    `/api/openrouter/organizations/${organizationId}/%2e%2e/models`,
    `/api/openrouter/organizations/${organizationId}/../models`,
    `/api/openrouter/organizations/${organizationId}//models`,
    `/api/openrouter/organizations/${organizationId}/mod%E0%A4%A`,
  ])('refuses the invalid pathname %s', pathname => {
    expect(classifyRuntimeCredentialProxyPath('provider', pathname)).toBeNull();
    expect(resolve('provider', pathname)).toBeUndefined();
  });

  it.each([
    ['provider', '/api/openrouter/models', 'kilo-gateway'],
    ['provider', '/api/openrouter/chat/completions', 'kilo-gateway'],
    ['provider', '/api/gateway/v1/chat/completions', 'kilo-gateway'],
    ['provider', '/api/gateway/v1/responses', 'kilo-gateway'],
    ['backend', '/api/profile', 'kilo-api'],
    ['backend', `/api/organizations/${organizationId}/models`, 'kilo-api'],
    ['exa', '/api/exa/search', 'kilo-gateway'],
    ['ingest', '/api/session', 'session-ingest'],
    ['ingest', '/api/session/ses_root/ingest', 'session-ingest'],
  ] as const)('keeps the %s route %s on %s', (route, pathname, audience) => {
    expect(classifyRuntimeCredentialProxyPath(route, pathname)).toEqual({
      path: pathname,
      audience,
    });
  });
});
