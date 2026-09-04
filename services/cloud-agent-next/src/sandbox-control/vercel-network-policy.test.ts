import { describe, expect, it } from 'vitest';
import type {
  VercelSandboxInjectionRule,
  VercelSandboxNetworkPolicy,
} from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import {
  buildKiloCredentialInjectionRules,
  buildVercelCredentialNetworkPolicy,
  findMatchingCredentialInjectionRule,
  type VercelCredentialPolicyInput,
} from './vercel-network-policy.js';

const ROOT_SESSION_ID = 'ses_abcdefghijklmnopqrstuvwxyz';
const OTHER_SESSION_ID = 'ses_zyxwvutsrqponmlkjihgfedcba';

type PolicyRequestInput = {
  url: string;
  authorization?: string;
  method?: string;
  headers?: Record<string, string>;
};

function kiloInput(
  overrides: Partial<NonNullable<VercelCredentialPolicyInput['kilo']>> = {}
): NonNullable<VercelCredentialPolicyInput['kilo']> {
  return {
    token: 'actual-kilo-token',
    placeholder: 'placeholder-kilo-token',
    targets: {
      backendBaseUrl: 'https://backend.example.com/tenant',
      providerBaseUrl: 'https://provider.example.com/platform',
      sessionIngestBaseUrl: 'https://ingest.example.com/history',
    },
    rootSessionIds: [ROOT_SESSION_ID],
    ...overrides,
  };
}

function githubInput(
  overrides: Partial<NonNullable<VercelCredentialPolicyInput['github']>> = {}
): NonNullable<VercelCredentialPolicyInput['github']> {
  return {
    token: 'actual-github-token',
    placeholder: 'placeholder-github-token',
    repository: 'Kilo-Org/Cloud.Repo',
    ...overrides,
  };
}

function firstMatchingRule(
  policy: VercelSandboxNetworkPolicy,
  input: PolicyRequestInput
): VercelSandboxInjectionRule | undefined {
  const url = new URL(input.url);
  const headers = new Headers({ host: url.host, ...input.headers });
  if (input.authorization !== undefined) headers.set('authorization', input.authorization);
  const method = input.method ?? 'GET';

  return findMatchingCredentialInjectionRule(policy.injectionRules, { url, method, headers });
}

function effectiveAuthorization(
  policy: VercelSandboxNetworkPolicy,
  input: PolicyRequestInput
): string | undefined {
  return firstMatchingRule(policy, input)?.headers.authorization;
}

