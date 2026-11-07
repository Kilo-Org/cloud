import { describe, expect, it } from 'vitest';
import type {
  VercelSandboxNetworkPolicy,
  VercelSandboxRule,
} from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import { createControlPlaneCredential } from './managed-credential.js';
import { buildControlNetworkPolicy, type SessionCredentialGrant } from './session-credentials.js';
import {
  buildVercelCredentialNetworkPolicy,
  findMatchingVercelRule,
  type VercelCredentialPolicyInput,
} from './vercel-network-policy.js';

const root = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const otherRoot = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
const sessionId = 'workspace_11111111-1111-4111-8111-111111111111';
const sandboxId = 'ses-abcdef';
const targets = {
  backendBaseUrl: 'https://worker.example.com/runtime',
  providerBaseUrl: 'https://worker.example.com/runtime',
  sessionIngestBaseUrl: 'https://worker.example.com/runtime',
};
const forwardURL = 'https://worker.example.com/runtime-credential-proxy/vercel/ses-abcdef';

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

function findRule(
  rules: readonly VercelSandboxRule[],
  url: string,
  method: string,
  authorization: string
) {
  return findMatchingVercelRule(rules, {
    url: new URL(url),
    method,
    headers: new Headers({ Authorization: authorization }),
  });
}

describe('Vercel runtime proxy forwarding policy', () => {
  const input: VercelCredentialPolicyInput = {
    sandboxId,
    runtimeProxy: {
      targets,
      members: [{ sessionId, kiloSessionId: root, handle: 'member-handle' }],
      handles: ['adopted-handle'],
    },
  };

  it('forwards the original request by exact handle to the configured runtime route', () => {
    const { forwardRules } = buildVercelCredentialNetworkPolicy(input);
    expect(forwardRules).toHaveLength(2);
    for (const rule of forwardRules) {
      expect(rule.domain).toBe('worker.example.com');
      expect(rule.forwardURL).toBe(forwardURL);
      expect(rule.match?.path).toBeUndefined();
    }
    for (const [method, path] of [
      ['POST', '/api/session'],
      ['POST', `/api/session/${root}/ingest`],
      ['GET', `/api/session/${root}/export`],
      ['PUT', '/api/session/child/ingest'],
      ['POST', '/internal/cloud-agent/v1/session'],
      ['POST', '/api/exa/search'],
      ['GET', '/api/user?x=1'],
    ] as const) {
      expect(
        findRule(forwardRules, `https://worker.example.com${path}`, method, 'Bearer member-handle')
      ).toBe(forwardRules[0]);
      expect(
        findRule(forwardRules, `https://worker.example.com${path}`, method, 'Bearer adopted-handle')
      ).toBe(forwardRules[1]);
    }
  });

  it.each(['Bearer forged-handle', `Bearer ${root}`, 'token member-handle', 'member-handle'])(
    'never forwards a non-exact authorization %s',
    authorization => {
      const { forwardRules } = buildVercelCredentialNetworkPolicy(input);
      expect(
        findRule(forwardRules, 'https://worker.example.com/api/session', 'POST', authorization)
      ).toBeUndefined();
    }
  );

  it('never forwards a foreign host, even with the exact handle', () => {
    const { forwardRules } = buildVercelCredentialNetworkPolicy(input);
    expect(
      findRule(forwardRules, 'https://evil.example.com/api/session', 'POST', 'Bearer member-handle')
    ).toBeUndefined();
  });

  it.each([
    ['message', { ...targets, backendBaseUrl: 'http://worker.example.com' }],
    ['port', { ...targets, providerBaseUrl: 'https://worker.example.com:8443/runtime' }],
    ['mixed roots', { ...targets, sessionIngestBaseUrl: 'https://ingest.example.com' }],
    ['credentials', { ...targets, backendBaseUrl: 'https://user@worker.example.com/runtime' }],
    ['query', { ...targets, providerBaseUrl: 'https://worker.example.com/runtime?x=1' }],
  ])('rejects an invalid %s target', (_name, invalidTargets) => {
    expect(() =>
      buildVercelCredentialNetworkPolicy({
        ...input,
        runtimeProxy: { ...input.runtimeProxy, targets: invalidTargets },
      })
    ).toThrow();
    expect(() =>
      buildVercelCredentialNetworkPolicy({ ...input, sandboxId: 'not a sandbox' })
    ).toThrow();
  });
});

describe('contained Vercel modern policy composition', () => {
  it.each(['single', 'multiple', 'empty'])(
    'builds one modern request shape for %s grants without same-bearer transforms',
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
      expect(JSON.stringify(policy)).not.toContain('transform');
      if (kind === 'empty') expect(policy).toEqual({ allow: { '*': [] } });
      for (const value of grants) {
        const forwarded = findMatchingVercelRule(policy.allow['worker.example.com'] ?? [], {
          url: new URL('https://worker.example.com/api/profile'),
          method: 'GET',
          headers: new Headers({ Authorization: `Bearer ${value.scopeId}` }),
        });
        expect(forwarded).toMatchObject({ forwardURL });
      }
      expect(JSON.stringify(policy)).not.toContain(grants[0]?.kilo.token ?? 'never');
    }
  );

  it('retains merged SCM forwarding and original runtime hosts', () => {
    const value = grant('member-handle');
    const now = Date.now();
    value.preparedAt = now;
    value.expiresAt = now + 60_000;
    value.repository = {
      type: 'github',
      repo: 'acme/widgets',
      authentication: 'managed',
      allowUserAuthorization: true,
    };
    value.outboundContainerId = 'allocation-binding';
    value.scm = {
      purpose: 'github',
      alias: createControlPlaneCredential(sandboxId, 'github'),
      gitUrl: 'https://github.com/acme/widgets.git',
      githubAppType: 'standard',
      capability: {
        credential: 'kgh2.synthetic',
        outboundContainerId: 'allocation-binding',
        issuedAt: now - 1_000,
        expiresAt: now + 60_000,
      },
    };
    const policy: VercelSandboxNetworkPolicy = buildControlNetworkPolicy([value], undefined, {
      WORKER_URL: 'https://worker.example.com',
    });
    expect(policy.allow['worker.example.com']).toEqual([expect.objectContaining({ forwardURL })]);
    expect(policy.allow['github.com']).toEqual([
      { forwardURL: `https://worker.example.com/scm/vercel/${sandboxId}` },
    ]);
    expect(policy.allow['*']).toEqual([]);
  });

  it('retains accepted handles without sharing unadopted handles', () => {
    const value = grant('member-handle');
    value.members.push({
      sessionId: 'workspace_22222222-2222-4222-8222-222222222222',
      kiloSessionId: otherRoot,
    });
    const policy = buildControlNetworkPolicy(
      [value],
      new Map([[value.scopeId, ['adopted-handle']]])
    );
    const url = 'https://worker.example.com/api/session';
    expect(
      findMatchingVercelRule(policy.allow['worker.example.com'] ?? [], {
        url: new URL(url),
        method: 'POST',
        headers: new Headers({ Authorization: 'Bearer adopted-handle' }),
      })
    ).toBeDefined();
    expect(
      findMatchingVercelRule(policy.allow['worker.example.com'] ?? [], {
        url: new URL(url),
        method: 'POST',
        headers: new Headers({ Authorization: 'Bearer member-handle' }),
      })
    ).toBeDefined();
  });
});
