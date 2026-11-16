import {
  buildEgressAuditRequest,
  GetEgressAuditResponseSchema,
} from '@kilocode/worker-utils/egress-audit';
import { EgressAuditStore } from '../../src/sandbox-containers/egress-audit.js';
import { env, reset, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEgressAdmissionCache } from '../../src/egress/egress-admission.js';
import { egressAuditStore } from '../../src/egress/sandbox-egress.js';
import { registerVercelEgressRoute } from '../../src/egress/vercel-egress-route.js';
import type { HonoContext } from '../../src/hono-context.js';
import type { Env } from '../../src/types.js';
import type { EgressAuditRequest } from '../../src/shared/egress-audit.js';
import {
  CurrentSessionMetadataSchema,
  type SessionMetadata,
} from '../../src/persistence/session-metadata.js';
import type { TRPCContext } from '../../src/types.js';
import type { SandboxContainers } from '../../src/sandbox-containers/SandboxContainers.js';

const access = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn(() => ({})) }));
vi.mock('@kilocode/worker-utils/cloud-agent-session-access', () => ({
  queryAccessibleCloudAgentSession: access.query,
}));

const { appRouter } = await import('../../src/router.js');

// A logical sandbox of a provider without a Containers allocation (for example Vercel).
const logicalSandboxId = 'ses-egress-store-0001';
const PREFIX = 'containers:egress-audit:chunk:';

function request(decision: EgressAuditRequest['decision']): EgressAuditRequest {
  return {
    requestId: crypto.randomUUID(),
    allocationRef: 'alloc-0001',
    timestamp: '2026-11-14T12:00:00.000Z',
    method: 'GET',
    hostname: 'example.com',
    protocol: 'https:',
    port: 443,
    decision,
  };
}

/**
 * Puts a stopped fake container on the store object and returns its `start`.
 * `SandboxContainers` starts a container only through `ctx.container.start`.
 */
async function watchContainerStart(store: DurableObjectStub<SandboxContainers>) {
  const start = vi.fn();
  await runInDurableObject(store, async (_instance, state) => {
    Object.defineProperty(state, 'container', {
      configurable: true,
      value: { running: false, start },
    });
  });
  return start;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});

