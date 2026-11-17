import { describe, expect, it } from 'vitest';
import type { VercelSandboxNetworkPolicy } from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import { createControlPlaneCredential } from './managed-credential.js';
import { buildControlNetworkPolicy, type SessionCredentialGrant } from './session-credentials.js';
import {
  buildVercelCredentialNetworkPolicy,
  buildVercelTransformNetworkPolicy,
  findMatchingCredentialInjectionRule,
  type VercelCredentialPolicyInput,
} from './vercel-network-policy.js';

const root = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const otherRoot = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
const child = 'ses_cccccccccccccccccccccccccc';
const sessionId = 'workspace_11111111-1111-4111-8111-111111111111';
const sandboxId = 'ses-abcdef';
const targets = {
  backendBaseUrl: 'https://worker.example.com',
  providerBaseUrl: 'https://worker.example.com',
  sessionIngestBaseUrl: 'https://worker.example.com',
};

function grant(scopeId: string): SessionCredentialGrant {
  return {
    version: 1,
    containmentEnabled: true,
    scopeId,
    sandboxId,
    directory: `/workspace/${scopeId}`,
    userId: 'user-1',
    provider: 'vercel',
    members: [{ sessionId, kiloSessionId: root }],
    kilo: {
      alias: createControlPlaneCredential(sandboxId, 'kilo'),
      token: 'eyJhbGciOiJub25lIn0.eyJydW50aW1lQXV0aG9yaXphdGlvbiI6eyJpZCI6InJhXzEifX0.c2ln',
      targets,
      runtimeProxy: { targets, members: [{ sessionId, kiloSessionId: root, handle: scopeId }] },
      capabilities: {},
    },
    preparedAt: 1_000,
    expiresAt: 61_000,
  };
}

function matchingTransform(policy: VercelSandboxNetworkPolicy, request: Request) {
  const url = new URL(request.url);
  return (policy.allow[url.hostname] ?? policy.allow['*'] ?? [])
    .filter(rule => 'transform' in rule)
    .find(({ match }) => {
      if (match.method && !match.method.includes(request.method)) return false;
      if (match.path) {
        if ('exact' in match.path && url.pathname !== match.path.exact) return false;
        if ('startsWith' in match.path && !url.pathname.startsWith(match.path.startsWith))
          return false;
      }
      return match.headers.every(
        ({ key, value }) => request.headers.get(key.exact) === value.exact
      );
    });
}

function applyPolicy(policy: VercelSandboxNetworkPolicy, request: Request): Request {
  const headers = new Headers(request.headers);
  for (const transform of matchingTransform(policy, request)?.transform ?? []) {
    for (const [key, value] of Object.entries(transform.headers)) headers.set(key, value);
  }
  return new Request(request, { headers });
}

function request(url: string, method: string, authorization: string): Request {
  return new Request(url, {
    method,
    headers: { Authorization: authorization, Host: 'forged.example.com' },
  });
}

describe('provider organization catalog', () => {
  const input: VercelCredentialPolicyInput = {
    rootSessionIds: [root],
    organizationId: 'org-1',
    runtimeProxy: {
      targets,
      members: [{ sessionId, kiloSessionId: root, handle: 'member-handle' }],
    },
  };

  it('allows only the session organization catalog', () => {
    const policy = buildVercelCredentialNetworkPolicy(input);
    const exactPaths = policy.injectionRules.flatMap(rule =>
      rule.match.path && 'exact' in rule.match.path ? [rule.match.path.exact] : []
    );
    expect(exactPaths).toContain('/api/openrouter/organizations/org-1/models');
    expect(exactPaths).toContain('/api/gateway/organizations/org-1/models');
    expect(exactPaths).not.toContain('/api/openrouter/organizations/org-2/models');
    const rule = policy.injectionRules.find(
      candidate =>
        candidate.match.path &&
        'exact' in candidate.match.path &&
        candidate.match.path.exact === '/api/openrouter/organizations/org-1/models'
    );
    expect(rule?.match.method).toEqual(['GET']);
  });
});

