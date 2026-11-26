import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import {
  LeaseResultSchema,
  LeaseRevokeResultSchema,
  type LeaseRequest,
  type LeaseResult,
  type LeaseRevokeResult,
} from '@kilocode/sts-contracts';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDenialBuffers } from '../../src/audit/denials';
import { SecretsBroker } from '../../src/broker';
import {
  LEASE_CREATE_BUDGET_MS,
  LEASE_CREATES_PER_MINUTE,
  LEASE_RETRY_AFTER_SECONDS,
} from '../../src/constants';
import { LeaseDO, type LeaseCreateRequest } from '../../src/dos/LeaseDO';
import { getDenialStub, getLeaseStub } from '../../src/dos/stubs';
import { handleRequest, leaseResponse, leaseRevokeResponse } from '../../src/http';
import { loadPolicies } from '../../src/policy/load';
import type { MintAuthority } from '../../src/tokens/mint';
import { stubOfflineNetwork } from './manager';
import { resetDenialObject, resetLeaseObject } from './reset';
import { createProvider, providerFetch, signToken, type TestProvider } from './support';
import { config, env } from './test-env';

const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const DEPLOY_WORKFLOW = 'acme/repo/.github/workflows/deploy.yml@refs/heads/main';

const authority: MintAuthority = {
  scopes: {},
  policies: loadPolicies({
    'bouncer-watch.yaml': `
workload: bouncer-watch
environments: [development]
identity:
  kind: worker-binding
secrets: []
dynamic:
  - grant: replica-read
    maxTtlSeconds: 9000
    defaultTtlSeconds: 3600
    maxActive: 2
`,
    'replica-reader.yaml': `
workload: replica-reader
environments: [development]
identity:
  kind: worker-binding
secrets: []
dynamic:
  - grant: replica-read
    maxTtlSeconds: 3600
    defaultTtlSeconds: 3600
    maxActive: 4
`,
    'plain-worker.yaml': `
workload: plain-worker
environments: [development]
identity:
  kind: worker-binding
secrets: []
`,
    'staging-worker.yaml': `
workload: staging-worker
environments: [staging]
identity:
  kind: worker-binding
secrets: []
`,
    'ci-migrate.yaml': `
workload: ci-migrate
environments: [development]
identity:
  kind: github-oidc
  repository: acme/repo
  repositoryId: '123'
  repositoryOwnerId: '456'
  environment: migrations
  jobWorkflowRefs: [${DEPLOY_WORKFLOW}]
  events: [push]
secrets: []
dynamic:
  - grant: ci-migration
    maxTtlSeconds: 3600
    defaultTtlSeconds: 3600
    maxActive: 1
`,
  }),
};

class TestBroker extends SecretsBroker {
  static override readonly mintAuthority = authority;
}

type ManagerCall = { method: string; path: string; body: Record<string, unknown> };

type LeaseManager = {
  calls: ManagerCall[];
  creates: () => ManagerCall[];
  revokes: () => ManagerCall[];
  /** Status the next lease calls answer with; 200 unless set. */
  setCreateStatus: (status: number) => void;
  setRevokeStatus: (status: number) => void;
  /** Infisical refuses the revocation of this lease only (503), whatever the revoke status. */
  refuseRevokeOf: (leaseId: string) => void;
  /**
   * Infisical's revocation statement fails at the database: a 200 whose lease row stays, with
   * status "Failed to delete" (and the database error, which STS must not keep).
   */
  setRevokeKept: (kept: boolean) => void;
  /** Added to the expiry the fake reports, to stand in for a misconfigured dynamic secret. */
  setExpirySkewMs: (ms: number) => void;
  /** Runs as the fake answers a create, after it computed the expiry (a test moves the clock). */
  setOnCreate: (hook: () => void) => void;
};

/**
 * Stands in for Infisical Cloud's JWT Auth login and lease routes; any other URL goes to
 * `fallback` (the fake GitHub issuer). The usernames and passwords are synthetic and carry a
 * marker the audit checks look for.
 */