describe('buildVercelCredentialNetworkPolicy', () => {
  it('builds REST-native credential policies with deduplicated domains and unrestricted egress', () => {
    const policy = buildVercelCredentialNetworkPolicy({
      kilo: kiloInput({
        targets: {
          backendBaseUrl: 'https://shared.example.com/base',
          providerBaseUrl: 'https://shared.example.com/provider',
          sessionIngestBaseUrl: 'https://shared.example.com/ingest',
        },
      }),
      github: githubInput(),
    });

    expect(policy.mode).toBe('custom');
    expect(policy.allowedDomains).toEqual([
      'shared.example.com',
      'github.com',
      'api.github.com',
      '*',
    ]);
    expect(new Set(policy.allowedDomains).size).toBe(policy.allowedDomains.length);
    expect(policy.allowedDomains.every(domain => domain === '*' || !domain.includes('/'))).toBe(
      true
    );
    expect(policy.injectionRules.every(rule => rule.match.path !== undefined)).toBe(true);
  });

  it('retains wildcard egress without adding credential rules for empty input', () => {
    expect(buildVercelCredentialNetworkPolicy({})).toEqual({
      mode: 'custom',
      allowedDomains: ['*'],
      injectionRules: [],
    });
  });

  it('authenticates only packaged CLI provider paths through the runtime proxy', () => {
    const policy = buildVercelCredentialNetworkPolicy({
      kilo: kiloInput({
        runtimeProxy: {
          members: [
            {
              sessionId: 'workspace_a',
              kiloSessionId: ROOT_SESSION_ID,
              handle: 'runtime-proxy-handle',
            },
          ],
          targets: {
            backendBaseUrl: 'https://worker.example.com',
            providerBaseUrl: 'https://worker.example.com',
            sessionIngestBaseUrl: 'https://worker.example.com',
          },
        },
      }),
    });
    const authorization = 'Bearer runtime-proxy-handle';
    const base = 'https://worker.example.com/api/openrouter';

    for (const [path, method] of [
      ['/models', 'GET'],
      ['/models/validate', 'POST'],
      ['/chat/completions', 'POST'],
      ['/messages', 'POST'],
      ['/responses', 'POST'],
      ['/embeddings', 'POST'],
    ]) {
      expect(effectiveAuthorization(policy, { url: `${base}${path}`, authorization, method })).toBe(
        authorization
      );
    }
    for (const path of ['/v1/chat/completions', '/v1/responses']) {
      expect(
        effectiveAuthorization(policy, {
          url: `https://worker.example.com/api/gateway${path}`,
          authorization,
          method: 'POST',
        })
      ).toBe(authorization);
      expect(
        effectiveAuthorization(policy, {
          url: `${base}${path}`,
          authorization,
          method: 'POST',
        })
      ).toBeUndefined();
      expect(
        effectiveAuthorization(policy, {
          url: `https://worker.example.com/api/gateway${path}`,
          authorization,
          method: 'GET',
        })
      ).toBeUndefined();
    }

    for (const [path, method] of [
      ['/models', 'POST'],
      ['/chat/completions', 'GET'],
      ['/api/organizations/trusted-org/models', 'GET'],
      ['/unknown', 'POST'],
      ['/../chat/completions', 'POST'],
      ['/models', 'DELETE'],
    ]) {
      expect(
        effectiveAuthorization(policy, { url: `${base}${path}`, authorization, method })
      ).toBeUndefined();
    }
    expect(
      effectiveAuthorization(policy, {
        url: 'https://worker.example.com/chat/completions',
        authorization,
        method: 'POST',
      })
    ).toBeUndefined();
  });

  it('uses the owning member handle for every proxy route', () => {
    const policy = buildVercelCredentialNetworkPolicy({
      kilo: kiloInput({
        rootSessionIds: [ROOT_SESSION_ID, OTHER_SESSION_ID],
        runtimeProxy: {
          members: [
            { sessionId: 'workspace_a', kiloSessionId: ROOT_SESSION_ID, handle: 'member-a' },
            { sessionId: 'workspace_b', kiloSessionId: OTHER_SESSION_ID, handle: 'member-b' },
          ],
          targets: {
            backendBaseUrl: 'https://worker.example.com',
            providerBaseUrl: 'https://worker.example.com',
            sessionIngestBaseUrl: 'https://worker.example.com',
          },
        },
      }),
    });
    const authorization = 'Bearer member-a';
    expect(
      effectiveAuthorization(policy, {
        url: 'https://worker.example.com/api/openrouter/chat/completions',
        method: 'POST',
        authorization,
      })
    ).toBe('Bearer member-a');
    expect(
      effectiveAuthorization(policy, {
        url: `https://worker.example.com/api/session/${ROOT_SESSION_ID}/ingest`,
        method: 'POST',
        authorization,
      })
    ).toBe('Bearer member-a');
    expect(
      effectiveAuthorization(policy, {
        url: `https://worker.example.com/api/session/${OTHER_SESSION_ID}/title`,
        method: 'POST',
        authorization: 'Bearer member-b',
      })
    ).toBe('Bearer member-b');
    expect(
      effectiveAuthorization(policy, {
        url: 'https://worker.example.com/api/session/unrelated/ingest',
        method: 'POST',
        authorization,
      })
    ).toBeUndefined();
    // The policy can only key `/api/session` on the injected handle; the
    // facade validates its JSON body against that handle's root identity.
    expect(
      effectiveAuthorization(policy, {
        url: 'https://worker.example.com/api/session',
        method: 'POST',
        authorization: 'Bearer member-b',
      })
    ).toBe('Bearer member-b');
    expect(
      effectiveAuthorization(policy, {
        url: `https://worker.example.com/api/session/${ROOT_SESSION_ID}/export`,
        method: 'GET',
        authorization: 'Bearer member-b',
      })
    ).toBeUndefined();
  });

  it.each([
    ['trusted organization', 'trusted-org', 'trusted-org'],
    ['personal account', undefined, ''],
  ] as const)(
    'overrides a guest-supplied organization context for a %s',
    (_description, organizationId, expectedOrganizationId) => {
      const policy = buildVercelCredentialNetworkPolicy({
        kilo: kiloInput(organizationId === undefined ? {} : { organizationId }),
        github: githubInput(),
      });
      const guestOrganization = 'guest-selected-organization';
      const incoming = { 'x-kilocode-organizationid': guestOrganization };

      for (const url of [
        'https://backend.example.com/tenant/api/user',
        'https://provider.example.com/platform/api/openrouter/models',
        `https://ingest.example.com/history/api/session/${ROOT_SESSION_ID}/export`,
      ]) {
        const rule = firstMatchingRule(policy, {
          url,
          authorization: 'Bearer placeholder-kilo-token',
          headers: incoming,
        });
        expect(rule?.headers['x-kilocode-organizationid']).toBe(expectedOrganizationId);
        const forwarded = new Headers({ ...incoming, ...rule?.headers });
        expect(forwarded.get('x-kilocode-organizationid') || undefined).toBe(
          expectedOrganizationId || undefined
        );
      }

      const githubRule = firstMatchingRule(policy, {
        url: 'https://api.github.com/repos/Kilo-Org/Cloud.Repo',
        authorization: 'Bearer placeholder-github-token',
        headers: incoming,
      });
      expect(githubRule?.headers).not.toHaveProperty('x-kilocode-organizationid');
    }
  );

  it('authenticates only exact root-session snapshot export and ingest routes', () => {
    const policy = buildVercelCredentialNetworkPolicy({ kilo: kiloInput() });
    const authorization = 'Bearer placeholder-kilo-token';
    const root = `https://ingest.example.com/history/api/session/${ROOT_SESSION_ID}`;

    expect(effectiveAuthorization(policy, { url: `${root}/export?version=2`, authorization })).toBe(
      'Bearer actual-kilo-token'
    );
    expect(
      effectiveAuthorization(policy, { url: `${root}/ingest?v=2`, method: 'POST', authorization })
    ).toBe('Bearer actual-kilo-token');

    for (const rejected of [
      { url: `${root}/export`, method: 'POST' },
      { url: `${root}/ingest`, method: 'GET' },
      { url: `${root}/import`, method: 'POST' },
      { url: `${root}/export/additional` },
      { url: 'https://ingest.example.com/history/api/session', method: 'POST' },
      { url: `https://ingest.example.com/history/api/session/${OTHER_SESSION_ID}/export` },
      {
        url: `https://ingest.example.com/history/api/session/${OTHER_SESSION_ID}/ingest`,
        method: 'POST',
      },
      { url: 'https://ingest.example.com/history/api/session/manage' },
    ]) {
      expect(effectiveAuthorization(policy, { ...rejected, authorization })).toBeUndefined();
    }

    expect(
      effectiveAuthorization(policy, {
        url: `${root}/export`,
        authorization: 'Bearer wrong-placeholder',
      })
    ).toBeUndefined();
    expect(effectiveAuthorization(policy, { url: `${root}/export` })).toBeUndefined();
  });

  it('authorizes every explicit root once while preserving overlapping session shadows', () => {
    const targets = {
      backendBaseUrl: 'https://shared.example.com',
      providerBaseUrl: 'https://shared.example.com/api/openrouter',
      sessionIngestBaseUrl: 'https://shared.example.com/api/openrouter',
    };
    const policy = buildVercelCredentialNetworkPolicy({
      kilo: kiloInput({
        rootSessionIds: [ROOT_SESSION_ID, OTHER_SESSION_ID, ROOT_SESSION_ID],
        targets,
      }),
    });
    const authorization = 'Bearer placeholder-kilo-token';
    const collection = 'https://shared.example.com/api/openrouter/api/session';

    for (const id of [ROOT_SESSION_ID, OTHER_SESSION_ID]) {
      for (const [operation, method] of [
        ['export', 'GET'],
        ['ingest', 'POST'],
      ]) {
        const url = `${collection}/${id}/${operation}`;
        expect(effectiveAuthorization(policy, { url, method, authorization })).toBe(
          'Bearer actual-kilo-token'
        );
        expect(
          policy.injectionRules.filter(
            rule =>
              rule.match.path &&
              'exact' in rule.match.path &&
              rule.match.path.exact === new URL(url).pathname
          )
        ).toHaveLength(1);
        for (const rejected of [
          { url, method: method === 'GET' ? 'POST' : 'GET' },
          { url: `${url}/extra`, method },
          { url: `${url}-extra`, method },
          { url: `${collection}/${id}-other/${operation}`, method },
        ]) {
          expect(effectiveAuthorization(policy, { ...rejected, authorization })).toBe(
            authorization
          );
        }
      }
    }
    expect(
      effectiveAuthorization(policy, {
        url: `${collection}/ses_01234567890123456789012345/export`,
        authorization,
      })
    ).toBe(authorization);
    expect(
      effectiveAuthorization(policy, {
        url: collection,
        method: 'POST',
        authorization,
      })
    ).toBe(authorization);
  });

  it('requires a nonempty root membership list', () => {
    expect(() =>
      buildVercelCredentialNetworkPolicy({ kilo: kiloInput({ rootSessionIds: [] }) })
    ).toThrow('Invalid Vercel credential network policy');
  });

  it('reuses identical route and authorization matching for local Cloudflare Kilo targets', () => {
    const input = kiloInput({
      targets: {
        backendBaseUrl: 'http://host.docker.internal:3000',
        providerBaseUrl: 'http://host.docker.internal:3000',
        sessionIngestBaseUrl: 'http://host.docker.internal:8787',
      },
    });
    const rules = buildKiloCredentialInjectionRules(input, { requireHttps: false });
    const headers = new Headers({ Authorization: 'Bearer placeholder-kilo-token' });
    expect(
      findMatchingCredentialInjectionRule(rules, {
        url: new URL('http://host.docker.internal:3000/api/user'),
        method: 'GET',
        headers,
      })?.headers
    ).toMatchObject({
      authorization: 'Bearer actual-kilo-token',
      host: 'host.docker.internal:3000',
    });
    expect(
      findMatchingCredentialInjectionRule(rules, {
        url: new URL('http://host.docker.internal:3000/api/user/token'),
        method: 'GET',
        headers,
      })
    ).toBeUndefined();
    expect(
      findMatchingCredentialInjectionRule(rules, {
        url: new URL('http://host.docker.internal:3000/api/user'),
        method: 'get',
        headers,
      })
    ).toBeUndefined();
    expect(
      findMatchingCredentialInjectionRule(rules, {
        url: new URL('http://host.docker.internal:3000/api/user'),
        method: 'GET',
        headers: new Headers({ authorization: 'bearer placeholder-kilo-token' }),
      })
    ).toBeUndefined();
    expect(() => buildVercelCredentialNetworkPolicy({ kilo: input })).toThrow(
      'Invalid Vercel credential network policy'
    );
  });

  it('authenticates only explicit safe backend GET endpoints', () => {
    const policy = buildVercelCredentialNetworkPolicy({ kilo: kiloInput() });
    const authorization = 'Bearer placeholder-kilo-token';
    const base = 'https://backend.example.com/tenant/api';

    for (const route of [
      '/user',
      '/profile',
      '/profile/balance',
      '/defaults',
      '/users/notifications',
    ]) {
      expect(effectiveAuthorization(policy, { url: `${base}${route}`, authorization })).toBe(
        'Bearer actual-kilo-token'
      );
      expect(
        effectiveAuthorization(policy, { url: `${base}${route}`, authorization, method: 'POST' })
      ).toBeUndefined();
      expect(
        effectiveAuthorization(policy, { url: `${base}${route}/extra`, authorization })
      ).toBeUndefined();
    }
  });

  it('allows only the exact personal backend model-validation POST route', () => {
    const policy = buildVercelCredentialNetworkPolicy({ kilo: kiloInput() });
    const authorization = 'Bearer placeholder-kilo-token';
    const url = 'https://backend.example.com/tenant/api/openrouter/models/validate';

    expect(effectiveAuthorization(policy, { url, authorization, method: 'POST' })).toBe(
      'Bearer actual-kilo-token'
    );
    expect(effectiveAuthorization(policy, { url, authorization })).toBeUndefined();
    expect(
      effectiveAuthorization(policy, { url: `${url}/other`, authorization, method: 'POST' })
    ).toBeUndefined();
  });

  it.each([
    ['/auth/native/exchange', 'POST'],
    ['/organizations/acme/user-tokens', 'GET'],
    ['/organizations/acme/user-tokens', 'POST'],
    ['/gastown/git-credentials', 'POST'],
    ['/wasteland/token', 'POST'],
    ['/mcp/connect-token', 'GET'],
    ['/mcp/connect-token', 'POST'],
    ['/users/me', 'GET'],
    ['/profile/tokens', 'GET'],
    ['/user/token', 'GET'],
    ['/defaults/token', 'GET'],
  ])('never authenticates the credential-escalation route %s %s', (route, method) => {
    const policy = buildVercelCredentialNetworkPolicy({
      kilo: kiloInput({
        organizationId: 'acme',
        targets: {
          backendBaseUrl: 'https://shared.example.com',
          providerBaseUrl: 'https://shared.example.com',
          sessionIngestBaseUrl: 'https://shared.example.com',
        },
      }),
    });

    expect(
      effectiveAuthorization(policy, {
        url: `https://shared.example.com/api${route}`,
        authorization: 'Bearer placeholder-kilo-token',
        method,
      })
    ).toBeUndefined();
  });

  it('scopes exact organization model, defaults, and mode access to the selected organization', () => {
    const policy = buildVercelCredentialNetworkPolicy({
      kilo: kiloInput({
        organizationId: 'Acme-Org_1',
        targets: {
          backendBaseUrl: 'https://backend.example.com/tenant/api/',
          providerBaseUrl: 'https://provider.example.com/api',
          sessionIngestBaseUrl: 'https://ingest.example.com',
        },
      }),
    });
    const authorization = 'Bearer placeholder-kilo-token';
    const base = 'https://backend.example.com/tenant/api/api/organizations/Acme-Org_1';

    for (const suffix of ['models', 'defaults', 'modes']) {
      expect(effectiveAuthorization(policy, { url: `${base}/${suffix}`, authorization })).toBe(
        'Bearer actual-kilo-token'
      );
      expect(
        effectiveAuthorization(policy, {
          url: `${base}/${suffix}`,
          authorization,
          method: 'POST',
        })
      ).toBeUndefined();
      expect(
        effectiveAuthorization(policy, { url: `${base}/${suffix}/validate`, authorization })
      ).toBeUndefined();
    }

    expect(
      effectiveAuthorization(policy, {
        url: `${base}/models/validate`,
        authorization,
        method: 'POST',
      })
    ).toBe('Bearer actual-kilo-token');
    expect(
      effectiveAuthorization(policy, {
        url: 'https://backend.example.com/tenant/api/api/organizations/other/models',
        authorization,
      })
    ).toBeUndefined();
    expect(
      effectiveAuthorization(policy, {
        url: 'https://backend.example.com/tenant/api/api/user',
        authorization,
      })
    ).toBe('Bearer actual-kilo-token');
    expect(
      effectiveAuthorization(policy, {
        url: 'https://backend.example.com/tenant/api/user',
        authorization,
      })
    ).toBeUndefined();
  });

  it('does not authorize any organization routes without an organization identity', () => {
    const policy = buildVercelCredentialNetworkPolicy({ kilo: kiloInput() });

    expect(
      effectiveAuthorization(policy, {
        url: 'https://backend.example.com/tenant/api/organizations/acme/models',
        authorization: 'Bearer placeholder-kilo-token',
      })
    ).toBeUndefined();
  });

  it.each([
    ['https://provider.example.com/api/organizations/Acme-Org_1', '/api/organizations/Acme-Org_1'],
    [
      'https://provider.example.com/tenant/api/organizations/Acme-Org_1/custom',
      '/tenant/api/organizations/Acme-Org_1/custom',
    ],
    ['https://provider.example.com/api', '/api/organizations/Acme-Org_1'],
    ['https://provider.example.com/tenant', '/tenant/api/organizations/Acme-Org_1'],
    [
      'https://provider.example.com/tenant/api/custom',
      '/tenant/api/custom/api/organizations/Acme-Org_1',
    ],
  ] as const)(
    'authenticates exact trusted-organization provider catalog and validation paths for %s',
    (providerBaseUrl, catalogBasePath) => {
      const policy = buildVercelCredentialNetworkPolicy({
        kilo: kiloInput({
          organizationId: 'Acme-Org_1',
          targets: { ...kiloInput().targets, providerBaseUrl },
        }),
      });
      const authorization = 'Bearer placeholder-kilo-token';

      expect(
        firstMatchingRule(policy, {
          url: `https://provider.example.com${catalogBasePath}/models`,
          authorization,
        })?.headers
      ).toEqual({
        authorization: 'Bearer actual-kilo-token',
        host: 'provider.example.com',
        'x-kilocode-organizationid': 'Acme-Org_1',
      });
      expect(
        effectiveAuthorization(policy, {
          url: `https://provider.example.com${catalogBasePath}/models/validate`,
          authorization,
          method: 'POST',
        })
      ).toBe('Bearer actual-kilo-token');
      expect(
        effectiveAuthorization(policy, {
          url: `https://provider.example.com${catalogBasePath.replace('Acme-Org_1', 'other')}/models`,
          authorization,
        })
      ).toBeUndefined();
    }
  );

  it.each([
    ['https://openrouter.example.com', '/models', '/api'],
    ['https://openrouter.example.com/tenant', '/tenant/models', '/tenant/api'],
    ['https://openrouter.example.com/tenant/nested', '/tenant/nested/models', '/tenant/nested/api'],
  ] as const)(
    'matches personal catalog paths when the provider hostname contains openrouter: %s',
    (providerBaseUrl, catalogPath, inferencePrefix) => {
      const policy = buildVercelCredentialNetworkPolicy({
        kilo: kiloInput({ targets: { ...kiloInput().targets, providerBaseUrl } }),
      });
      const authorization = 'Bearer placeholder-kilo-token';
      const catalog = `https://openrouter.example.com${catalogPath}`;

      expect(firstMatchingRule(policy, { url: catalog, authorization })?.match.path).toEqual({
        exact: catalogPath,
      });
      expect(
        effectiveAuthorization(policy, {
          url: `${catalog}/validate`,
          authorization,
          method: 'POST',
        })
      ).toBe('Bearer actual-kilo-token');
      expect(
        effectiveAuthorization(policy, {
          url: `${catalog}/unapproved`,
          authorization,
        })
      ).toBeUndefined();

      for (const route of ['openrouter', 'gateway']) {
        expect(
          effectiveAuthorization(policy, {
            url: `https://openrouter.example.com${inferencePrefix}/${route}/models`,
            authorization,
          })
        ).toBe('Bearer actual-kilo-token');
      }
    }
  );

  it('preserves trusted-organization catalog scope on openrouter-named provider hosts', () => {
    const policy = buildVercelCredentialNetworkPolicy({
      kilo: kiloInput({
        organizationId: 'Acme-Org_1',
        targets: {
          ...kiloInput().targets,
          providerBaseUrl: 'https://openrouter.example.com/tenant',
        },
      }),
    });
    const authorization = 'Bearer placeholder-kilo-token';

    expect(
      effectiveAuthorization(policy, {
        url: 'https://openrouter.example.com/tenant/api/organizations/Acme-Org_1/models',
        authorization,
      })
    ).toBe('Bearer actual-kilo-token');
    expect(
      effectiveAuthorization(policy, {
        url: 'https://openrouter.example.com/tenant/models',
        authorization,
      })
    ).toBeUndefined();
  });

  it('authenticates personal catalog paths outside normalized provider prefixes exactly', () => {
    const policy = buildVercelCredentialNetworkPolicy({
      kilo: kiloInput({
        targets: {
          ...kiloInput().targets,
          providerBaseUrl: 'https://provider.example.com/tenant/api/custom',
        },
      }),
    });
    const authorization = 'Bearer placeholder-kilo-token';
    const catalog = 'https://provider.example.com/tenant/api/custom/api/openrouter/models';

    expect(effectiveAuthorization(policy, { url: catalog, authorization })).toBe(
      'Bearer actual-kilo-token'
    );
    expect(
      effectiveAuthorization(policy, {
        url: `${catalog}/validate`,
        authorization,
        method: 'POST',
      })
    ).toBe('Bearer actual-kilo-token');
    expect(
      effectiveAuthorization(policy, { url: `${catalog}/validate`, authorization })
    ).toBeUndefined();
    expect(
      effectiveAuthorization(policy, { url: catalog, authorization, method: 'POST' })
    ).toBeUndefined();
    expect(
      effectiveAuthorization(policy, {
        url: 'https://provider.example.com/tenant/api/custom/api/openrouter/completions',
        authorization,
        method: 'POST',
      })
    ).toBeUndefined();
  });

  it.each([
    ['https://provider.example.com/api/organizations/other', 'Acme-Org_1'],
    ['https://provider.example.com/api/organizations/Acme-Org_1', undefined],
    ['https://provider.example.com/tenant/api/organizations/other/models', 'Acme-Org_1'],
    [
      'https://provider.example.com/api/organizations/Acme-Org_1/api/organizations/other',
      'Acme-Org_1',
    ],
    ['https://provider.example.com/api/organizations', 'Acme-Org_1'],
  ] as const)(
    'rejects mismatched embedded provider organization paths: %s',
    (providerBaseUrl, organizationId) => {
      expect(() =>
        buildVercelCredentialNetworkPolicy({
          kilo: kiloInput({
            ...(organizationId === undefined ? {} : { organizationId }),
            targets: { ...kiloInput().targets, providerBaseUrl },
          }),
        })
      ).toThrow('Invalid Vercel credential network policy');
    }
  );

  it.each([
    [
      'https://provider.example.com/api/openrouter',
      ['/api/openrouter/', '/api/gateway/'],
      ['/api/openrouter-custom/models'],
    ],
    [
      'https://provider.example.com/api/gateway',
      ['/api/openrouter/', '/api/gateway/'],
      ['/api/gateway-custom/models'],
    ],
    ['https://provider.example.com/api', ['/api/openrouter/', '/api/gateway/'], []],
    [
      'https://provider.example.com/tenant',
      ['/tenant/api/openrouter/', '/tenant/api/gateway/'],
      ['/api/openrouter/models'],
    ],
    [
      'https://provider.example.com/tenant/api/custom',
      ['/tenant/api/openrouter/', '/tenant/api/gateway/'],
      ['/tenant/api/custom/api/gateway/models', '/tenant/api/custom/api/openrouter/completions'],
    ],
    [
      'https://provider.example.com/tenant/api/custom/api/gateway',
      ['/tenant/api/custom/api/openrouter/', '/tenant/api/custom/api/gateway/'],
      ['/tenant/api/openrouter/models'],
    ],
  ] as const)(
    'scopes model-provider prefixes for %s',
    (providerBaseUrl, prefixes, rejectedPaths) => {
      const policy = buildVercelCredentialNetworkPolicy({
        kilo: kiloInput({ targets: { ...kiloInput().targets, providerBaseUrl } }),
      });
      const authorization = 'Bearer placeholder-kilo-token';

      for (const prefix of prefixes) {
        for (const method of ['GET', 'POST']) {
          expect(
            effectiveAuthorization(policy, {
              url: `https://provider.example.com${prefix}models`,
              authorization,
              method,
            })
          ).toBe('Bearer actual-kilo-token');
        }
        expect(
          effectiveAuthorization(policy, {
            url: `https://provider.example.com${prefix}models`,
            authorization,
            method: 'DELETE',
          })
        ).toBeUndefined();
        expect(
          effectiveAuthorization(policy, {
            url: `https://provider.example.com${prefix.slice(0, -1)}`,
            authorization,
          })
        ).toBeUndefined();
        expect(
          effectiveAuthorization(policy, {
            url: `https://provider.example.com${prefix.slice(0, -1)}-other/models`,
            authorization,
          })
        ).toBeUndefined();
      }

      for (const pathname of rejectedPaths) {
        expect(
          effectiveAuthorization(policy, {
            url: `https://provider.example.com${pathname}`,
            authorization,
          })
        ).toBeUndefined();
      }
    }
  );

  it('rewrites each trusted host while preserving its explicit non-default port', () => {
    const policy = buildVercelCredentialNetworkPolicy({
      kilo: kiloInput({
        targets: {
          backendBaseUrl: 'https://shared.example.com:8443/backend',
          providerBaseUrl: 'https://shared.example.com:9443/provider',
          sessionIngestBaseUrl: 'https://shared.example.com:7443/ingest',
        },
      }),
    });
    const authorization = 'Bearer placeholder-kilo-token';

    expect(
      firstMatchingRule(policy, {
        url: 'https://shared.example.com:8443/backend/api/user',
        authorization,
      })?.headers
    ).toEqual({
      authorization: 'Bearer actual-kilo-token',
      host: 'shared.example.com:8443',
      'x-kilocode-organizationid': '',
    });
    expect(
      firstMatchingRule(policy, {
        url: 'https://shared.example.com:9443/provider/api/openrouter/models',
        authorization,
      })?.headers
    ).toEqual({
      authorization: 'Bearer actual-kilo-token',
      host: 'shared.example.com:9443',
      'x-kilocode-organizationid': '',
    });
    expect(
      firstMatchingRule(policy, {
        url: `https://shared.example.com:7443/ingest/api/session/${ROOT_SESSION_ID}/export`,
        authorization,
      })?.headers
    ).toEqual({
      authorization: 'Bearer actual-kilo-token',
      host: 'shared.example.com:7443',
      'x-kilocode-organizationid': '',
    });
    expect(policy.allowedDomains).toEqual(['shared.example.com', '*']);
  });

  it('overwrites guest-supplied hosts without requiring unsupported Host matchers', () => {
    const policy = buildVercelCredentialNetworkPolicy({
      kilo: kiloInput({
        targets: {
          backendBaseUrl: 'https://shared.example.com:8443/backend',
          providerBaseUrl: 'https://shared.example.com:9443/provider',
          sessionIngestBaseUrl: 'https://shared.example.com:7443/ingest',
        },
      }),
      github: githubInput(),
    });

    const backendRule = firstMatchingRule(policy, {
      url: 'https://shared.example.com:8443/backend/api/user',
      authorization: 'Bearer placeholder-kilo-token',
      headers: { host: 'guest-selected.example.com' },
    });
    expect(backendRule?.headers.host).toBe('shared.example.com:8443');

    const githubRule = firstMatchingRule(policy, {
      url: 'https://api.github.com/repos/Kilo-Org/Cloud.Repo',
      authorization: 'Bearer placeholder-github-token',
      headers: { host: 'guest-selected.example.com' },
    });
    expect(githubRule?.headers.host).toBe('api.github.com');

    expect(
      policy.injectionRules.every(
        rule =>
          rule.match.headers.length === 1 && rule.match.headers[0]?.key.exact === 'authorization'
      )
    ).toBe(true);
  });

  it('shadows same-host session routes before an overlapping broad provider prefix', () => {
    const policy = buildVercelCredentialNetworkPolicy({
      kilo: kiloInput({
        organizationId: 'trusted-org',
        targets: {
          backendBaseUrl: 'https://shared.example.com',
          providerBaseUrl: 'https://shared.example.com:9443/api/openrouter',
          sessionIngestBaseUrl: 'https://shared.example.com:9443/api/openrouter',
        },
      }),
    });
    const authorization = 'Bearer placeholder-kilo-token';
    const collection = 'https://shared.example.com:9443/api/openrouter/api/session';
    const root = `${collection}/${ROOT_SESSION_ID}`;

    expect(effectiveAuthorization(policy, { url: `${root}/export`, authorization })).toBe(
      'Bearer actual-kilo-token'
    );
    expect(
      effectiveAuthorization(policy, { url: `${root}/ingest`, authorization, method: 'POST' })
    ).toBe('Bearer actual-kilo-token');

    for (const shadowed of [
      { url: collection, method: 'POST' },
      { url: `${collection}/${OTHER_SESSION_ID}/export` },
      { url: `${collection}/${OTHER_SESSION_ID}/ingest`, method: 'POST' },
      { url: `${collection}/${OTHER_SESSION_ID}/management`, method: 'POST' },
      { url: `${root}/import`, method: 'POST' },
      { url: `${root}/export`, method: 'POST' },
      { url: `${root}/ingest`, method: 'GET' },
    ]) {
      const rule = firstMatchingRule(policy, { ...shadowed, authorization });
      expect(rule?.headers).toEqual({
        authorization: 'Bearer placeholder-kilo-token',
        host: 'shared.example.com:9443',
        'x-kilocode-organizationid': 'trusted-org',
      });
    }

    expect(
      effectiveAuthorization(policy, {
        url: 'https://shared.example.com:9443/api/openrouter/models',
        authorization,
      })
    ).toBe('Bearer actual-kilo-token');

    const rootIndex = policy.injectionRules.findIndex(
      rule =>
        rule.match.path && 'exact' in rule.match.path && rule.match.path.exact.endsWith('/export')
    );
    const shadowIndex = policy.injectionRules.findIndex(
      rule => rule.headers.authorization === authorization
    );
    const backendIndex = policy.injectionRules.findIndex(
      rule => rule.match.path && 'exact' in rule.match.path && rule.match.path.exact === '/api/user'
    );
    const providerIndex = policy.injectionRules.findIndex(
      rule =>
        rule.match.path &&
        'startsWith' in rule.match.path &&
        rule.match.path.startsWith === '/api/openrouter/'
    );
    expect(rootIndex).toBeLessThan(shadowIndex);
    expect(shadowIndex).toBeLessThan(backendIndex);
    expect(backendIndex).toBeLessThan(providerIndex);
  });

  it('shadows exact provider catalog routes nested below the protected session namespace', () => {
    const policy = buildVercelCredentialNetworkPolicy({
      kilo: kiloInput({
        targets: {
          backendBaseUrl: 'https://backend.example.com',
          providerBaseUrl: `https://shared.example.com/api/session/${OTHER_SESSION_ID}`,
          sessionIngestBaseUrl: 'https://shared.example.com',
        },
      }),
    });

    expect(
      effectiveAuthorization(policy, {
        url: `https://shared.example.com/api/session/${OTHER_SESSION_ID}/api/openrouter/models`,
        authorization: 'Bearer placeholder-kilo-token',
      })
    ).toBe('Bearer placeholder-kilo-token');
  });

  it('shadows normalized provider prefixes nested below the protected session namespace', () => {
    const policy = buildVercelCredentialNetworkPolicy({
      kilo: kiloInput({
        targets: {
          backendBaseUrl: 'https://backend.example.com',
          providerBaseUrl: `https://shared.example.com/api/session/${OTHER_SESSION_ID}/api/custom`,
          sessionIngestBaseUrl: 'https://shared.example.com',
        },
      }),
    });

    for (const route of ['openrouter', 'gateway']) {
      expect(
        effectiveAuthorization(policy, {
          url: `https://shared.example.com/api/session/${OTHER_SESSION_ID}/api/${route}/models`,
          authorization: 'Bearer placeholder-kilo-token',
        })
      ).toBe('Bearer placeholder-kilo-token');
    }
  });

  it('authenticates Git smart HTTP only for the exact case-preserving repository boundary', () => {
    const input = githubInput();
    const policy = buildVercelCredentialNetworkPolicy({ github: input });
    const authorization = `Basic ${btoa(`x-access-token:${input.placeholder}`)}`;
    const expected = `Basic ${btoa(`x-access-token:${input.token}`)}`;

    for (const [pathname, method] of [
      ['/Kilo-Org/Cloud.Repo.git/info/refs?service=git-upload-pack', 'GET'],
      ['/Kilo-Org/Cloud.Repo.git/git-upload-pack', 'POST'],
      ['/Kilo-Org/Cloud.Repo.git/git-receive-pack', 'POST'],
    ]) {
      expect(
        firstMatchingRule(policy, {
          url: `https://github.com${pathname}`,
          authorization,
          method,
        })?.headers
      ).toEqual({ authorization: expected, host: 'github.com' });
    }

    for (const pathname of [
      '/Kilo-Org/Cloud.Repo.git',
      '/Kilo-Org/Cloud.Repo.git-other/info/refs',
      '/Kilo-Org/Cloud.Repo-other.git/info/refs',
      '/Other-Org/Cloud.Repo.git/info/refs',
      '/kilo-org/cloud.repo.git/info/refs',
    ]) {
      expect(
        effectiveAuthorization(policy, { url: `https://github.com${pathname}`, authorization })
      ).toBeUndefined();
    }
    expect(
      effectiveAuthorization(policy, {
        url: 'https://github.com/Kilo-Org/Cloud.Repo.git/info/refs',
        authorization,
        method: 'PATCH',
      })
    ).toBeUndefined();
    expect(
      effectiveAuthorization(policy, {
        url: 'https://github.com/Kilo-Org/Cloud.Repo.git/info/refs',
        authorization: `Basic ${btoa('x-access-token:wrong-placeholder')}`,
      })
    ).toBeUndefined();
    expect(
      effectiveAuthorization(policy, {
        url: 'https://github.com/Kilo-Org/Cloud.Repo.git/info/refs',
        authorization: `Basic ${btoa(`oauth2:${input.placeholder}`)}`,
      })
    ).toBeUndefined();
  });

  it.each(['Bearer', 'token'])(
    'authenticates selected GitHub API routes using %s placeholders',
    scheme => {
      const input = githubInput();
      const policy = buildVercelCredentialNetworkPolicy({ github: input });
      const authorization = `${scheme} ${input.placeholder}`;
      const repository = 'https://api.github.com/repos/Kilo-Org/Cloud.Repo';

      for (const method of ['GET', 'HEAD', 'POST', 'PATCH']) {
        for (const url of [repository, `${repository}/pulls/1?include=details`]) {
          expect(firstMatchingRule(policy, { url, authorization, method })?.headers).toEqual({
            authorization: 'Bearer actual-github-token',
            host: 'api.github.com',
          });
        }
      }

      for (const method of ['DELETE', 'PUT']) {
        expect(
          effectiveAuthorization(policy, { url: repository, authorization, method })
        ).toBeUndefined();
      }
      for (const url of [
        `${repository}-other`,
        `${repository}-other/pulls/1`,
        'https://api.github.com/repos/Kilo-Org/Other',
        'https://api.github.com/repos/kilo-org/cloud.repo',
        'https://api.github.com/graphql',
        'https://api.github.com/user',
        'https://uploads.github.com/repos/Kilo-Org/Cloud.Repo/releases/1/assets',
      ]) {
        expect(
          effectiveAuthorization(policy, { url, authorization, method: 'POST' })
        ).toBeUndefined();
      }
      expect(
        effectiveAuthorization(policy, {
          url: repository,
          authorization: `${scheme} wrong-placeholder`,
        })
      ).toBeUndefined();
    }
  );

  it.each(['Bearer', 'token'])(
    'shadows GitHub runner credential issuance before repository-prefix injection for %s',
    scheme => {
      const input = githubInput();
      const policy = buildVercelCredentialNetworkPolicy({ github: input });
      const authorization = `${scheme} ${input.placeholder}`;
      const base = 'https://api.github.com/repos/Kilo-Org/Cloud.Repo';

      for (const operation of ['registration-token', 'remove-token', 'generate-jitconfig']) {
        const url = `${base}/actions/runners/${operation}`;
        const shadow = firstMatchingRule(policy, { url, authorization, method: 'POST' });
        expect(shadow?.headers).toEqual({ authorization, host: 'api.github.com' });
        expect(shadow?.headers).not.toHaveProperty('x-kilocode-organizationid');

        const shadowIndex = policy.injectionRules.findIndex(rule => rule === shadow);
        const prefixIndex = policy.injectionRules.findIndex(
          rule =>
            rule.domain === 'api.github.com' &&
            rule.match.path &&
            'startsWith' in rule.match.path &&
            rule.match.headers.some(matcher => matcher.value.exact === authorization)
        );
        expect(shadowIndex).toBeLessThan(prefixIndex);
      }

      expect(
        effectiveAuthorization(policy, {
          url: `${base}/issues/1/comments`,
          authorization,
          method: 'POST',
        })
      ).toBe('Bearer actual-github-token');
      expect(
        effectiveAuthorization(policy, {
          url: 'https://api.github.com/repos/Kilo-Org/Other/actions/runners/registration-token',
          authorization,
          method: 'POST',
        })
      ).toBeUndefined();
    }
  );

  it.each([
    '',
    'repo',
    'owner/',
    '/repo',
    'owner/repo/extra',
    './repo',
    '../repo',
    'owner/.',
    'owner/..',
    'owner/repo%2fother',
    'owner/repo%252fother',
    'owner/repo%5cother',
    'owner/repo?other',
    'owner/repo#other',
    'owner/repo\\other',
    'owner/repo name',
  ])('rejects unsafe or ambiguous GitHub repository identity: %s', repository => {
    expect(() =>
      buildVercelCredentialNetworkPolicy({ github: githubInput({ repository }) })
    ).toThrow('Invalid Vercel credential network policy');
  });

  it.each([
    '',
    '.',
    '..',
    'org/other',
    'org%2fother',
    'org%252fother',
    'org\\other',
    'org?other',
    '.hidden-org',
    'org name',
  ])('rejects unsafe organization segments: %s', organizationId => {
    expect(() =>
      buildVercelCredentialNetworkPolicy({ kilo: kiloInput({ organizationId }) })
    ).toThrow('Invalid Vercel credential network policy');
  });

  it.each([
    '',
    'ses_short',
    'ses_abcdefghijklmnopqrstuvwxyzextra',
    'ses_abcdefghijklmnopqrstuvwxy-',
    'ses_abcdefghijklmnopqrstuvwx/yz',
    'ses_abcdefghijklmnopqrstuvwx%2f',
    'agent_abcdefghijklmnopqrstuvwxyz',
  ])('rejects noncanonical root session identities: %s', rootSessionId => {
    expect(() =>
      buildVercelCredentialNetworkPolicy({
        kilo: kiloInput({ rootSessionIds: [ROOT_SESSION_ID, rootSessionId] }),
      })
    ).toThrow('Invalid Vercel credential network policy');
  });

  it.each([
    'http://localhost:3000/base',
    'https://localhost/base',
    'https://127.0.0.1/base',
    'https://invalid_host.example.com/base',
    'https://user@example.com/base',
    'https://example.com/base?token=unsafe',
    'https://example.com/base/../escape',
    'https://example.com/base/%252e%252e/escape',
    'https://example.com/base%252fescape',
    'https://example.com/base%GG',
  ])('defensively rejects malicious provided targets: %s', target => {
    for (const key of ['backendBaseUrl', 'providerBaseUrl', 'sessionIngestBaseUrl'] as const) {
      expect(() =>
        buildVercelCredentialNetworkPolicy({
          kilo: kiloInput({ targets: { ...kiloInput().targets, [key]: target } }),
        })
      ).toThrow('Invalid Vercel credential network policy');
    }
  });

  it.each([
    { token: '', placeholder: 'placeholder' },
    { token: 'actual', placeholder: '' },
    { token: 'same', placeholder: 'same' },
    { token: 'actual\nother', placeholder: 'placeholder' },
    { token: 'actual', placeholder: 'placeholder\rother' },
  ])('rejects empty, colliding, or invalid credential values', credential => {
    expect(() => buildVercelCredentialNetworkPolicy({ kilo: kiloInput(credential) })).toThrow(
      'Invalid Vercel credential network policy'
    );
    expect(() => buildVercelCredentialNetworkPolicy({ github: githubInput(credential) })).toThrow(
      'Invalid Vercel credential network policy'
    );
  });

  it('rejects placeholder collisions between managed credential types', () => {
    expect(() =>
      buildVercelCredentialNetworkPolicy({
        kilo: kiloInput({ placeholder: 'shared-placeholder' }),
        github: githubInput({ placeholder: 'shared-placeholder' }),
      })
    ).toThrow('Invalid Vercel credential network policy');
  });
});