describe('Vercel ordered transform conversion', () => {
  const inputs: Array<[string, VercelCredentialPolicyInput]> = [
    [
      'runtime facade',
      {
        rootSessionIds: [root, otherRoot],
        organizationId: 'org-1',
        runtimeProxy: {
          targets,
          members: [{ sessionId, kiloSessionId: root, handle: 'member-handle' }],
          handles: ['adopted-handle'],
        },
      },
    ],
  ];

  it.each(inputs)('preserves every ordered %s rule and all request dimensions', (_name, input) => {
    const original = buildVercelCredentialNetworkPolicy(input);
    const policy = buildVercelTransformNetworkPolicy(
      original.allowedDomains,
      original.injectionRules
    );
    expect(Object.keys(policy)).toEqual(['allow']);
    expect(policy.allow['*']).toEqual([]);
    for (const domain of original.allowedDomains) {
      expect(policy.allow[domain]).toEqual(
        original.injectionRules
          .filter(rule => rule.domain === domain)
          .map(({ match, headers }) => ({ match, transform: [{ headers }] }))
      );
    }
    for (const rule of original.injectionRules) {
      const path = rule.match.path;
      const pathname = path ? ('exact' in path ? path.exact : `${path.startsWith}child`) : '/';
      for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']) {
        for (const query of [
          '',
          '?input=%7B%22test%22%3Atrue%7D&batch=1',
          '?service=git-upload-pack',
        ]) {
          for (const authorization of [rule.match.headers[0].value.exact, 'Bearer forged']) {
            const candidate = request(
              `https://${rule.domain}${pathname}${query}`,
              method,
              authorization
            );
            const expected = findMatchingCredentialInjectionRule(original.injectionRules, {
              url: new URL(candidate.url),
              method,
              headers: candidate.headers,
            });
            const result = applyPolicy(policy, candidate);
            const expectedHeaders = new Headers(candidate.headers);
            for (const [key, value] of Object.entries(expected?.headers ?? {}))
              expectedHeaders.set(key, value);
            expect([...result.headers]).toEqual([...expectedHeaders]);
            expect(result.url).toBe(candidate.url);
          }
        }
      }
    }
  });
});

describe('contained Vercel modern policy composition', () => {
  it.each(['single', 'multiple', 'empty'])(
    'builds one modern request shape for %s grants without forwarding',
    kind => {
      const grants =
        kind === 'empty'
          ? []
          : kind === 'multiple'
            ? [grant('first'), grant('second')]
            : [grant('kilo')];
      const policy = buildControlNetworkPolicy(grants);
      expect(Object.keys(policy)).toEqual(['allow']);
      expect(Object.keys(policy.allow).at(-1)).toBe('*');
      expect(policy.allow['*']).toEqual([]);
      expect(JSON.stringify(policy)).not.toContain('forwardURL');
      if (kind === 'empty') expect(policy).toEqual({ allow: { '*': [] } });
      for (const value of grants) {
        expect(
          matchingTransform(
            policy,
            request('https://worker.example.com/api/profile', 'GET', `Bearer ${value.scopeId}`)
          )
        ).toBeDefined();
        expect(JSON.stringify(policy)).not.toContain(value.kilo.token);
      }
    }
  );

  it('keeps facade handles opaque, limits root reads and preserves delegated child POSTs', () => {
    const value = grant('member-handle');
    const policy = buildControlNetworkPolicy([value]);
    for (const [method, path] of [
      ['GET', '/api/profile'],
      ['POST', '/api/gateway/v1/responses'],
      ['POST', '/api/session'],
      ['POST', `/api/session/${child}/ingest`],
      ['GET', `/api/session/${root}/export`],
      ['POST', `/api/session/${root}/title`],
      ['POST', '/api/exa/search'],
    ]) {
      const candidate = request(
        `https://worker.example.com${path}?batch=1`,
        method,
        'Bearer member-handle'
      );
      expect(matchingTransform(policy, candidate)).toBeDefined();
      const result = applyPolicy(policy, candidate);
      expect(result.headers.get('authorization')).toBe('Bearer member-handle');
      expect(result.headers.get('host')).toBe('worker.example.com');
      expect(result.url).toBe(candidate.url);
    }
    for (const [method, path] of [
      ['GET', `/api/session/${child}/export`],
      ['PUT', `/api/session/${child}/ingest`],
      ['GET', '/api/profile/child'],
      ['DELETE', '/api/profile'],
      ['POST', '/api/trpc/session.create'],
      ['POST', '/internal/cloud-agent/v1/session'],
    ]) {
      expect(
        matchingTransform(
          policy,
          request(`https://worker.example.com${path}`, method, 'Bearer member-handle')
        )
      ).toBeUndefined();
    }
    for (const authorization of [
      'Bearer forged-handle',
      `Bearer ${value.kilo.alias}`,
      'token member-handle',
    ]) {
      expect(
        matchingTransform(
          policy,
          request('https://worker.example.com/api/profile', 'GET', authorization)
        )
      ).toBeUndefined();
    }
    expect(JSON.stringify(policy)).not.toContain(value.kilo.token);
  });

  it('retains accepted handles for every root without sharing unadopted handles', () => {
    const value = grant('member-handle');
    value.members.push({
      sessionId: 'workspace_22222222-2222-4222-8222-222222222222',
      kiloSessionId: otherRoot,
    });
    const policy = buildControlNetworkPolicy(
      [value],
      new Map([[value.scopeId, ['adopted-handle']]])
    );
    const url = `https://worker.example.com/api/session/${otherRoot}/export`;
    expect(matchingTransform(policy, request(url, 'GET', 'Bearer adopted-handle'))).toBeDefined();
    expect(matchingTransform(policy, request(url, 'GET', 'Bearer member-handle'))).toBeUndefined();
  });
});