function installLeaseManager(
  fallback: typeof fetch = async () => new Response('', { status: 404 })
): LeaseManager {
  const calls: ManagerCall[] = [];
  let createStatus = 200;
  let revokeStatus = 200;
  let revokeKept = false;
  let expirySkewMs = 0;
  let onCreate = (): void => {};
  let serial = 0;
  const revokeRefused = new Set<string>();
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    if (url.origin !== 'https://manager.sts-test.invalid') return await fallback(input, init);
    const raw = init?.body;
    const body = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/v1/auth/jwt-auth/login') {
      return Response.json({ accessToken: 'manager-access-token', expiresIn: 600 });
    }
    calls.push({ method, path: url.pathname, body });
    if (method === 'POST' && url.pathname === '/api/v1/dynamic-secrets/leases') {
      if (createStatus !== 200) return new Response('refused', { status: createStatus });
      serial += 1;
      const ttlSeconds = Number(String(body.ttl).replace(/s$/, ''));
      const response = Response.json({
        lease: {
          id: crypto.randomUUID(),
          version: 1,
          externalEntityId: `lease_user_${serial}`,
          expireAt: new Date(Date.now() + ttlSeconds * 1000 + expirySkewMs).toISOString(),
          dynamicSecretId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        dynamicSecret: { name: body.dynamicSecretName, defaultTTL: '1h', maxTTL: '8h' },
        data: { DB_USERNAME: `lease_user_${serial}`, DB_PASSWORD: `synthetic-password-${serial}` },
      });
      onCreate();
      return response;
    }
    if (method === 'DELETE' && url.pathname.startsWith('/api/v1/dynamic-secrets/leases/')) {
      const leaseId = url.pathname.split('/').pop() ?? '';
      if (revokeStatus === 404) {
        // Infisical's NotFoundError body for a lease it does not have.
        return Response.json(
          {
            reqId: 'req-1',
            statusCode: 404,
            message: `Dynamic secret lease with ID '${leaseId}' not found`,
            error: 'NotFound',
          },
          { status: 404 }
        );
      }
      if (revokeStatus !== 200) {
        const headers: Record<string, string> =
          revokeStatus === 429 ? { 'retry-after': '120' } : {};
        return new Response('refused', { status: revokeStatus, headers });
      }
      if (revokeRefused.has(leaseId)) {
        return new Response('refused', { status: 503 });
      }
      if (revokeKept) {
        return Response.json({
          lease: {
            id: leaseId,
            status: 'Failed to delete',
            statusDetails: 'Failed to revoke lease from provider: synthetic-db-error',
          },
        });
      }
      return Response.json({ lease: { id: leaseId, status: null, statusDetails: null } });
    }
    return new Response('not found', { status: 404 });
  };
  vi.stubGlobal('fetch', fetchImpl);
  return {
    calls,
    creates: () => calls.filter(call => call.method === 'POST'),
    revokes: () => calls.filter(call => call.method === 'DELETE'),
    setCreateStatus: status => {
      createStatus = status;
    },
    setRevokeStatus: status => {
      revokeStatus = status;
    },
    refuseRevokeOf: leaseId => {
      revokeRefused.add(leaseId);
    },
    setRevokeKept: kept => {
      revokeKept = kept;
    },
    setExpirySkewMs: ms => {
      expirySkewMs = ms;
    },
    setOnCreate: hook => {
      onCreate = hook;
    },
  };
}

let pending: Promise<unknown>[] = [];

function broker(caller: string): TestBroker {
  const ctx = {
    props: { caller },
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: () => undefined,
  };
  return new TestBroker(ctx as unknown as ExecutionContext, env);
}

async function lease(caller: string, request: LeaseRequest): Promise<LeaseResult> {
  return await broker(caller).lease(request);
}

function issued(result: LeaseResult): Extract<LeaseResult, { status: 'ok' }> {
  if (result.status !== 'ok') throw new Error(`expected a lease, got ${JSON.stringify(result)}`);
  return result;
}

/** A creation request straight to the lease object, as `serveLease` sends it. */
function objectRequest(overrides: Partial<LeaseCreateRequest> = {}): LeaseCreateRequest {
  return {
    environment: 'development',
    caller: {
      workload: 'bouncer-watch',
      identity: 'worker-binding',
      channel: 'worker-binding',
      run: null,
    },
    grant: 'replica-read',
    ttlSeconds: 3600,
    requestedTtlSeconds: null,
    clamped: false,
    maxActive: 2,
    requestedAt: Date.now(),
    ...overrides,
  };
}

type Event = {
  type: string;
  data: { outcome: string; outcomeDetail?: string; attributes: Record<string, unknown> };
};

async function leaseEvents(): Promise<Event[]> {
  return await runInDurableObject(getLeaseStub(env, config), (_instance, state) =>
    state.storage.sql
      .exec<{ event: string }>('SELECT event FROM audit_event ORDER BY seq')
      .toArray()
      .map(row => JSON.parse(row.event) as Event)
  );
}

/** Writes the open denial windows as audit events and returns them. */
async function flushedDenials(): Promise<Event[]> {
  await Promise.all(pending);
  const stub = getDenialStub(env, config);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(`UPDATE denial_window SET minute = '2020-01-01T00:00'`);
  });
  await runDurableObjectAlarm(stub);
  return await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ event: string }>('SELECT event FROM audit_event ORDER BY seq')
      .toArray()
      .map(row => JSON.parse(row.event) as Event)
  );
}

/** Makes every owed revocation due for the next alarm, as if 30 s had passed since its attempt. */
async function revocationsDue(): Promise<void> {
  await runInDurableObject(getLeaseStub(env, config), (_instance, state) => {
    state.storage.sql.exec(
      'UPDATE lease SET revoke_retry_at = revoke_retry_at - 60000 WHERE revoke_retry_at IS NOT NULL'
    );
  });
}

/** The lease ids Infisical was asked to revoke, in call order. */
function revokedIds(manager: LeaseManager): string[] {
  return manager.revokes().map(call => call.path.split('/').pop() ?? '');
}

beforeEach(async () => {
  pending = [];
  clearDenialBuffers();
  stubOfflineNetwork();
  await resetLeaseObject(getLeaseStub(env, config));
  await resetDenialObject(getDenialStub(env, config));
});

afterEach(() => {
  stubOfflineNetwork();
  vi.restoreAllMocks();
});

