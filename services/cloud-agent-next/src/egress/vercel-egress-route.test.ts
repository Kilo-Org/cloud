import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HonoContext } from '../hono-context.js';
import { logger } from '../logger.js';
import { createControlPlaneCredential } from '../sandbox-control/managed-credential.js';
import type { VercelAdmissionContext } from '../scm-broker/vercel-admission.js';
import { createVercelJwksCache } from '../scm-broker/vercel-jwks.js';
import {
  contract,
  credential,
  expected,
  keysFetch,
  logicalId,
  physicalName,
  time,
  token,
} from '../scm-broker/test-fixtures.js';
import type { EgressAuditRequest } from '../shared/egress-audit.js';
import type { SandboxEgressAdmission } from './egress-admission.js';
import { createEgressAdmissionCache } from './egress-admission.js';
import { admitVercelEgressForward, createEgressIdentityCache } from './vercel-egress-admission.js';
import {
  registerVercelEgressRoute,
  type VercelEgressRouteDependencies,
} from './vercel-egress-route.js';
import type { Env } from '../types.js';

const otherSandbox = 'sbx-other';
const oidcToken = token();

function context(sandboxId: string): VercelAdmissionContext {
  return {
    sandboxId,
    ownerId: 'user-test',
    provider: 'vercel',
    containmentEnabled: true,
    allocation: {
      kind: 'connected',
      allocationId: `allocation-${sandboxId}`,
      providerRef: JSON.stringify({ sandboxName: physicalName, sessionId: expected.sandboxId }),
    },
    physicalName,
    outboundContainerId: 'allocation-binding',
    byoc: { organizationId: 'org-test', credentialId: 'credential-test' },
    locator: {
      teamId: expected.teamId,
      projectId: expected.projectId,
      snapshotId: 'snapshot-test',
      runtimeBuildId: 'runtime-test',
      runtime: 'node24',
    },
    grants: [],
    liveSessionIds: [],
  };
}

