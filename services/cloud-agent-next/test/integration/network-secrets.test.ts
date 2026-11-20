import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { eq } from 'drizzle-orm';
import { networkSecretFixture } from '../helpers/network-secrets.js';
import { ContainersOutbound } from '../../src/sandbox-containers/containers-outbound.js';
import { admitNetworkSecretCredential } from '../../src/network-secrets/admission.js';
import { networkSecretSnapshot } from '../../src/control-plane/sandbox/network-secret-snapshot.js';
import { readRoute, writeRoute } from '../../src/control-plane/sandbox/routes.js';
import { networkSecretSnapshots } from '../../src/control-plane/sandbox/sqlite-schema.js';
import {
  retireScopeGrants,
  writeScopeGrant,
} from '../../src/control-plane/sandbox/scope-grants.js';

afterEach(() => vi.unstubAllGlobals());

describe('network secrets in Workers', () => {
  it('fails preparation immediately for a configured SCM destination', async () => {
    const fixture = await networkSecretFixture();
    const stub = env.SANDBOX_CONTROL.getByName(`ses-${crypto.randomUUID().replaceAll('-', '')}`);
    const result = await stub.prepare({
      spec: {
        sessionId: fixture.preparation.sessionId,
        kiloSessionId: fixture.preparation.source.kiloSessionId,
        attemptId: crypto.randomUUID(),
        directory: '/workspace/test',
      },
      credentials: {
        ...fixture.preparation.source,
        repository: { type: 'gitlab', url: 'https://gitlab.example.com/team/repository.git' },
        networkSecrets: {
          SERVICE_TOKEN: {
            ...fixture.snapshot.SERVICE_TOKEN,
            allowedHosts: ['gitlab.example.com'],
            locations: ['header'],
          },
        },
      },
      sandboxSelection: { provider: 'cloudflare-containers' },
    });
    expect(result).toMatchObject({
      state: 'failed',
      reason: 'network_secret_configuration_invalid',
    });
  });
  it('substitutes, refuses a wrong host, records safe audit decisions, and does not follow redirects', async () => {
    const fixture = await networkSecretFixture();
    const audits: unknown[] = [];
    const workerEnv = {
      ...env,
      SANDBOX_CONTROL: {
        getByName: () => ({
          resolveCredential: (input: {
            credential: string;
            outboundContainerId: string;
            url: string;
          }) =>
            admitNetworkSecretCredential(
              input.credential,
              {
                ...fixture.deps,
                authenticate: async () =>
                  input.outboundContainerId === fixture.context.outboundContainerId
                    ? { ok: true, isCurrent: () => true }
                    : { ok: false, status: 403, code: 'invalid_identity' },
              },
              fixture.privateKeyPem,
              [],
              input.url
            ),
        }),
      },
      SANDBOX_CONTAINERS: {
        idFromString: (id: string) => id,
        get: () => ({
          recordEgressRequest: async (input: unknown) => {
            audits.push(input);
          },
        }),
      },
    } as unknown as Cloudflare.Env;
    const worker = new ContainersOutbound(
      Object.assign(createExecutionContext(), {
        props: {
          containerId: 'synthetic-container',
          allocationRef: 'synthetic-allocation',
          egressAudit: true,
          egressAllowlist: ['api.example.com', 'other.example.com'],
        },
      }),
      workerEnv
    );
    const upstream = vi.fn(async (request: Request) => {
      expect(request.headers.get('authorization')).toBe(`Bearer ${fixture.value}`);
      expect(request.redirect).toBe('manual');
      return new Response('match', {
        status: 307,
        headers: { location: 'https://other.example.com/' },
      });
    });
    vi.stubGlobal('fetch', upstream);
    const response = await worker.fetch(
      new Request('https://api.example.com/path?private=query', {
        headers: { authorization: `Bearer ${fixture.alias}` },
      })
    );
    expect(response.status).toBe(307);
    expect(await response.text()).toBe('match');
    const denied = await worker.fetch(
      new Request('https://other.example.com/path?private=query', {
        headers: { authorization: `Bearer ${fixture.alias}` },
      })
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: 'network_secret_host_mismatch',
      key: 'SERVICE_TOKEN',
      host: 'other.example.com',
    });
    expect(upstream).toHaveBeenCalledOnce();
    expect(audits).toEqual([
      expect.objectContaining({
        credentialKey: 'SERVICE_TOKEN',
        credentialDecision: 'substituted',
        decision: 'allowed',
      }),
      expect.objectContaining({
        credentialKey: 'SERVICE_TOKEN',
        credentialDecision: 'denied_host_mismatch',
        decision: 'denied',
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain(fixture.alias);
    expect(JSON.stringify(audits)).not.toContain(fixture.value);
    expect(JSON.stringify(audits)).not.toContain('private=query');
  });
  it('keeps the workspace snapshot and aliases after active grants retire', async () => {
    const fixture = await networkSecretFixture();
    const stub = env.SANDBOX_CONTROL.getByName('ses-network-persisted-fixture');
    const first = await runInDurableObject(stub, async (instance, state) => {
      await instance.resolveCredential({
        credential: 'invalid',
        outboundContainerId: 'none',
        url: 'https://api.example.com',
        method: 'GET',
      });
      const db = drizzle(state.storage);
      const snapshot = networkSecretSnapshot(db, {
        scopeId: 'synthetic-workspace',
        sandboxId: 'ses-network-persisted-fixture',
        secrets: fixture.snapshot,
        excludedUrls: [],
      });
      writeScopeGrant(db, fixture.grant);
      retireScopeGrants(db, state.storage.kv);
      return snapshot;
    });
    const second = await runInDurableObject(stub, async (_instance, state) =>
      networkSecretSnapshot(drizzle(state.storage), {
        scopeId: 'synthetic-workspace',
        sandboxId: 'ses-network-persisted-fixture',
        secrets: {},
        excludedUrls: [],
      })
    );
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).not.toContain(fixture.value);
  });
  it('keeps a standalone snapshot through route release and removes it on session deletion', async () => {
    const fixture = await networkSecretFixture();
    const sandboxId = `ses-${crypto.randomUUID().replaceAll('-', '')}`;
    const sessionId = fixture.preparation.sessionId;
    const stub = env.SANDBOX_CONTROL.getByName(sandboxId);
    const readSnapshot = () =>
      runInDurableObject(stub, (_instance, state) =>
        drizzle(state.storage)
          .select()
          .from(networkSecretSnapshots)
          .where(eq(networkSecretSnapshots.scope_id, sessionId))
          .get()
      );
    const first = await runInDurableObject(stub, async (instance, state) => {
      await instance.resolveCredential({
        credential: 'invalid',
        outboundContainerId: 'none',
        url: 'https://api.example.com',
        method: 'GET',
      });
      const db = drizzle(state.storage);
      writeRoute(db, {
        sessionId,
        spec: {
          sessionId,
          kiloSessionId: fixture.preparation.source.kiloSessionId,
          directory: '/workspace/test',
          attemptId: 'attempt-1',
        },
        grant: null,
        credentialSource: { ...fixture.preparation.source, scopeId: sessionId },
        environment: null,
        state: 'ready',
        attemptId: 'attempt-1',
        attemptDeadlineAt: 0,
        reason: null,
      });
      expect((await readRoute(db, sessionId))?.credentialSource?.scopeId).toBe(sessionId);
      return networkSecretSnapshot(db, {
        scopeId: sessionId,
        sandboxId,
        secrets: fixture.snapshot,
        excludedUrls: [],
      });
    });
    expect(first).toHaveLength(1);

    await stub.release({ sessionId });
    const afterRelease = await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage);
      expect(await readRoute(db, sessionId)).toBeNull();
      return networkSecretSnapshot(db, {
        scopeId: sessionId,
        sandboxId,
        secrets: {},
        excludedUrls: [],
      });
    });
    expect(afterRelease).toEqual(first);

    await stub.release({ sessionId, reason: 'standalone_session_deleted' });
    expect(await readSnapshot()).toBeUndefined();
  });
});