describe('worker-binding lease', () => {
  it('creates a replica-read lease with the requested lifetime and audits it without the credential', async () => {
    const manager = installLeaseManager();
    const before = Date.now();
    const result = issued(
      await lease('bouncer-watch', { grant: 'replica-read', ttlSeconds: 3600 })
    );
    expect(LeaseResultSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      grant: 'replica-read',
      username: 'lease_user_1',
      password: 'synthetic-password-1',
      ttlSeconds: 3600,
      clamped: false,
    });
    // The replica consumer keeps its own host: no connection target for replica-read.
    expect(result).not.toHaveProperty('host');
    const expiresAt = Date.parse(result.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3600_000);

    expect(manager.creates()).toEqual([
      {
        method: 'POST',
        path: '/api/v1/dynamic-secrets/leases',
        body: {
          dynamicSecretName: 'replica-read',
          projectSlug: 'test-project',
          environmentSlug: 'development',
          path: '/dynamic/replica-read',
          ttl: '3600s',
        },
      },
    ]);
    const events = await leaseEvents();
    expect(events.map(event => event.type)).toEqual(['ai.kilo.sts.lease.created']);
    expect(events[0].data.attributes).toEqual({
      workload: 'bouncer-watch',
      environment: 'development',
      identity: 'worker-binding',
      channel: 'worker-binding',
      grant: 'replica-read',
      leaseId: result.leaseId,
      ttlSeconds: 3600,
      requestedTtlSeconds: 3600,
      clamped: false,
      expiresAt: new Date(expiresAt).toISOString(),
    });
    expect(JSON.stringify(events)).not.toContain('synthetic-password');
    expect(JSON.stringify(events)).not.toContain('lease_user_');
  });

  it('takes the policy default without a lifetime and shortens one above the policy maximum', async () => {
    const manager = installLeaseManager();
    expect(issued(await lease('bouncer-watch', { grant: 'replica-read' }))).toMatchObject({
      ttlSeconds: 3600,
      clamped: false,
    });
    expect(
      issued(await lease('bouncer-watch', { grant: 'replica-read', ttlSeconds: 28_800 }))
    ).toMatchObject({
      ttlSeconds: 9000,
      clamped: true,
    });
    expect(manager.creates().map(call => call.body.ttl)).toEqual(['3600s', '9000s']);
    const attributes = (await leaseEvents()).map(event => event.data.attributes);
    expect(attributes[0]).not.toHaveProperty('requestedTtlSeconds');
    expect(attributes[1]).toMatchObject({
      requestedTtlSeconds: 28_800,
      ttlSeconds: 9000,
      clamped: true,
    });
  });

  it('refuses a third concurrent lease beyond maxActive, with no manager call', async () => {
    const manager = installLeaseManager();
    const [first, second, third] = await Promise.all([
      lease('bouncer-watch', { grant: 'replica-read', ttlSeconds: 3600 }),
      lease('bouncer-watch', { grant: 'replica-read', ttlSeconds: 9000 }),
      lease('bouncer-watch', { grant: 'replica-read', ttlSeconds: 3600 }),
    ]);
    const results = [first, second, third];
    expect(results.filter(result => result.status === 'ok')).toHaveLength(2);
    const refused = results.find(result => result.status === 'limited');
    expect(refused).toMatchObject({ status: 'limited', reason: 'too_many_active' });
    expect(manager.creates()).toHaveLength(2);
    const response = leaseResponse(refused ?? { status: 'invalid_request' });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);

    const denials = await flushedDenials();
    expect(denials.map(event => event.type)).toEqual(['ai.kilo.sts.lease.denied']);
    expect(denials[0].data.attributes).toMatchObject({
      reason: 'too_many_active',
      workload: 'bouncer-watch',
      grant: 'replica-read',
      count: 1,
    });
  });

  it('caps lease creations per workload per minute, whatever their outcome', async () => {
    const manager = installLeaseManager();
    for (let round = 0; round < LEASE_CREATES_PER_MINUTE; round += 1) {
      const created = issued(await lease('replica-reader', { grant: 'replica-read' }));
      expect(await broker('replica-reader').revokeLease(created.leaseId)).toEqual({
        status: 'revoked',
        leaseId: created.leaseId,
      });
    }
    const refused = await lease('replica-reader', { grant: 'replica-read' });
    expect(refused).toMatchObject({ status: 'limited', reason: 'rate_limited' });
    expect(manager.creates()).toHaveLength(LEASE_CREATES_PER_MINUTE);
    // Another workload has its own count.
    issued(await lease('bouncer-watch', { grant: 'replica-read' }));
  });

  it('denies a grant the policy does not list, a workload with no policy here, and an unknown one', async () => {
    const manager = installLeaseManager();
    expect(await lease('plain-worker', { grant: 'replica-read' })).toEqual({
      status: 'denied',
      reason: 'grant_not_allowed',
    });
    expect(await lease('bouncer-watch', { grant: 'ci-migration' })).toEqual({
      status: 'denied',
      reason: 'grant_not_allowed',
    });
    expect(await lease('staging-worker', { grant: 'replica-read' })).toEqual({
      status: 'denied',
      reason: 'environment_mismatch',
    });
    expect(await lease('nobody', { grant: 'replica-read' })).toEqual({
      status: 'denied',
      reason: 'unknown_workload',
    });
    expect(await lease('ci-migrate', { grant: 'ci-migration' })).toEqual({
      status: 'denied',
      reason: 'identity_rejected',
    });
    expect(manager.calls).toEqual([]);
    const reasons = (await flushedDenials()).map(event => [
      event.data.attributes.workload,
      event.data.attributes.reason,
    ]);
    expect(reasons).toEqual(
      expect.arrayContaining([
        ['plain-worker', 'grant_not_allowed'],
        ['bouncer-watch', 'grant_not_allowed'],
        ['staging-worker', 'environment_mismatch'],
        ['nobody', 'unknown_workload'],
        ['ci-migrate', 'identity_rejected'],
      ])
    );
  });

  it('refuses a malformed request and a lifetime below the minimum', async () => {
    installLeaseManager();
    expect(await lease('bouncer-watch', { grant: 'replica-read', ttlSeconds: 60 })).toEqual({
      status: 'invalid_request',
    });
    expect(
      await broker('bouncer-watch').lease({ grant: 'admin' } as unknown as LeaseRequest)
    ).toEqual({ status: 'invalid_request' });
  });

  it('answers unavailable when Infisical refuses, and frees the slot', async () => {
    const manager = installLeaseManager();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    manager.setCreateStatus(400);
    expect(await lease('bouncer-watch', { grant: 'replica-read' })).toEqual({
      status: 'unavailable',
      retryAfterSeconds: LEASE_RETRY_AFTER_SECONDS,
    });
    manager.setCreateStatus(200);
    issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    expect((await leaseEvents()).map(event => event.type)).toEqual([
      'ai.kilo.sts.lease.created',
      'ai.kilo.sts.lease.created',
    ]);
  });

  it('revokes a lease whose expiry is not the lifetime asked for, and hands nothing over', async () => {
    const manager = installLeaseManager();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    manager.setExpirySkewMs(60 * 60 * 1000);
    expect(await lease('bouncer-watch', { grant: 'replica-read' })).toMatchObject({
      status: 'unavailable',
    });
    expect(manager.revokes()).toHaveLength(1);
    const events = await leaseEvents();
    expect(events.map(event => [event.type, event.data.outcomeDetail])).toEqual([
      ['ai.kilo.sts.lease.revoked', 'expiry_mismatch'],
    ]);
    expect(events[0].data.attributes).toMatchObject({
      cause: 'expiry_mismatch',
      result: 'revoked',
    });
  });

  it('creates no lease in an environment without a project slug', async () => {
    const manager = installLeaseManager();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runInDurableObject(getLeaseStub(env, config), async (_instance, state) =>
      new LeaseDO(state, { ...env, MANAGER_PROJECT_SLUG: '' }).create(objectRequest())
    );
    expect(result).toEqual({ status: 'unavailable', retryAfterSeconds: LEASE_RETRY_AFTER_SECONDS });
    expect(manager.calls).toEqual([]);
  });

  it('makes no lease for a request that reached the object after its budget', async () => {
    const manager = installLeaseManager();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await getLeaseStub(env, config).create(
      objectRequest({ requestedAt: Date.now() - LEASE_CREATE_BUDGET_MS - 1000 })
    );
    expect(result).toEqual({ status: 'unavailable', retryAfterSeconds: LEASE_RETRY_AFTER_SECONDS });
    expect(manager.calls).toEqual([]);
    expect(await leaseEvents()).toEqual([]);
  });

  it('revokes a lease whose creation outlasted the budget counted from the STS call', async () => {
    const manager = installLeaseManager();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The object took 15 seconds to start; Infisical then answers 6 seconds later. Only Date is
    // faked, so the RPC and the fake manager keep their real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const requestedAt = Date.now() - 15_000;
      manager.setOnCreate(() => vi.setSystemTime(Date.now() + 6_000));
      expect(await getLeaseStub(env, config).create(objectRequest({ requestedAt }))).toEqual({
        status: 'unavailable',
        retryAfterSeconds: LEASE_RETRY_AFTER_SECONDS,
      });
    } finally {
      vi.useRealTimers();
    }
    expect(manager.revokes()).toHaveLength(1);
    const events = await leaseEvents();
    expect(events.map(event => [event.type, event.data.attributes.cause])).toEqual([
      ['ai.kilo.sts.lease.revoked', 'late'],
    ]);
    // The undelivered lease holds no slot.
    manager.setOnCreate(() => {});
    issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    issued(await lease('bouncer-watch', { grant: 'replica-read' }));
  });
});

