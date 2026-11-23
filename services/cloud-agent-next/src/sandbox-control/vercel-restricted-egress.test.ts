import { describe, expect, it } from 'vitest';
import type {
  VercelSandboxCreateEnvelope,
  VercelSandboxNetworkPolicy,
  VercelSandboxSession,
} from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import type { VercelSandboxRuntimeConfig } from '../agent-sandbox/vercel/vercel-runtime-config.js';
import { buildNativeEgressAllowlist } from './egress-policy.js';
import { SandboxNetworkPolicyError } from './provider.js';
import {
  buildControlCredentialPolicy,
  prepareCredentialGrant,
  type CredentialGrantPreparation,
  type SessionCredentialGrant,
} from './session-credentials.js';
import { restrictVercelEgress } from './vercel-network-policy.js';
import {
  createVercelProviderAdapter,
  encodeVercelProviderRef,
  type VercelControlRestClient,
} from './vercel-provider.js';

const SANDBOX = 'ses-abc0001';
const WORKER = 'https://worker.example.com';
const FORWARD = `${WORKER}/scm/vercel/${SANDBOX}`;
const env = {
  WORKER_URL: WORKER,
  KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.example',
  KILO_OPENROUTER_BASE: 'https://api.kilo.example/api/openrouter',
  KILO_SESSION_INGEST_URL: 'https://ingest.kilo.example',
};
const kiloToken = 'eyJhbGciOiJub25lIn0.eyJydW50aW1lQXV0aG9yaXphdGlvbiI6eyJpZCI6InJhXzEifX0.c2ln';
const config: VercelSandboxRuntimeConfig = {
  accessToken: 'token',
  teamId: 'team',
  projectId: 'project',
  snapshotId: 'snapshot',
  runtimeBuildId: 'build',
  runtime: 'node24',
  initialTimeoutMs: 60_000,
  extendDurationMs: 60_000,
};

async function grant(): Promise<SessionCredentialGrant> {
  const { grant } = await prepareCredentialGrant({
    env: env as CredentialGrantPreparation['env'],
    source: {
      userId: 'user-1',
      kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      kiloToken,
      repository: { type: 'git', url: 'https://github.com/acme/widgets.git' },
      scopeId: 'workspace_11111111-1111-4111-8111-111111111111',
    },
    sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
    sandboxId: SANDBOX,
    provider: 'vercel',
    outboundContainerId: 'allocation-binding',
    containmentEnabled: true,
    directory: '/workspace/test',
    scopeId: 'workspace_11111111-1111-4111-8111-111111111111',
    payload: {},
    now: 1_000,
  });
  return grant;
}

/** An accepted runtime-proxy handle, so the grant has its credential rules. */
function handles(value: SessionCredentialGrant): ReadonlyMap<string, readonly string[]> {
  return new Map([[value.scopeId, ['adopted-handle']]]);
}

function allowlist(extra: string[] = ['example.com']): string[] {
  return buildNativeEgressAllowlist({ allowlist: extra, env, kiloToken });
}

function harness(restricted: { allowlist: readonly string[]; logicalSandboxId: string }) {
  const created: VercelSandboxNetworkPolicy[] = [];
  const updated: VercelSandboxNetworkPolicy[] = [];
  const session = {
    id: 'session-1',
    sourceSandboxName: SANDBOX,
    status: 'running',
  } as VercelSandboxSession;
  const restClient = {
    createSandbox: async input => {
      created.push(input.networkPolicy!);
      return {
        sandbox: {} as never,
        session,
        routes: [],
        runtime: { sandboxName: input.name, sessionId: 'session-1' },
      } satisfies VercelSandboxCreateEnvelope;
    },
    updateNetworkPolicy: async (_sessionId, _sandboxName, policy) => {
      updated.push(policy);
      return session;
    },
  } as Partial<VercelControlRestClient> as VercelControlRestClient;
  return {
    created,
    updated,
    adapter: (grants: readonly SessionCredentialGrant[], adapterEnv = env) =>
      createVercelProviderAdapter({
        sandboxName: SANDBOX,
        env: adapterEnv,
        config,
        restClient,
        restrictedEgress: restricted,
        readContainedGrants: async () => grants,
        readAcceptedRuntimeProxyHandles: async () =>
          grants[0] === undefined ? new Map() : handles(grants[0]),
      }),
  };
}

const intent = { intentId: 'intent-1', allocationName: SANDBOX } as Parameters<
  ReturnType<typeof createVercelProviderAdapter>['create']
>[0];

