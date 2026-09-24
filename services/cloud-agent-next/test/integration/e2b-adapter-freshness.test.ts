import { abortAllDurableObjects, env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchByocE2BCredential,
  resolveByocE2BApiKey,
} from '../../src/byoc/e2b-credential-resolver.js';
import {
  createE2BSandbox,
  getE2BSandbox,
  killE2BSandbox,
  listE2BSandboxes,
  setE2BSandboxTimeout,
  type E2BSandboxDetail,
} from '../../src/sandbox-control/e2b-api.js';
import { launchE2BWrapper } from '../../src/sandbox-control/e2b-envd.js';
import { e2bCreateMetadata, parseE2BProviderRef } from '../../src/sandbox-control/e2b-runtime.js';
import type { E2BAllocationConfig } from '../../src/sandbox-state/model/allocation.js';
import type { SessionMetadata } from '../../src/persistence/session-metadata.js';
import type { SandboxSession } from '../../src/sandbox-session/SandboxSession.js';
import {
  connectE2BTestWrapper,
  E2B_TEST_ACCOUNT_KEY,
  E2B_TEST_BINDING,
  E2B_TEST_ENV,
  E2B_TEST_KILO_TOKEN,
  E2B_TEST_NATIVE_ID,
  type E2BControlFixture,
} from './e2b-control-fixture.js';

// Unlike the other E2B coordinator tests this one keeps the real
// `createE2BControlAdapter`: the defect it guards is SandboxControl rebuilding a
// fresh, submission-capable adapter for lease renewal and stop, which a mocked
// adapter cannot observe.
vi.mock('../../src/byoc/e2b-credential-resolver.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/byoc/e2b-credential-resolver.js')>()),
  fetchByocE2BCredential: vi.fn(),
  resolveByocE2BApiKey: vi.fn(),
}));
vi.mock('../../src/sandbox-control/e2b-api.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/sandbox-control/e2b-api.js')>()),
  createE2BSandbox: vi.fn(),
  getE2BSandbox: vi.fn(),
  listE2BSandboxes: vi.fn(),
  setE2BSandboxTimeout: vi.fn(),
  killE2BSandbox: vi.fn(),
}));
vi.mock('../../src/sandbox-control/e2b-envd.js', () => ({ launchE2BWrapper: vi.fn() }));
vi.mock('../../src/db/pg.js', () => ({
  getPgDb: () => {
    throw new Error('E2B adapter freshness test does not use PostgreSQL');
  },
}));

const sockets: WebSocket[] = [];
const physicalId = 'sbxfreshness00000000000001';

type Registration = Omit<Parameters<SandboxSession['registerSession']>[0], 'workspace'> & {
  workspace: NonNullable<SessionMetadata['workspace']>;
};

/** Mirrors `e2bControlFixture` but leaves `createE2BControlAdapter` real. */
async function realProviderFixture() {
  const sandboxId = `ses-${crypto.randomUUID().replaceAll('-', '')}`;
  const control = env.SANDBOX_CONTROL.getByName(sandboxId);
  const registration: Registration = {
    identity: {
      sessionId: `workspace_${crypto.randomUUID()}`,
      userId: 'oauth/e2b-adapter-freshness',
      orgId: E2B_TEST_BINDING.organizationId,
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId: E2B_TEST_NATIVE_ID, kilocodeToken: E2B_TEST_KILO_TOKEN },
    agent: { mode: 'code', model: 'test' },
    workspace: {
      sandboxId,
      sandboxProvider: 'e2b',
      sandboxProviderBinding: E2B_TEST_BINDING,
      workspacePath: '/workspace/e2b-adapter-freshness',
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

  let config: E2BAllocationConfig | undefined;
  let intentId = '';
  let endAtMs = 0;
  let deleted = false;
  let killed: string | null = null;
  const leaseTimeouts: number[] = [];
  const detail = (): E2BSandboxDetail => {
    if (!config) throw new Error('Missing created config');
    return {
      sandboxID: physicalId,
      templateID: config.templateId,
      metadata: e2bCreateMetadata(config, intentId),
      state: 'running',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      endAt: new Date(endAtMs).toISOString(),
      envdVersion: '1.0.0',
      cpuCount: config.resourceProfile.cpuCount,
      memoryMB: config.resourceProfile.memoryMB,
      envdAccessToken: 'fixture-envd-access-token',
      network: { allowPublicTraffic: false },
      lifecycle: { onTimeout: 'kill', autoResume: false },
    };
  };
  vi.mocked(createE2BSandbox).mockImplementation(async (_apiKey, pinned, createdIntentId) => {
    config = pinned;
    intentId = createdIntentId;
    endAtMs = Date.now() + 60_000;
    return { sandboxID: physicalId, templateID: pinned.templateId };
  });
  vi.mocked(getE2BSandbox).mockImplementation(async (_apiKey, id) => {
    if (!config || deleted || id !== physicalId) return null;
    return detail();
  });
  vi.mocked(listE2BSandboxes).mockResolvedValue({ items: [] });
  vi.mocked(setE2BSandboxTimeout).mockImplementation(async (_apiKey, _id, timeoutSeconds) => {
    leaseTimeouts.push(timeoutSeconds);
    endAtMs = Date.now() + timeoutSeconds * 1_000;
  });
  vi.mocked(killE2BSandbox).mockImplementation(async (_apiKey, id) => {
    deleted = true;
    killed = id;
  });

  const launches: Record<string, string>[] = [];
  vi.mocked(launchE2BWrapper).mockImplementation(async ({ env: launchEnv, providerRef }) => {
    launches.push({ ...launchEnv, PROVIDER_INSTANCE_ID: providerRef });
  });

  await runInDurableObject(control, instance => {
    Object.assign(instance['env'], E2B_TEST_ENV);
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
  return {
    sandboxId,
    control,
    session,
    registration,
    launches,
    input,
    leaseTimeouts,
    killedId: () => killed,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await abortAllDurableObjects();
  await reset();
  vi.restoreAllMocks();
});

describe('E2B adapter freshness', () => {
  it('renews and stops a created sandbox through a submitted-instance adapter', async () => {
    const fixture = await realProviderFixture();
    const status = await fixture.control.ensureReady(fixture.input);
    if (!status.attachment?.directory) throw new Error('Missing attachment');
    const record = await fixture.control.getAllocationRecord();
    if (record.state.kind !== 'allocated' || record.state.target.providerRef === null)
      throw new Error('Missing provider reference');
    const providerRef = record.state.target.providerRef;

    await fixture.control.attachSession({
      sessionId: fixture.input.sessionId,
      kiloSessionId: E2B_TEST_NATIVE_ID,
      directory: status.attachment.directory,
      ownerId: fixture.input.ownerId,
    });
    const { socket, wrapperInstanceId } = await connectE2BTestWrapper(
      fixture as unknown as E2BControlFixture
    );
    sockets.push(socket);

    await runInDurableObject(fixture.control, async instance => {
      const identity = instance['readyWrapperRuntime']();
      if (!identity) throw new Error('Missing ready wrapper');
      await instance['renewProviderLease'](identity);
    });

    expect(fixture.leaseTimeouts.length).toBeGreaterThan(0);
    await expect(fixture.control.getStatus()).resolves.toMatchObject({
      connection: 'ready',
      wrapperInstanceId,
    });

    await fixture.control.beginStop('test runtime loss');
    await fixture.control.recordStopAttempt();

    expect(fixture.killedId()).toBe(parseE2BProviderRef(providerRef)?.physicalId);
    await expect(fixture.control.getAllocationRecord()).resolves.toMatchObject({
      state: { kind: 'stopped' },
    });
  });
});
