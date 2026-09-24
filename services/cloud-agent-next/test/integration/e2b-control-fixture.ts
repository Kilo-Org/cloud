import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { expect, vi } from 'vitest';
import {
  fetchByocE2BCredential,
  resolveByocE2BApiKey,
} from '../../src/byoc/e2b-credential-resolver.js';
import { createE2BControlAdapter } from '../../src/sandbox-control/e2b-provider.js';
import { encodeE2BProviderRef } from '../../src/sandbox-control/e2b-runtime.js';
import type { AllocationRecord } from '../../src/sandbox-state/model/allocation.js';
import type { ProviderAdapter, ProviderCreateIntent } from '../../src/sandbox-control/provider.js';
import type { SessionMetadata } from '../../src/persistence/session-metadata.js';
import type { SandboxSession } from '../../src/sandbox-session/SandboxSession.js';

export const E2B_TEST_BINDING = {
  kind: 'e2b',
  organizationId: '11111111-1111-4111-8111-111111111111',
  credentialId: '22222222-2222-4222-8222-222222222222',
} as const;
export const E2B_TEST_ENV = {
  WORKER_URL: 'https://worker.test',
  KILOCODE_BACKEND_BASE_URL: 'https://backend.example.test',
  KILO_OPENROUTER_BASE: 'https://provider.example.test/api/openrouter',
  KILO_SESSION_INGEST_URL: 'https://ingest.example.test',
  E2B_SANDBOX_TEMPLATE: 'kilo/kilo-cloud-agent:33333333-3333-4333-8333-333333333333',
  E2B_SANDBOX_TEMPLATE_ID: 'templateid',
  E2B_SANDBOX_RUNTIME_BUILD_ID: 'e2b-runtime-build',
};
export const E2B_TEST_ACCOUNT_KEY = 'fixture-customer-e2b-account-key';
export const E2B_TEST_KILO_TOKEN = 'fixture-direct-kilo-token';
export const E2B_TEST_NATIVE_ID = 'ses_abcdefghijklmnopqrstuvwxyz';

type Registration = Omit<Parameters<SandboxSession['registerSession']>[0], 'workspace'> & {
  workspace: NonNullable<SessionMetadata['workspace']>;
};