describe('restricted Vercel egress policy', () => {
  it('has the list as keys, no wildcard, the Worker host pinned and every other host forwarded', async () => {
    const list = allowlist();
    const value = await grant();
    const policy = restrictVercelEgress(
      buildControlCredentialPolicy([value], handles(value)),
      list,
      {
        forwardURL: FORWARD,
        workerHost: 'worker.example.com',
      }
    );
    expect(policy).not.toBeNull();
    expect(Object.keys(policy!.allow)).toEqual(list);
    expect(policy!.allow['*']).toBeUndefined();
    for (const [host, rules] of Object.entries(policy!.allow)) {
      const last = rules.at(-1);
      expect(last).toEqual(
        host === 'worker.example.com'
          ? { transform: [{ headers: { host: 'worker.example.com' } }] }
          : { forwardURL: FORWARD }
      );
      expect(rules.slice(0, -1).every(rule => 'match' in rule)).toBe(true);
    }
    // The runtime facade and Session Sync keep their credential rules first.
    expect(policy!.allow['worker.example.com'].length).toBeGreaterThan(1);
    expect(policy!.allow['session-sync.kiloapps.io'].length).toBeGreaterThan(1);
  });

  it('keeps every credential rule of a realistic grant inside the effective list', async () => {
    const value = await grant();
    const credentials = buildControlCredentialPolicy([value], handles(value));
    expect(Object.keys(credentials.allow).sort()).toEqual([
      'session-sync.kiloapps.io',
      'worker.example.com',
    ]);
    const list = allowlist([]);
    for (const host of Object.keys(credentials.allow)) expect(list).toContain(host);
  });

  it('drops forward entries of the input and forwards once, last', () => {
    const match = { headers: [{ key: { exact: 'a' }, value: { exact: 'b' } }] };
    const policy = restrictVercelEgress(
      {
        allow: {
          'github.com': [
            { forwardURL: 'https://stale.example/forward' },
            { match, transform: [{ headers: { authorization: 'x' } }] },
          ],
        },
      },
      ['github.com'],
      { forwardURL: FORWARD, workerHost: 'worker.example.com' }
    );
    expect(policy).toEqual({
      allow: {
        'github.com': [
          { match, transform: [{ headers: { authorization: 'x' } }] },
          { forwardURL: FORWARD },
        ],
      },
    });
  });

  it.each([
    ['a credential rule host outside the list', ['example.com']],
    ['a wildcard entry', ['*', 'worker.example.com']],
    ['a non-canonical entry', ['Worker.Example.com']],
  ])('cannot be built with %s', (_name, list) => {
    expect(
      restrictVercelEgress({ allow: { 'worker.example.com': [] } }, list, {
        forwardURL: FORWARD,
        workerHost: 'worker.example.com',
      })
    ).toBeNull();
  });
});

describe('Vercel adapter with an egress allowlist', () => {
  it('creates and refreshes with a restricted policy that never has the wildcard', async () => {
    const list = allowlist();
    const h = harness({ allowlist: list, logicalSandboxId: SANDBOX });
    const grants = [await grant()];
    const adapter = h.adapter(grants);
    const created = await adapter.create(intent);
    if (!('providerRef' in created)) throw new Error('create did not return a provider ref');
    const providerRef = created.providerRef;
    await adapter.applyContainedCredentials!(providerRef, grants);
    await adapter.applyContainedCredentials!(providerRef, []);
    expect(h.created).toHaveLength(1);
    expect(h.updated).toHaveLength(2);
    for (const policy of [...h.created, ...h.updated]) {
      expect(policy.allow['*']).toBeUndefined();
      expect(Object.keys(policy.allow)).toEqual(list);
      expect(policy.allow['example.com']).toEqual([{ forwardURL: FORWARD }]);
    }
    expect(h.created[0]).toEqual(
      restrictVercelEgress(buildControlCredentialPolicy(grants, handles(grants[0])), list, {
        forwardURL: FORWARD,
        workerHost: 'worker.example.com',
      })
    );
  });

  it.each([
    ['the list misses the Worker host', () => ['example.com'], env],
    ['no Worker URL is configured', () => allowlist(), { ...env, WORKER_URL: '' }],
  ])('creates no sandbox when %s', async (_name, list, adapterEnv) => {
    const h = harness({ allowlist: list(), logicalSandboxId: SANDBOX });
    const adapter = h.adapter([await grant()], adapterEnv);
    const failure = adapter.create(intent);
    await expect(failure).rejects.toBeInstanceOf(SandboxNetworkPolicyError);
    await expect(failure).rejects.toMatchObject({ reason: 'network_policy_failed' });
    expect(h.created).toHaveLength(0);
  });

  it('refuses a refresh whose policy cannot be built and sends no update', async () => {
    const h = harness({ allowlist: ['example.com'], logicalSandboxId: SANDBOX });
    const adapter = h.adapter([]);
    const ref = encodeVercelProviderRef({ sandboxName: SANDBOX, sessionId: 'session-1' });
    await expect(adapter.applyContainedCredentials!(ref, [await grant()])).rejects.toBeInstanceOf(
      SandboxNetworkPolicyError
    );
    expect(h.updated).toHaveLength(0);
  });
});
