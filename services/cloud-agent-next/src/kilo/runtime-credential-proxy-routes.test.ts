import { describe, expect, it } from 'vitest';
import {
  inferRuntimeCredentialProxyRoute,
  resolveRuntimeCredentialProxyRoute,
  runtimeProxyAttestationAudience,
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
      expect(runtimeProxyAttestationAudience(route, pathname)).toBe('kilo-api');
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