export async function e2bControlFixture() {
  const sandboxId = `ses-${crypto.randomUUID().replaceAll('-', '')}`;
  const control = env.SANDBOX_CONTROL.getByName(sandboxId);
  const registration: Registration = {
    identity: {
      sessionId: `workspace_${crypto.randomUUID()}`,
      userId: 'oauth/e2b-test',
      orgId: E2B_TEST_BINDING.organizationId,
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId: E2B_TEST_NATIVE_ID, kilocodeToken: E2B_TEST_KILO_TOKEN },
    agent: { mode: 'code', model: 'test' },
    workspace: {
      sandboxId,
      sandboxProvider: 'e2b',
      sandboxProviderBinding: E2B_TEST_BINDING,
      workspacePath: '/workspace/e2b-test',
      credentialContainment: { github: false, gitlab: false, bitbucket: false, kilocode: false },
    },
  };
  vi.mocked(fetchByocE2BCredential).mockResolvedValue({
    organizationId: E2B_TEST_BINDING.organizationId,
    credentialId: E2B_TEST_BINDING.credentialId,
    consentVersion: 'e2b-direct-v1',
    consentedAt: '2026-09-03T00:00:00.000Z',
    validatedAt: '2026-09-03T00:00:00.000Z',
    createdAt: '2026-09-03T00:00:00.000Z',
    apiKeyEncrypted: {
      scheme: 'byoc-e2b-credential-rsa-aes-256-gcm',
      version: 1,
      keyId: 'agent-env-vars-v1',
      ciphertext: {
        encryptedData: 'fixture-data',
        encryptedDEK: 'fixture-key',
        algorithm: 'rsa-aes-256-gcm',
        version: 1,
      },
    },
  });
  vi.mocked(resolveByocE2BApiKey).mockResolvedValue(E2B_TEST_ACCOUNT_KEY);
  let readAllocation: () => Promise<AllocationRecord> = async () => {
    throw new Error('Fixture control was not initialized');
  };
  let providerRef: string | undefined;
  let exists = false;
  const launches: Record<string, string>[] = [];
  const provider = {
    resumable: false,
    persistentWorkspace: false,
    destroysOnStop: true,
    ensureBillingAdmission: vi.fn(async () => undefined),
    create: vi.fn<ProviderAdapter['create']>(async (intent: ProviderCreateIntent) => {
      const saved = await readAllocation();
      if (saved.state.kind !== 'creating') throw new Error('Expected a creating allocation');
      expect(saved.state.target.e2b?.submissionState).toBe('submitted');
      expect(saved.state.createIntent.intentId).toBe(intent.intentId);
      expect(saved.state.target.providerRef).toBeNull();
      providerRef = encodeE2BProviderRef({
        physicalId: `test${crypto.randomUUID().replaceAll('-', '')}`,
        intentId: intent.intentId,
      });
      exists = true;
      return { providerRef };
    }),
    launch: vi.fn(async (ref: string, launchEnv: Record<string, string>) => {
      const saved = await readAllocation();
      const savedRef = saved.state.kind === 'stopped' ? null : (saved.state.target?.providerRef ?? null);
      expect(savedRef).toBe(ref);
      expect(JSON.stringify(launchEnv)).not.toContain(E2B_TEST_ACCOUNT_KEY);
      launches.push({ ...launchEnv, PROVIDER_INSTANCE_ID: ref });
    }),
    observe: vi.fn<ProviderAdapter['observe']>(async ref => {
      if (ref) return { status: exists ? 'active' : 'terminal' };
      return exists && providerRef ? { status: 'active', providerRef } : { status: 'unknown' };
    }),
    stop: vi.fn<ProviderAdapter['stop']>(async ref => {
      if (!ref) return 'retryable';
      expect(ref).toBe(providerRef);
      exists = false;
      return 'terminal';
    }),
    ensureLeaseAtLeast: vi.fn(async () => undefined),
    logs: vi.fn(async () => 'Guest logs withheld'),
  } satisfies ProviderAdapter;
  vi.mocked(createE2BControlAdapter).mockImplementation(deps => ({
    ...provider,
    create: async intent => {
      await deps.resolveApiKey(deps.binding);
      if (!deps.submitCreateIntent) throw new Error('Missing fixture submission authority');
      await deps.submitCreateIntent();
      return provider.create(intent);
    },
  }));
  await runInDurableObject(control, instance => {
    Object.assign(instance['env'], E2B_TEST_ENV);
    readAllocation = () => instance.getAllocationRecord();
  });
  const session = env.SANDBOX_SESSION.getByName(
    `${registration.identity.userId}:${registration.identity.sessionId}`
  );
  await expect(session.registerSession(registration)).resolves.toEqual({ success: true });
  const input = {
    ownerId: registration.identity.userId,
    sessionId: registration.identity.sessionId,
    providerBinding: E2B_TEST_BINDING,
    acquisition: { id: crypto.randomUUID(), deadlineAt: Date.now() + 120_000 },
  };
  return { sandboxId, control, session, registration, provider, launches, input };
}

export type E2BControlFixture = Awaited<ReturnType<typeof e2bControlFixture>>;

export async function connectE2BTestWrapper(fixture: E2BControlFixture) {
  const launch = fixture.launches.at(-1);
  if (!launch) throw new Error('Missing fixture launch');
  const response = await SELF.fetch(`https://worker.test/sandbox-control/${fixture.sandboxId}`, {
    headers: { Upgrade: 'websocket', Authorization: `Bearer ${launch.SANDBOX_CONTROL_CREDENTIAL}` },
  });
  if (response.status !== 101 || !response.webSocket)
    throw new Error('Fixture websocket upgrade failed');
  const socket = response.webSocket;
  socket.accept();
  const wrapperInstanceId = crypto.randomUUID();
  const hello = new Promise<unknown>((resolve, reject) => {
    socket.addEventListener(
      'message',
      event => {
        if (typeof event.data !== 'string')
          return reject(new Error('Invalid fixture hello response'));
        try {
          resolve(JSON.parse(event.data));
        } catch {
          reject(new Error('Invalid fixture hello JSON'));
        }
      },
      { once: true }
    );
    socket.addEventListener('error', () => reject(new Error('Fixture websocket error')), {
      once: true,
    });
  });
  socket.send(
    JSON.stringify({
      type: 'request',
      requestId: 'e2b-test-hello',
      operation: 'sandbox.hello',
      payload: {
        protocolVersion: 1,
        wrapperVersion: '2.4.0',
        providerInstanceId: launch.PROVIDER_INSTANCE_ID,
        wrapperInstanceId,
      },
    })
  );
  await expect(hello).resolves.toMatchObject({
    type: 'response',
    requestId: 'e2b-test-hello',
    ok: true,
  });
  socket.send(
    JSON.stringify({
      type: 'event',
      event: 'sandbox.ready',
      payload: { kiloReady: true, globalFeedAttached: true },
    })
  );
  await vi.waitFor(async () => {
    await expect(fixture.control.getStatus()).resolves.toMatchObject({
      connection: 'ready',
      wrapperInstanceId,
    });
  });
  return { socket, wrapperInstanceId };
}