describe('egress audit store of a logical sandbox', () => {
  it('preserves request and connection scope after storage reload and accepts historical rows', async () => {
    const store = egressAuditStore(env, { logicalSandboxId });
    const legacy = await store.recordEgressRequest(request('allowed'));
    const connection = await store.recordEgressRequest(
      buildEgressAuditRequest({
        ...request('allowed'),
        scope: 'connection',
        method: 'CONNECT',
        url: new URL('https://example.com/private?token=secret'),
      })
    );
    const http = await store.recordEgressRequest(
      buildEgressAuditRequest({
        ...request('denied'),
        method: 'POST',
        url: new URL('https://example.com/private?token=secret'),
      })
    );
    const page = await runInDurableObject(store, async (_instance, state) => {
      const reloaded = new EgressAuditStore(state.storage);
      return GetEgressAuditResponseSchema.parse(await reloaded.getEgressAudit());
    });
    expect(page.records).toEqual([legacy, connection, http]);
    expect(page.records.map(row => row.scope)).toEqual([undefined, 'connection', 'request']);
    expect(JSON.stringify(page)).not.toMatch(/private|token|secret/);
  });

  it('stores rows and starts no container, sets no alarm and writes nothing else', async () => {
    const store = egressAuditStore(env, { logicalSandboxId });
    const start = await watchContainerStart(store);
    const allowed = await store.recordEgressRequest(request('allowed'));
    const denied = await store.recordEgressRequest(request('denied'));
    await expect(store.getEgressAudit()).resolves.toEqual({
      records: [allowed, denied],
      nextCursor: null,
    });

    const sameObject = egressAuditStore(env, {
      containerId: env.SANDBOX_CONTAINERS.idFromName(logicalSandboxId).toString(),
    });
    await expect(sameObject.getEgressAudit()).resolves.toEqual({
      records: [allowed, denied],
      nextCursor: null,
    });

    expect(start).not.toHaveBeenCalled();
    await runInDurableObject(store, async (_instance, state) => {
      await expect(state.storage.getAlarm()).resolves.toBeNull();
      const keys = [...(await state.storage.list()).keys()];
      expect(keys).toEqual([`${PREFIX}0000000000000000`]);
    });
  });

  it('stores rows written through the real egress route of a restricted sandbox', async () => {
    const store = egressAuditStore(env, { logicalSandboxId });
    const start = await watchContainerStart(store);
    const upstream = vi.fn(async (_request: Request) => new Response('listed'));
    vi.stubGlobal('fetch', upstream);
    const app = new Hono<HonoContext>();
    registerVercelEgressRoute(app, {
      admitEgress: createEgressAdmissionCache(),
      admitScm: async () => ({ ok: false, status: 403, code: 'credential_denied' }),
    });
    // The admission is faked here; its own tests cover the identity check.
    const bindings = {
      ...env,
      SANDBOX_CONTROL: {
        getByName: () => ({
          admitEgressForward: async () => ({
            ok: true,
            policy: { allowlist: ['example.com'], audit: { allocationRef: 'alloc-0001' } },
            expiresAt: Date.now() + 60_000,
          }),
        }),
      },
    } as unknown as Env;
    const send = (host: string) =>
      app.fetch(
        new Request(`https://worker.test/scm/vercel/${logicalSandboxId}`, {
          headers: {
            'vercel-forwarded-host': host,
            'vercel-forwarded-scheme': 'https',
            'vercel-forwarded-port': '443',
            'vercel-forwarded-path': '/',
            'vercel-sandbox-oidc-token': 'synthetic-oidc-token',
          },
        }),
        bindings
      );
    expect((await send('example.com')).status).toBe(200);
    expect((await send('unlisted.example')).status).toBe(403);
    expect(upstream).toHaveBeenCalledOnce();

    const audit = await store.getEgressAudit();
    expect(audit.records.map(record => [record.hostname, record.decision])).toEqual([
      ['example.com', 'allowed'],
      ['unlisted.example', 'denied'],
    ]);
    expect(start).not.toHaveBeenCalled();
    await runInDurableObject(store, async (_instance, state) => {
      await expect(state.storage.getAlarm()).resolves.toBeNull();
      expect([...(await state.storage.list()).keys()]).toEqual([`${PREFIX}0000000000000000`]);
    });
  });

  it('reads the rows of a restricted Vercel session through the real audit handler', async () => {
    const sandboxId = 'ses-0123456789abcdef0123456789abcdef0123456789abcdef';
    const userId = 'oauth/google:audit-owner';
    const sessionId = 'workspace_12345678-1234-4234-9234-123456789abc';
    access.query.mockResolvedValue({ kiloSessionId: 'kilo_root', organizationId: null });
    const metadata: SessionMetadata = CurrentSessionMetadataSchema.parse({
      metadataSchemaVersion: 2,
      identity: { userId, sessionId },
      auth: { kiloSessionId: 'kilo_root' },
      workspace: {
        sandboxId,
        sandboxProvider: 'vercel',
        egressMode: 'allowlist',
        egressAllowlist: ['example.com'],
        egressAudit: true,
      },
      lifecycle: { version: 1, timestamp: 1 },
    });
    const store = egressAuditStore(env, { logicalSandboxId: sandboxId });
    const start = await watchContainerStart(store);
    const allowed = await store.recordEgressRequest(request('allowed'));
    const denied = await store.recordEgressRequest(request('denied'));

    const sessionStub = { getMetadata: async () => metadata };
    const context = {
      userId,
      authToken: 'synthetic-token',
      request: new Request('https://worker.test/trpc'),
      env: {
        ...env,
        HYPERDRIVE: { connectionString: 'postgresql://test' },
        SANDBOX_SESSION: { idFromName: (name: string) => name, get: () => sessionStub },
      },
    } as unknown as TRPCContext;
    await expect(
      appRouter.createCaller(context).getEgressAudit({ cloudAgentSessionId: sessionId })
    ).resolves.toEqual({ records: [allowed, denied], nextCursor: null });
    expect(access.query).toHaveBeenCalledOnce();

    expect(start).not.toHaveBeenCalled();
    await runInDurableObject(store, async (_instance, state) => {
      await expect(state.storage.getAlarm()).resolves.toBeNull();
      expect([...(await state.storage.list()).keys()]).toEqual([`${PREFIX}0000000000000000`]);
    });
  });
});