function harness(
  options: {
    pin?: { egressAllowlist?: string[]; egressAudit?: boolean };
    recordEgressRequest?: (input: EgressAuditRequest) => Promise<unknown>;
  } = {}
) {
  const pin = options.pin ?? {
    egressAllowlist: ['example.com', 'github.com', 'worker.test'],
    egressAudit: true,
  };
  const keys = createVercelJwksCache({ fetch: keysFetch(), now: () => time });
  const identities = new Map([
    [logicalId, createEgressIdentityCache()],
    [otherSandbox, createEgressIdentityCache()],
  ]);
  const admitEgressForward = vi.fn((sandboxId: string, input: SandboxEgressAdmission) =>
    admitVercelEgressForward(input, {
      env: { WORKER_URL: 'https://worker.test' } as Env,
      contract,
      pin,
      identities: identities.get(sandboxId)!,
      readContext: async () => context(sandboxId),
      fetchCredential: async () => credential(),
      keys,
      now: () => time,
    })
  );
  const audit: EgressAuditRequest[] = [];
  const recordEgressRequest = vi.fn(
    options.recordEgressRequest ??
      (async (input: EgressAuditRequest) => {
        audit.push(input);
        return { ...input, id: audit.length };
      })
  );
  const auditStores = vi.fn(() => ({ recordEgressRequest }));
  const env = {
    WORKER_URL: 'https://worker.test',
    SANDBOX_CONTROL: {
      getByName: (sandboxId: string) => ({
        admitEgressForward: (input: SandboxEgressAdmission) => admitEgressForward(sandboxId, input),
      }),
    },
    SANDBOX_CONTAINERS: { getByName: auditStores },
    GIT_TOKEN_SERVICE: {
      redeemGitHubSessionCapability: vi.fn(async () => ({
        success: true,
        authorization: 'Bearer synthetic-upstream-token',
        source: 'installation',
        appType: 'standard',
      })),
    },
  } as unknown as Env;
  const admitScm = vi.fn<VercelEgressRouteDependencies['admitScm']>(async () => ({
    ok: true,
    authority: {
      type: 'managed',
      provider: 'github',
      capability: 'kgh2.resolved',
      outboundContainerId: 'allocation-binding',
    },
  }));
  const upstream = vi.fn(async (_request: Request) => new Response('upstream'));
  vi.stubGlobal('fetch', upstream);
  const app = new Hono<HonoContext>();
  registerVercelEgressRoute(app, {
    admitEgress: createEgressAdmissionCache({ now: () => time }),
    admitScm,
  });
  function send(
    target: { host: string; port?: string; scheme?: string; path?: string },
    init: { method?: string; headers?: Record<string, string>; sandboxId?: string } = {}
  ) {
    return app.fetch(
      new Request(`https://worker.test/scm/vercel/${init.sandboxId ?? logicalId}/ignored`, {
        method: init.method ?? 'GET',
        headers: {
          'vercel-forwarded-host': target.host,
          'vercel-forwarded-scheme': target.scheme ?? 'https',
          'vercel-forwarded-port': target.port ?? '443',
          'vercel-forwarded-path': target.path ?? '/path?query=1',
          'vercel-sandbox-oidc-token': oidcToken,
          ...init.headers,
        },
      }),
      env
    );
  }
  return { send, upstream, audit, auditStores, admitEgressForward, admitScm, recordEgressRequest };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('restricted Vercel egress route', () => {
  it('forwards a listed host without the token, Vercel or forwarding headers', async () => {
    const h = harness();
    const response = await h.send(
      { host: 'example.com' },
      {
        headers: {
          'x-forwarded-for': '203.0.113.1',
          'x-vercel-sandbox-host': 'forged.example',
          'vercel-forwarded-for': '203.0.113.1',
          accept: 'text/plain',
        },
      }
    );
    expect(response.status).toBe(200);
    expect(h.upstream).toHaveBeenCalledOnce();
    const request = h.upstream.mock.calls[0][0];
    expect(request.url).toBe('https://example.com/path?query=1');
    expect(request.headers.get('host')).toBe('example.com');
    expect(request.headers.get('accept')).toBe('text/plain');
    expect(request.redirect).toBe('manual');
    for (const name of request.headers.keys()) {
      expect(name).not.toMatch(/^(vercel-|x-vercel-|x-forwarded-)/);
    }
    expect(JSON.stringify([...request.headers])).not.toContain(oidcToken);
    expect(h.audit).toEqual([
      expect.objectContaining({
        allocationRef: `allocation-${logicalId}`,
        hostname: 'example.com',
        protocol: 'https:',
        port: 443,
        decision: 'allowed',
      }),
    ]);
    expect(h.auditStores).toHaveBeenCalledWith(logicalId);
  });

  it.each([
    ['an unlisted host', { host: 'unlisted.example' }, 'unlisted.example', 'https:', 443],
    ['the Worker host', { host: 'worker.test' }, 'worker.test', 'https:', 443],
    ['the Worker host in upper case', { host: 'WORKER.TEST' }, 'worker.test', 'https:', 443],
    [
      'the Worker host with a trailing dot',
      { host: 'worker.test.' },
      'worker.test.',
      'https:',
      443,
    ],
    ['a non-default port', { host: 'example.com', port: '8443' }, 'example.com', 'https:', 8443],
    ['userinfo', { host: 'user:secret@example.com' }, 'example.com', 'https:', 443],
    [
      'the http scheme',
      { host: 'example.com', scheme: 'http', port: '80' },
      'example.com',
      'http:',
      80,
    ],
    ['an IPv4 literal', { host: '127.0.0.1' }, '127.0.0.1', 'https:', 443],
    ['an IPv6 literal', { host: '[::1]' }, '[::1]', 'https:', 443],
  ])(
    'refuses %s with 403 and an audit row denied',
    async (_name, target, hostname, protocol, port) => {
      const h = harness();
      const response = await h.send(target);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('Egress destination disallowed');
      expect(h.upstream).not.toHaveBeenCalled();
      expect(h.admitScm).not.toHaveBeenCalled();
      expect(h.audit).toEqual([
        expect.objectContaining({ hostname, protocol, port, decision: 'denied' }),
      ]);
      expect(JSON.stringify(h.audit)).not.toContain('secret');
    }
  );

  it.each([
    ['a malformed token', 'not-a-token'],
    ['an expired token', token({ exp: time / 1000 - 1 })],
  ])('refuses %s with 401 before any audit or fetch', async (_name, presented) => {
    const h = harness();
    const response = await h.send(
      { host: 'example.com' },
      { headers: { 'vercel-sandbox-oidc-token': presented } }
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'invalid_identity' });
    expect(h.upstream).not.toHaveBeenCalled();
    expect(h.recordEgressRequest).not.toHaveBeenCalled();
  });

  it('refuses a token of one sandbox on the route of another sandbox', async () => {
    const h = harness();
    const response = await h.send({ host: 'example.com' }, { sandboxId: otherSandbox });
    expect(response.status).toBe(401);
    expect(h.admitEgressForward).toHaveBeenCalledWith(otherSandbox, { oidcToken });
    expect(h.upstream).not.toHaveBeenCalled();
    expect(h.recordEgressRequest).not.toHaveBeenCalled();
  });

  it('refuses a request without a token or with missing target headers', async () => {
    const h = harness();
    const noToken = await h.send(
      { host: 'example.com' },
      { headers: { 'vercel-sandbox-oidc-token': '' } }
    );
    expect(noToken.status).toBe(401);
    const noPort = await h.send({ host: 'example.com', port: '' });
    expect(noPort.status).toBe(401);
    expect(h.upstream).not.toHaveBeenCalled();
  });

  it('returns a redirect and does not follow it', async () => {
    const h = harness();
    h.upstream.mockImplementation(
      async () =>
        new Response(null, { status: 302, headers: { Location: 'https://unlisted.example/' } })
    );
    const response = await h.send({ host: 'example.com' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://unlisted.example/');
    expect(h.upstream).toHaveBeenCalledOnce();
    expect(h.upstream.mock.calls[0][0].redirect).toBe('manual');
  });

  it('keeps the upgrade headers only for a WebSocket upgrade', async () => {
    const h = harness();
    await h.send(
      { host: 'example.com' },
      {
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-protocol': 'chat',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      }
    );
    await h.send({ host: 'example.com' }, { headers: { upgrade: 'h2c', connection: 'Upgrade' } });
    const [upgrade, plain] = h.upstream.mock.calls.map(call => call[0].headers);
    expect(upgrade.get('upgrade')).toBe('websocket');
    expect(upgrade.get('connection')).toBe('Upgrade');
    expect(upgrade.get('sec-websocket-protocol')).toBe('chat');
    expect(plain.get('upgrade')).toBeNull();
    expect(plain.get('connection')).toBeNull();
  });

  it('runs the managed SCM admission for a managed credential on a listed host', async () => {
    const h = harness();
    const alias = createControlPlaneCredential(logicalId, 'github');
    const response = await h.send(
      { host: 'github.com', path: '/acme/repo.git/info/refs?service=git-upload-pack' },
      { headers: { authorization: `Bearer ${alias}` } }
    );
    expect(response.status).toBe(200);
    expect(h.admitScm).toHaveBeenCalledExactlyOnceWith(expect.anything(), logicalId, {
      oidcToken,
      target: {
        url: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
        method: 'GET',
      },
      authorization: { authorization: `Bearer ${alias}` },
    });
    expect(h.upstream.mock.calls[0][0].headers.get('authorization')).toBe(
      'Bearer synthetic-upstream-token'
    );
  });

  it('returns the SCM admission refusal and sends nothing', async () => {
    const h = harness();
    h.admitScm.mockResolvedValueOnce({ ok: false, status: 403, code: 'credential_denied' });
    const alias = createControlPlaneCredential(logicalId, 'github');
    const response = await h.send(
      { host: 'github.com' },
      { headers: { authorization: `Bearer ${alias}` } }
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'credential_denied' });
    expect(h.upstream).not.toHaveBeenCalled();
  });

  it('returns 502 and sends nothing when the audit write fails', async () => {
    const h = harness({
      recordEgressRequest: async () => {
        throw new Error('synthetic audit outage');
      },
    });
    const response = await h.send({ host: 'example.com' });
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('Egress audit unavailable');
    expect(h.upstream).not.toHaveBeenCalled();
  });

  it('logs an unexpected failure without the token and returns 503', async () => {
    const h = harness();
    h.admitEgressForward.mockRejectedValueOnce(new Error('synthetic control outage'));
    const error = vi.fn();
    const withFields = vi
      .spyOn(logger, 'withFields')
      .mockReturnValue(Object.assign(Object.create(logger), { error }));
    const response = await h.send({ host: 'example.com' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'forwarding_unavailable' });
    expect(withFields).toHaveBeenCalledExactlyOnceWith({
      sandboxId: logicalId,
      error: 'synthetic control outage',
    });
    expect(error).toHaveBeenCalledExactlyOnceWith('Sandbox egress forwarding failed');
    expect(h.upstream).not.toHaveBeenCalled();
    withFields.mockRestore();
  });

  it('writes no audit row for an allowlist without audit', async () => {
    const h = harness({ pin: { egressAllowlist: ['example.com'] } });
    expect((await h.send({ host: 'example.com' })).status).toBe(200);
    expect((await h.send({ host: 'unlisted.example' })).status).toBe(403);
    expect(h.auditStores).not.toHaveBeenCalled();
  });

  it('calls the control object once for repeated requests with one token', async () => {
    const h = harness();
    for (let request = 0; request < 3; request++) {
      expect((await h.send({ host: 'example.com' })).status).toBe(200);
    }
    expect(h.admitEgressForward).toHaveBeenCalledTimes(1);
  });

  it('keeps the managed SCM forward of today for a sandbox without an allowlist', async () => {
    const h = harness({ pin: {} });
    const response = await h.send({ host: 'unlisted.example' });
    expect(response.status).toBe(200);
    expect(h.admitScm).toHaveBeenCalledOnce();
    expect(h.auditStores).not.toHaveBeenCalled();
  });
});
