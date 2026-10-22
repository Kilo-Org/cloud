import { drizzle } from 'drizzle-orm/durable-sqlite';
import { readRoute } from '../../src/control-plane/sandbox/routes.js';
import { resolveControlPlaneTimers } from '../../src/shared/control-plane-timers.js';
import {
  env,
  evictAllDurableObjects,
  abortAllDurableObjects,
  reset,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import type {
  ProviderAdapter,
  ProviderLaunchOptions,
  ProviderStartupCommand,
} from '../../src/sandbox-control/provider.js';
import { verifySandboxLaunchCredential } from '../../src/sandbox-control/credential.js';
import { resolveSecret } from '../../src/auth.js';
import { readRepositoryLaunch } from '../../src/control-plane/sandbox/repository-launch.js';
import type { StartupFailureCode } from '../../src/sandbox-control/startup-failure.js';
import { RUNTIME_BASE_ABI } from '../../src/sandbox-control/runtime-release.js';
import { downloadedStartup } from '../../src/sandbox-control/downloaded-startup.js';
import { runtimeArtifactReleaseKey } from '../../src/sandbox-control/runtime-artifact-keys.js';
import { FakeSessionPeer, createRuntimeProxyMintingPeer } from './helpers/fake-session-peer.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import {
  createFakeCredentialBroker,
  FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
  FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { waitFor } from './wait-for.js';

const namespace = (env as unknown as { SANDBOX_CONTROL: DurableObjectNamespace<SandboxControlV2> })
  .SANDBOX_CONTROL;
const workerSecret = (env as unknown as { NEXTAUTH_SECRET: string }).NEXTAUTH_SECRET;
const SESSION = 'workspace_11111111-1111-1111-1111-111111111111';
const descriptor = JSON.stringify({
  format: 1,
  bootstrap: 1,
  platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
  abi: RUNTIME_BASE_ABI,
  cliVersion: '7.8.1',
  cliExecutable: 'package/bin/kilo',
  wrapperSdkVersion: '7.8.1',
  protocol: '1',
  artifacts: [
    { role: 'cli', sha256: 'a'.repeat(64), transferBytes: 1, expandedBytes: 1, fileCount: 1 },
    { role: 'control', sha256: 'b'.repeat(64), transferBytes: 1, expandedBytes: 1, fileCount: 1 },
  ],
  caps: { maxTransferBytes: 100, maxExpandedBytes: 100, maxFileCount: 10 },
  inventory: [
    ['cli', 'package/bin/kilo', 0o755, 1, 'a'.repeat(64)],
    ['control', 'usr/local/bin/wrapper', 0o755, 1, 'b'.repeat(64)],
  ],
});

it('loads a hash-selected descriptor through a real R2 binding before rendering startup', async () => {
  const bytes = new TextEncoder().encode(descriptor);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  const bucket = env.RUNTIME_RELEASE_BUCKET;
  if (!bucket) throw new Error('Missing local runtime R2 binding');
  const key = runtimeArtifactReleaseKey(hash);
  const payloadKeys = ['a', 'b'].map(value => 'runtime-artifacts/v1/objects/' + value.repeat(64));
  try {
    await bucket.put(key, bytes);
    for (const payloadKey of payloadKeys) await bucket.put(payloadKey, new Uint8Array([1]));
    const command = await downloadedStartup({
      env: {
        WORKER_URL: 'https://worker.test',
        NEXTAUTH_SECRET: workerSecret,
        RUNTIME_RELEASE_BUCKET: bucket,
      },
      descriptor: hash,
      sandboxId: 'sbx_fixture',
      allocationId: crypto.randomUUID(),
      deadlineAt: Date.now() + 300000,
    });
    // Do not print the command: it contains a short-lived artifact grant.
    expect(command.argv.some(value => value.includes('package/bin/kilo'))).toBe(true);
    expect(command.argv.some(value => value.includes('https://worker.test'))).toBe(true);
  } finally {
    await bucket.delete([key, ...payloadKeys]);
  }
});

function fakeProvider(
  options: { holdFirst?: boolean; holdSecond?: boolean; snapshotFailed?: boolean } = {}
) {
  const launches: {
    env: Record<string, string>;
    command: ProviderStartupCommand;
    options?: ProviderLaunchOptions;
  }[] = [];
  const releases: (() => void)[] = [];
  const captures: string[] = [];
  const calls = { create: 0, stop: 0, observe: 0, lease: 0 };
  const adapter: ProviderAdapter = {
    async ensureBillingAdmission() {},
    async create(intent) {
      calls.create++;
      return { providerRef: `mem_${intent.intentId}` };
    },
    async launch(_ref, startup, launchOptions) {
      const index = launches.length;
      launches.push({ ...startup, options: launchOptions });
      if ((index === 0 && options.holdFirst) || (index === 1 && options.holdSecond))
        await new Promise<void>(resolve => {
          releases[index] = resolve;
        });
      return index === 0 && options.snapshotFailed
        ? { startSource: 'repository', snapshotFailed: true }
        : { startSource: 'repository' };
    },
    async observe() {
      calls.observe++;
      return { status: 'active' };
    },
    async stop() {
      calls.stop++;
      return 'terminal';
    },
    async ensureLeaseAtLeast() {
      calls.lease++;
    },
    async logs() {
      return '';
    },
    async captureRepository(_ref, key) {
      captures.push(key);
      return true;
    },
  };
  return { adapter, launches, calls, captures, releases };
}

function configureHarness(
  instance: SandboxControlV2,
  provider: ReturnType<typeof fakeProvider>,
  peer: FakeSessionPeer
) {
  installFakeCredentialEnv(instance.env, createFakeCredentialBroker(), {
    NEXTAUTH_SECRET: workerSecret,
    WORKER_URL: 'https://worker.test',
    CONTAINER_REPO_SNAPSHOT_IDS: '*',
    SANDBOX_CONTAINERS: FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
    RUNTIME_STARTUP_MODE: 'downloaded',
    NATIVE_RUNTIME_IMAGE: 'all-in-one',
    RUNTIME_RELEASE_DESCRIPTOR: descriptor,
    RUNTIME_RELEASE_BUCKET: {
      async head() {
        return { size: 1 };
      },
    },
  });
  peer.runtimeProxyForSession = createRuntimeProxyMintingPeer(instance.env, () => ({
    userId: 'user_123',
    kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
  }));
  Object.assign(instance, {
    provider: provider.adapter,
    createProviderAdapter: () => provider.adapter,
    sessionPeerFor: (_owner: string, sessionId: string) => peer.forSession(sessionId),
  });
}

type Harness = Awaited<ReturnType<typeof setup>>;
async function setup(id: string, options: Parameters<typeof fakeProvider>[0] = {}) {
  const provider = fakeProvider(options);
  const peer = new FakeSessionPeer();
  const stub = namespace.getByName(id);
  await runInDurableObject(stub, async instance => {
    await instance.getAllocationState();
    configureHarness(instance, provider, peer);
  });
  return { id, stub, peer, provider };
}
async function prepare(h: Harness) {
  await h.stub.prepare({
    spec: {
      sessionId: SESSION,
      kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      attemptId: 'requested',
      directory: '/workspace/app',
      git: { url: 'https://github.com/acme/widgets.git' },
    },
    credentials: {
      userId: 'user_123',
      kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      kiloToken: FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
      orgId: 'org_123',
      repository: { type: 'github', repo: 'acme/widgets' },
      scopeId: SESSION,
    },
    sandboxSelection: { provider: 'cloudflare-containers' },
  });
  await waitFor(() => expect(h.provider.launches.length > 0).toBe(true));
}
async function report(h: Harness, index: number, code: StartupFailureCode) {
  const token = h.provider.launches[index]?.env.SANDBOX_CONTROL_CREDENTIAL;
  if (!token) throw new Error('Missing test launch credential');
  const secret = await resolveSecret(workerSecret);
  const launch = verifySandboxLaunchCredential(token, secret!);
  if (!launch) throw new Error('Invalid test launch credential');
  return h.stub.reportStartupFailure({
    allocationId: launch.allocationId,
    credential: launch.credential,
    code,
  });
}
async function release(h: Harness, index: number) {
  await runInDurableObject(h.stub, async () => {
    h.provider.releases[index]?.();
    await new Promise(resolve => setTimeout(resolve, 20));
  });
}
async function record(h: Harness) {
  return runInDurableObject(h.stub, (_instance, state) => readRepositoryLaunch(state.storage));
}

afterEach(async () => {
  await reset();
});

describe('downloaded startup in the allocation owner', () => {
  it('retains the mode through recordLaunch and uses that mode for capture', async () => {
    const h = await setup('sbx__runtime_mode');
    await prepare(h);
    await waitFor(async () => expect((await h.stub.getAllocationState()).kind).toBe('starting'));
    expect((await record(h))?.startupMode).toBe('downloaded');
    const startup = h.provider.launches[0]!;
    expect(startup.options?.repoKey?.startsWith('downloaded:')).toBe(true);
    const wrapper = await FakeWrapper.connect({
      sandboxId: h.id,
      credential: startup.env.SANDBOX_CONTROL_CREDENTIAL,
    });
    await wrapper.hello({
      wrapperId: 'runtime-B',
      allocationId: startup.env.CONTROL_PLANE_ALLOCATION_ID,
    });
    await waitFor(async () => expect((await h.stub.getAllocationState()).kind).toBe('connected'));
    wrapper.send({ type: 'workspace.capture', sessionId: SESSION });
    await waitFor(() => expect(h.provider.captures.length).toBe(1));
    expect(h.provider.captures[0]).toBe(startup.options?.repoKey);
    expect(await report(h, 0, 'artifact_invalid')).toBe(false);
  });
  it('stops immediately without image fallback when a permanent report wins', async () => {
    const h = await setup('sbx__runtime_report_first', { holdFirst: true, snapshotFailed: true });
    await prepare(h);
    expect((await h.stub.getAllocationState()).kind).toBe('creating');
    expect(await report(h, 0, 'artifact_unauthorized')).toBe(true);
    await waitFor(async () => expect((await h.stub.getAllocationState()).kind).toBe('stopped'));
    expect(
      h.peer
        .routeUpdatesFor(SESSION)
        .some(x => x.state === 'failed' && x.reason === 'runtime_artifact_unauthorized')
    ).toBe(true);
    expect(await report(h, 0, 'artifact_unauthorized')).toBe(false);
    await release(h, 0);
    expect(h.provider.launches.length).toBe(1);
    expect((await record(h))?.startupMode).toBe('downloaded');
  });
  it('rotates the credential before the one baseline image fallback when provider failure wins', async () => {
    const h = await setup('sbx__runtime_provider_first', {
      snapshotFailed: true,
      holdSecond: true,
    });
    await prepare(h);
    await waitFor(() => expect(h.provider.launches.length).toBe(2));
    expect(h.provider.launches[1]?.options?.skipRepository).toBe(true);
    expect(h.provider.launches[0]?.command === h.provider.launches[1]?.command).toBe(true);
    expect(await report(h, 0, 'artifact_invalid')).toBe(false);
    expect(await report(h, 1, 'artifact_invalid')).toBe(true);
    await release(h, 1);
    await waitFor(async () => expect((await h.stub.getAllocationState()).kind).toBe('stopped'));
    expect(h.provider.launches.length).toBe(2);
    expect(
      h.peer
        .routeUpdatesFor(SESSION)
        .some(x => x.state === 'failed' && x.reason === 'runtime_artifact_invalid')
    ).toBe(true);
  });
  it.each([true, false])(
    'keeps base incompatibility retryable when creating=%s',
    async holdFirst => {
      const h = await setup(`sbx__runtime_base_${holdFirst}`, { holdFirst });
      await prepare(h);
      if (!holdFirst)
        await waitFor(async () =>
          expect((await h.stub.getAllocationState()).kind).toBe('starting')
        );
      expect(await report(h, 0, 'base_incompatible')).toBe(true);
      if (holdFirst) await release(h, 0);
      await waitFor(() => expect(h.provider.launches.length).toBe(2));
      expect(h.provider.launches[1]?.options?.skipRepository).toBe(true);
      expect(h.peer.routeUpdatesFor(SESSION).some(x => x.state === 'failed')).toBe(false);
    }
  );
  it('recovers stopped retry work after reconstruction while the old launch remains unresolved', async () => {
    const h = await setup('sbx__runtime_retry_reconstructed', { holdFirst: true });
    try {
      await prepare(h);
      const before = await runInDurableObject(h.stub, (_instance, state) =>
        readRoute(drizzle(state.storage), SESSION)
      );
      expect(await report(h, 0, 'artifact_unavailable')).toBe(true);
      await waitFor(async () => expect((await h.stub.getAllocationState()).kind).toBe('stopped'));
      const oldAllocationId = h.provider.launches[0]?.env.CONTROL_PLANE_ALLOCATION_ID;
      const alarm = await runInDurableObject(h.stub, (_instance, state) =>
        state.storage.getAlarm()
      );
      expect(alarm).not.toBeNull();
      expect(alarm).toBeLessThanOrEqual(
        Date.now() + resolveControlPlaneTimers({}).sandbox.providerCreateRetryMs
      );
      await runInDurableObject(h.stub, instance => instance.alarm());
      expect(h.provider.launches.length).toBe(1);
      expect(h.provider.calls.observe).toBe(0);
      // Graceful eviction waits for this launch; model isolate loss instead.
      await abortAllDurableObjects();
      // The terminated instance cannot resume its old promise.
      h.provider.releases.length = 0;
      h.stub = namespace.getByName(h.id);
      await runInDurableObject(h.stub, async instance => {
        await instance.getAllocationState();
        configureHarness(instance, h.provider, h.peer);
        await instance.alarm();
      });
      await waitFor(() => expect(h.provider.launches.length).toBe(2));
      const resumed = await h.stub.getAllocationState();
      expect(resumed.allocationId).not.toBe(oldAllocationId);
      const after = await runInDurableObject(h.stub, (_instance, state) =>
        readRoute(drizzle(state.storage), SESSION)
      );
      expect(after?.attemptId).toBe(before?.attemptId);
      expect(after?.attemptDeadlineAt).toBe(before?.attemptDeadlineAt);
      expect(after?.state).toBe('preparing');
    } finally {
      await release(h, 0);
    }
  });
  it('rejects a stale allocation and a forged credential without changing state', async () => {
    const h = await setup('sbx__runtime_forged');
    await prepare(h);
    await waitFor(async () => expect((await h.stub.getAllocationState()).kind).toBe('starting'));
    const state = await h.stub.getAllocationState();
    expect(
      await h.stub.reportStartupFailure({
        allocationId: state.allocationId!,
        credential: 'wrong',
        code: 'artifact_invalid',
      })
    ).toBe(false);
    expect(
      await h.stub.reportStartupFailure({
        allocationId: crypto.randomUUID(),
        credential: 'a'.repeat(64),
        code: 'artifact_invalid',
      })
    ).toBe(false);
    expect(await h.stub.getAllocationState()).toEqual(state);
  });
  it('keeps a live allocation mode and deadlines across deployment configuration changes and reconstruction', async () => {
    const h = await setup('sbx__runtime_existing');
    await runInDurableObject(h.stub, instance => {
      instance.env.RUNTIME_STARTUP_MODE = undefined;
    });
    await prepare(h);
    await waitFor(async () => expect((await h.stub.getAllocationState()).kind).toBe('starting'));
    const before = await h.stub.getAllocationState();
    expect((await record(h))?.startupMode).toBe('preinstalled');
    await runInDurableObject(h.stub, instance => {
      instance.env.RUNTIME_STARTUP_MODE = 'downloaded';
    });
    const calls = { ...h.provider.calls };
    await evictAllDurableObjects();
    const rebuilt = namespace.getByName(h.id);
    expect(await rebuilt.getAllocationState()).toEqual(before);
    await rebuilt.getStatusSnapshot();
    expect(h.provider.calls).toEqual(calls);
    expect((await record(h))?.startupMode).toBe('preinstalled');
  });
});