describe('revoke', () => {
  it('revokes only the caller’s own lease, once, and audits every refusal', async () => {
    const manager = installLeaseManager();
    const created = issued(await lease('bouncer-watch', { grant: 'replica-read' }));

    expect(await broker('replica-reader').revokeLease(created.leaseId)).toEqual({
      status: 'not_found',
    });
    const unknown = crypto.randomUUID();
    expect(await broker('bouncer-watch').revokeLease(unknown)).toEqual({ status: 'not_found' });
    expect(manager.revokes()).toEqual([]);

    expect(await broker('bouncer-watch').revokeLease(created.leaseId)).toEqual({
      status: 'revoked',
      leaseId: created.leaseId,
    });
    expect(manager.revokes()).toEqual([
      {
        method: 'DELETE',
        path: `/api/v1/dynamic-secrets/leases/${created.leaseId}`,
        body: {
          projectSlug: 'test-project',
          environmentSlug: 'development',
          path: '/dynamic/replica-read',
        },
      },
    ]);
    // Already revoked: the same answer, no second manager call, no second row.
    expect(await broker('bouncer-watch').revokeLease(created.leaseId)).toEqual({
      status: 'revoked',
      leaseId: created.leaseId,
    });
    expect(manager.revokes()).toHaveLength(1);
    expect(await broker('bouncer-watch').revokeLease('not-a-uuid')).toEqual({
      status: 'invalid_request',
    });

    const events = await leaseEvents();
    expect(events.map(event => event.type)).toEqual([
      'ai.kilo.sts.lease.created',
      'ai.kilo.sts.lease.revoked',
    ]);
    expect(events[1].data.attributes).toMatchObject({
      workload: 'bouncer-watch',
      leaseId: created.leaseId,
      cause: 'caller',
      result: 'revoked',
    });
    const denials = (await flushedDenials()).map(event => event.data.attributes);
    expect(denials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workload: 'replica-reader',
          reason: 'not_owner',
          leaseId: created.leaseId,
        }),
        expect.objectContaining({
          workload: 'bouncer-watch',
          reason: 'unknown_lease',
          leaseId: unknown,
        }),
      ])
    );
    expect(leaseRevokeResponse({ status: 'not_found' }).status).toBe(404);
  });

  it('frees the slot once a lease is revoked', async () => {
    installLeaseManager();
    const first = issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    expect(await lease('bouncer-watch', { grant: 'replica-read' })).toMatchObject({
      reason: 'too_many_active',
    });
    await broker('bouncer-watch').revokeLease(first.leaseId);
    issued(await lease('bouncer-watch', { grant: 'replica-read' }));
  });

  it('treats a lease Infisical no longer has as revoked, and keeps an active one when Infisical fails', async () => {
    const manager = installLeaseManager();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const created = issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    manager.setRevokeStatus(503);
    expect(await broker('bouncer-watch').revokeLease(created.leaseId)).toMatchObject({
      status: 'unavailable',
    });
    manager.setRevokeStatus(200);
    expect(await broker('bouncer-watch').revokeLease(created.leaseId)).toEqual({
      status: 'revoked',
      leaseId: created.leaseId,
    });
    const gone = issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    manager.setRevokeStatus(404);
    expect(await broker('bouncer-watch').revokeLease(gone.leaseId)).toEqual({
      status: 'revoked',
      leaseId: gone.leaseId,
    });
    const revoked = (await leaseEvents()).filter(
      event => event.type === 'ai.kilo.sts.lease.revoked'
    );
    expect(revoked.map(event => event.data.attributes.result)).toEqual([
      'revoke_failed',
      'revoked',
      'gone',
    ]);
  });

  it('stops a revocation as unconfirmed when Infisical answers 404 after a recorded failure', async () => {
    const manager = installLeaseManager();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const created = issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    manager.setRevokeStatus(503);
    await broker('bouncer-watch').revokeLease(created.leaseId);
    manager.setRevokeStatus(404);
    expect(await broker('bouncer-watch').revokeLease(created.leaseId)).toMatchObject({
      status: 'unavailable',
    });
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('the revocation is unconfirmed'),
      expect.objectContaining({ leaseId: created.leaseId })
    );
    // Stopped: neither a later revoke nor the alarm asks Infisical again or writes another row.
    expect(await broker('bouncer-watch').revokeLease(created.leaseId)).toMatchObject({
      status: 'unavailable',
    });
    await revocationsDue();
    await runDurableObjectAlarm(getLeaseStub(env, config));
    expect(manager.revokes()).toHaveLength(2);
    const revoked = (await leaseEvents()).filter(
      event => event.type === 'ai.kilo.sts.lease.revoked'
    );
    expect(revoked.map(event => [event.data.outcome, event.data.attributes.result])).toEqual([
      ['failure', 'revoke_failed'],
      ['failure', 'unconfirmed'],
    ]);
  });

  it('audits a revocation Infisical could not take once, and retries it from the alarm', async () => {
    const manager = installLeaseManager();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const created = issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    manager.setRevokeStatus(503);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await broker('bouncer-watch').revokeLease(created.leaseId)).toMatchObject({
        status: 'unavailable',
      });
    }
    const stub = getLeaseStub(env, config);
    await revocationsDue();
    await runDurableObjectAlarm(stub);
    expect(manager.revokes()).toHaveLength(3);
    manager.setRevokeStatus(200);
    await revocationsDue();
    await runDurableObjectAlarm(stub);
    expect(manager.revokes()).toHaveLength(4);
    const revoked = (await leaseEvents()).filter(
      event => event.type === 'ai.kilo.sts.lease.revoked'
    );
    expect(
      revoked.map(event => [
        event.data.outcome,
        event.data.attributes.cause,
        event.data.attributes.result,
      ])
    ).toEqual([
      ['failure', 'caller', 'revoke_failed'],
      ['success', 'caller', 'revoked'],
    ]);
    expect(await broker('bouncer-watch').revokeLease(created.leaseId)).toEqual({
      status: 'revoked',
      leaseId: created.leaseId,
    });
    await runDurableObjectAlarm(stub);
    expect(manager.revokes()).toHaveLength(4);
  });

  it('audits an undelivered lease Infisical could not revoke, and retries it from the alarm', async () => {
    const manager = installLeaseManager();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    manager.setExpirySkewMs(60 * 60 * 1000);
    manager.setRevokeStatus(503);
    expect(await lease('bouncer-watch', { grant: 'replica-read' })).toMatchObject({
      status: 'unavailable',
    });
    const events = await leaseEvents();
    expect(events.map(event => [event.type, event.data.outcomeDetail])).toEqual([
      ['ai.kilo.sts.lease.revoked', 'revoke_failed'],
    ]);
    expect(events[0].data.attributes).toMatchObject({
      cause: 'expiry_mismatch',
      result: 'revoke_failed',
    });
    const stub = getLeaseStub(env, config);
    expect(
      await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())
    ).not.toBeNull();
    manager.setRevokeStatus(200);
    await revocationsDue();
    await runDurableObjectAlarm(stub);
    expect(manager.revokes()).toHaveLength(2);
    expect((await leaseEvents()).map(event => event.data.attributes.result)).toEqual([
      'revoke_failed',
      'revoked',
    ]);
  });

  it('keeps retrying an owed revocation after the lease expired, then stops a day later with an unconfirmed row', async () => {
    const manager = installLeaseManager();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const created = issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    manager.setRevokeStatus(503);
    await broker('bouncer-watch').revokeLease(created.leaseId);
    const stub = getLeaseStub(env, config);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE lease SET expires_at = ?', Date.now() - 1000);
    });
    await revocationsDue();
    await runDurableObjectAlarm(stub);
    expect(manager.revokes()).toHaveLength(2);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('still unconfirmed after the lease expired'),
      expect.objectContaining({ workload: 'bouncer-watch', cause: 'caller' })
    );

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE lease SET expires_at = ?', Date.now() - 24 * 60 * 60 * 1000);
    });
    await revocationsDue();
    await runDurableObjectAlarm(stub);
    expect(manager.revokes()).toHaveLength(2);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('stopped retrying'),
      expect.objectContaining({ leaseId: created.leaseId })
    );
    await runDurableObjectAlarm(stub);
    const revoked = (await leaseEvents()).filter(
      event => event.type === 'ai.kilo.sts.lease.revoked'
    );
    expect(
      revoked.map(event => [
        event.data.outcome,
        event.data.outcomeDetail,
        event.data.attributes.result,
      ])
    ).toEqual([
      ['failure', 'revoke_failed', 'revoke_failed'],
      ['failure', 'unconfirmed', 'unconfirmed'],
    ]);
    const [row] = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ cause: string | null; ended: number | null; state: string }>(
          'SELECT revoke_cause AS cause, ended_at AS ended, state FROM lease'
        )
        .toArray()
    );
    expect(row).toMatchObject({ cause: null, state: 'unconfirmed' });
    expect(row.ended).not.toBeNull();
    // A later revoke answers without making the lease owed again, so no second unconfirmed row.
    manager.setRevokeStatus(503);
    expect(await broker('bouncer-watch').revokeLease(created.leaseId)).toMatchObject({
      status: 'unavailable',
    });
    await revocationsDue();
    await runDurableObjectAlarm(stub);
    expect(manager.revokes()).toHaveLength(2);
    expect(
      (await leaseEvents()).filter(event => event.type === 'ai.kilo.sts.lease.revoked')
    ).toHaveLength(2);
  });

  it('backs off 30 s when the unconfirmed row cannot be written, instead of an alarm every second', async () => {
    const manager = installLeaseManager();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const created = issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    manager.setRevokeStatus(503);
    await broker('bouncer-watch').revokeLease(created.leaseId);
    const stub = getLeaseStub(env, config);
    await runInDurableObject(stub, (instance, state) => {
      state.storage.sql.exec(
        'UPDATE lease SET expires_at = ?',
        Date.now() - 24 * 60 * 60 * 1000 - 1000
      );
      const { audit } = instance as unknown as { audit: { append: () => Promise<void> } };
      vi.spyOn(audit, 'append')
        .mockRejectedValueOnce(new Error('storage refused'))
        .mockRejectedValueOnce(new Error('storage refused'));
    });
    const nextAlarm = async (): Promise<number | null> =>
      await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await revocationsDue();
      await runDurableObjectAlarm(stub);
      expect(await nextAlarm()).toBeGreaterThan(Date.now() + 1_000);
    }
    await revocationsDue();
    await runDurableObjectAlarm(stub);
    expect(manager.revokes()).toHaveLength(1);
    expect(
      (await leaseEvents())
        .filter(event => event.type === 'ai.kilo.sts.lease.revoked')
        .map(event => event.data.attributes.result)
    ).toEqual(['revoke_failed', 'unconfirmed']);
  });

  it('keeps a revocation owed when Infisical answers 200 but its revocation statement failed, and keeps the database error out of logs and audit', async () => {
    const manager = installLeaseManager();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const created = issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    manager.setRevokeKept(true);
    expect(await broker('bouncer-watch').revokeLease(created.leaseId)).toMatchObject({
      status: 'unavailable',
    });
    // Infisical's own retry may have dropped the role meanwhile; the row it answers with still
    // carries the earlier status, so STS waits for the 404 that confirms the lease is gone.
    const stub = getLeaseStub(env, config);
    await revocationsDue();
    await runDurableObjectAlarm(stub);
    expect(manager.revokes()).toHaveLength(2);
    manager.setRevokeKept(false);
    manager.setRevokeStatus(404);
    await revocationsDue();
    await runDurableObjectAlarm(stub);
    expect(manager.revokes()).toHaveLength(3);
    const events = await leaseEvents();
    // A 404 after the recorded failure stays unconfirmed until the trial settles what it means.
    expect(
      events
        .filter(event => event.type === 'ai.kilo.sts.lease.revoked')
        .map(event => event.data.attributes.result)
    ).toEqual(['revoke_failed', 'unconfirmed']);
    expect(JSON.stringify(events)).not.toContain('synthetic-db-error');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('synthetic-db-error');
    manager.setRevokeStatus(200);
    expect(await broker('bouncer-watch').revokeLease(created.leaseId)).toMatchObject({
      status: 'unavailable',
    });
    expect(manager.revokes()).toHaveLength(3);
  });

  it('keeps a revocation owed on a 404 that is not about the lease, such as a missing folder', async () => {
    installLeaseManager();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const created = issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    const leaseFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return Response.json(
          {
            statusCode: 404,
            message:
              "Folder with path '/dynamic/replica-read' in environment with slug 'development' not found",
            error: 'NotFound',
          },
          { status: 404 }
        );
      }
      return await leaseFetch(input, init);
    });
    expect(await broker('bouncer-watch').revokeLease(created.leaseId)).toMatchObject({
      status: 'unavailable',
    });
    expect(
      (await leaseEvents())
        .filter(event => event.type === 'ai.kilo.sts.lease.revoked')
        .map(event => event.data.attributes.result)
    ).toEqual(['revoke_failed']);
  });

  it('leaves a lease to its caller for 30 s after the caller tried to revoke it', async () => {
    const manager = installLeaseManager();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const created = issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    manager.setRevokeStatus(503);
    await broker('bouncer-watch').revokeLease(created.leaseId);
    const stub = getLeaseStub(env, config);
    await runDurableObjectAlarm(stub);
    expect(manager.revokes()).toHaveLength(1);
    await revocationsDue();
    await runDurableObjectAlarm(stub);
    expect(manager.revokes()).toHaveLength(2);
  });

  it('waits out Infisical’s Retry-After on a 429 before the alarm retries', async () => {
    const manager = installLeaseManager();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const created = issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    manager.setRevokeStatus(429);
    const before = Date.now();
    await broker('bouncer-watch').revokeLease(created.leaseId);
    const stub = getLeaseStub(env, config);
    const [row] = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ at: number }>('SELECT revoke_retry_at AS at FROM lease').toArray()
    );
    expect(row.at).toBeGreaterThanOrEqual(before + 120_000);
    // 60 s later (past the 30 s retry, inside Retry-After): still not retried.
    await revocationsDue();
    await runDurableObjectAlarm(stub);
    expect(manager.revokes()).toHaveLength(1);
    await revocationsDue();
    await runDurableObjectAlarm(stub);
    expect(manager.revokes()).toHaveLength(2);
  });

  it('writes the revoke_failed row on a later failure when its first append failed', async () => {
    const manager = installLeaseManager();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const created = issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    manager.setRevokeStatus(503);
    const stub = getLeaseStub(env, config);
    await runInDurableObject(stub, instance => {
      const { audit } = instance as unknown as { audit: { append: () => Promise<void> } };
      vi.spyOn(audit, 'append').mockRejectedValueOnce(new Error('storage refused'));
    });
    await broker('bouncer-watch').revokeLease(created.leaseId);
    expect(
      (await leaseEvents()).filter(event => event.type === 'ai.kilo.sts.lease.revoked')
    ).toEqual([]);
    await revocationsDue();
    await runDurableObjectAlarm(stub);
    await revocationsDue();
    await runDurableObjectAlarm(stub);
    expect(manager.revokes()).toHaveLength(3);
    const revoked = (await leaseEvents()).filter(
      event => event.type === 'ai.kilo.sts.lease.revoked'
    );
    expect(revoked.map(event => event.data.attributes.result)).toEqual(['revoke_failed']);
  });

  it('retries every owed revocation when more than five keep failing', async () => {
    const manager = installLeaseManager();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stuck: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const created = issued(
        await lease('replica-reader', { grant: 'replica-read', ttlSeconds: 3600 })
      );
      manager.refuseRevokeOf(created.leaseId);
      await broker('replica-reader').revokeLease(created.leaseId);
      stuck.push(created.leaseId);
      if (index === 3) {
        // Past the per-minute cap and the active limit (a revoked-but-owed lease still counts).
        await runInDurableObject(getLeaseStub(env, config), (_instance, state) => {
          state.storage.sql.exec(
            "UPDATE lease SET created_at = created_at - 120000, workload = 'old-reader'"
          );
        });
      }
    }
    const newer = issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    manager.setRevokeStatus(503);
    await broker('bouncer-watch').revokeLease(newer.leaseId);
    manager.setRevokeStatus(200);
    const stub = getLeaseStub(env, config);
    for (let alarm = 0; alarm < 3; alarm += 1) {
      await revocationsDue();
      await runDurableObjectAlarm(stub);
    }
    expect(revokedIds(manager).filter(id => id === newer.leaseId).length).toBeGreaterThan(1);
    const states = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ lease_id: string; state: string }>('SELECT lease_id, state FROM lease')
        .toArray()
    );
    expect(states.find(row => row.lease_id === newer.leaseId)?.state).toBe('revoked');
    expect(stuck.every(id => revokedIds(manager).filter(call => call === id).length >= 2)).toBe(
      true
    );
  });

  it('asks Infisical about an expired lease of the caller, since expiry alone ends no open session', async () => {
    const manager = installLeaseManager();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const created = issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    await runInDurableObject(getLeaseStub(env, config), (_instance, state) => {
      state.storage.sql.exec('UPDATE lease SET expires_at = ?', Date.now() - 1000);
    });
    manager.setRevokeStatus(404);
    expect(await broker('bouncer-watch').revokeLease(created.leaseId)).toEqual({
      status: 'revoked',
      leaseId: created.leaseId,
    });
    expect(revokedIds(manager)).toEqual([created.leaseId]);
    expect(
      (await leaseEvents())
        .filter(event => event.type === 'ai.kilo.sts.lease.revoked')
        .map(event => event.data.attributes.result)
    ).toEqual(['gone']);
  });

  it('deletes lease rows a day after they ended', async () => {
    installLeaseManager();
    const created = issued(await lease('bouncer-watch', { grant: 'replica-read' }));
    await broker('bouncer-watch').revokeLease(created.leaseId);
    const stub = getLeaseStub(env, config);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE lease SET ended_at = ?', Date.now() - 25 * 60 * 60 * 1000);
    });
    await runDurableObjectAlarm(stub);
    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec('SELECT slot FROM lease').toArray()
    );
    expect(rows).toEqual([]);
  });
});

describe('HTTP lease', () => {
  let github: TestProvider;

  beforeAll(async () => {
    github = await createProvider(GITHUB_ISSUER, config.issuer);
  });

  const jobClaims = {
    sub: 'repo:acme@456/repo@123:environment:migrations',
    repository: 'acme/repo',
    repository_id: '123',
    repository_owner_id: '456',
    environment: 'migrations',
    ref: 'refs/heads/main',
    event_name: 'push',
    job_workflow_ref: DEPLOY_WORKFLOW,
    run_id: '777',
    run_attempt: '1',
  };

  async function post(path: string, body: string, token?: string): Promise<Response> {
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      passThroughOnException: () => undefined,
      props: {},
    };
    return await handleRequest(
      new Request(`${config.issuer}${path}`, {
        method: 'POST',
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        body,
      }),
      env,
      ctx as unknown as ExecutionContext,
      authority
    );
  }

  it('gives a GitHub job a ci-migration lease with the primary target, and revokes it', async () => {
    const manager = installLeaseManager(providerFetch([github]).fetch);
    const token = await signToken(github, jobClaims);
    const response = await post('/v1/lease', JSON.stringify({ grant: 'ci-migration' }), token);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = issued(LeaseResultSchema.parse(await response.json()));
    expect(result).toMatchObject({
      grant: 'ci-migration',
      ttlSeconds: 3600,
      host: 'db.sts-test.invalid',
      port: 5432,
      database: 'postgres',
    });
    expect(manager.creates()[0].body).toMatchObject({
      dynamicSecretName: 'ci-migration',
      path: '/dynamic/ci-migration',
      ttl: '3600s',
    });
    expect((await leaseEvents())[0].data.attributes).toMatchObject({
      workload: 'ci-migrate',
      identity: 'github',
      channel: 'http',
      grant: 'ci-migration',
      jobWorkflowRef: DEPLOY_WORKFLOW,
      runId: '777',
      runAttempt: '1',
    });

    const second = await post('/v1/lease', JSON.stringify({ grant: 'ci-migration' }), token);
    expect(second.status).toBe(429);

    const revoked = await post(
      '/v1/lease/revoke',
      JSON.stringify({ leaseId: result.leaseId }),
      await signToken(github, jobClaims)
    );
    expect(revoked.status).toBe(200);
    expect(LeaseRevokeResultSchema.parse(await revoked.json())).toEqual<LeaseRevokeResult>({
      status: 'revoked',
      leaseId: result.leaseId,
    });
  });

  it('lets only the job run that got a ci-migration lease revoke it', async () => {
    const manager = installLeaseManager(providerFetch([github]).fetch);
    const response = await post(
      '/v1/lease',
      JSON.stringify({ grant: 'ci-migration' }),
      await signToken(github, jobClaims)
    );
    const result = issued(LeaseResultSchema.parse(await response.json()));
    const otherRun = await post(
      '/v1/lease/revoke',
      JSON.stringify({ leaseId: result.leaseId }),
      await signToken(github, { ...jobClaims, run_id: '778' })
    );
    expect(otherRun.status).toBe(404);
    expect(manager.revokes()).toEqual([]);
    // A re-run attempt of the same run may revoke it.
    const sameRun = await post(
      '/v1/lease/revoke',
      JSON.stringify({ leaseId: result.leaseId }),
      await signToken(github, { ...jobClaims, run_attempt: '2' })
    );
    expect(sameRun.status).toBe(200);
    expect(manager.revokes()).toHaveLength(1);
    const denials = (await flushedDenials()).map(event => event.data.attributes);
    expect(denials).toEqual([
      expect.objectContaining({
        reason: 'other_run',
        workload: 'ci-migrate',
        leaseId: result.leaseId,
      }),
    ]);
  });

  it('refuses a missing token, a job of another workflow, a big body and a bad grant', async () => {
    const manager = installLeaseManager(providerFetch([github]).fetch);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await post('/v1/lease', '{"grant":"ci-migration"}')).status).toBe(401);
    const other = await signToken(github, {
      ...jobClaims,
      job_workflow_ref: 'acme/repo/.github/workflows/other.yml@refs/heads/main',
    });
    const refused = await post('/v1/lease', '{"grant":"ci-migration"}', other);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ status: 'denied', reason: 'identity_rejected' });
    const token = await signToken(github, jobClaims);
    expect((await post('/v1/lease', 'x'.repeat(2048), token)).status).toBe(413);
    expect((await post('/v1/lease', '{"grant":"replica-read"}', token)).status).toBe(403);
    expect((await post('/v1/lease', 'not json', token)).status).toBe(400);
    expect(manager.creates()).toEqual([]);
    const denials = (await flushedDenials()).map(event => event.data.attributes);
    expect(denials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'identity_rejected', channel: 'http' }),
        expect.objectContaining({
          reason: 'grant_not_allowed',
          workload: 'ci-migrate',
          grant: 'replica-read',
        }),
      ])
    );
  });
});
