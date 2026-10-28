import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { EnvironmentReference } from '@kilocode/cloud-agent-profile';
import {
  EnvironmentBuildCoordinator,
  type CoordinatorDeps,
  type RunnerAuth,
} from '../../src/environment-build/coordinator.js';
import type { EnvironmentBuild } from '../../src/environment-build/environment-build-do.js';
import type {
  BuilderAllocation,
  BuilderProvider,
} from '../../src/environment-build/builder-provider.js';
import type { BuildStore } from '../../src/environment-build/store.js';
import type { NativeCaptureResult } from '../../src/sandbox-containers/native-capture.js';
import { MAX_BUILD_LOG_BYTES } from '../../src/environment-build/policy.js';
import { isEnvironmentSnapshotsEnabled } from '../../src/environment-build/enrollment.js';

const OWNER = { type: 'organization' as const, id: '22222222-2222-4222-8222-222222222222' };
const REPOSITORY = { platform: 'github' as const, repoFullName: 'acme/widgets' };

type Namespace = DurableObjectNamespace<EnvironmentBuild>;
const namespace = (env as unknown as { ENVIRONMENT_BUILD: Namespace }).ENVIRONMENT_BUILD;

type Harness = {
  /** Each test gets its own coordinator: `reset()` wipes storage under a reused instance. */
  environmentId: string;
  stub: DurableObjectStub<EnvironmentBuild>;
  environment: { revision: number; deleted: boolean; access: 'manage' | 'read' | 'none' };
  launches: Array<{ allocation: BuilderAllocation; runner: { url: string; credential: string } }>;
  captures: Array<{ captureId: string }>;
  snapshotsTaken: Map<string, number>;
  stops: BuilderAllocation[];
  captureResult: (captureId: string) => NativeCaptureResult;
  stopResult: 'terminal' | 'retryable';
  launchError: Error | null;
  /** The image a container would start from now; null when it cannot be read. */
  currentImage: string | null;
  alarms: number[];
  gitUnavailable?: boolean;
  billingAdmission?: (allocation: BuilderAllocation) => Promise<void>;
  snapshotOrgIds: string;
};

function reference(harness: Harness): EnvironmentReference {
  return {
    environmentId: harness.environmentId,
    owner: OWNER,
    configurationRevision: harness.environment.revision,
    repository: REPOSITORY,
  };
}

/** Install a coordinator whose environment, provider and credentials are in-memory fakes. */
async function setup(): Promise<Harness> {
  const environmentId = crypto.randomUUID();
  const stub = namespace.getByName(environmentId);
  const harness: Harness = {
    environmentId,
    stub,
    environment: { revision: 1, deleted: false, access: 'manage' },
    launches: [],
    captures: [],
    snapshotsTaken: new Map(),
    stops: [],
    captureResult: captureId => ({
      status: 'stored',
      snapshotId: `snap-${captureId}`,
      size: 42,
      capturedAt: Date.now(),
      baseImage: 'registry.example/runtime-free:1',
      durationMs: 10,
    }),
    stopResult: 'terminal',
    launchError: null,
    currentImage: 'registry.example/runtime-free:1',
    alarms: [],
    snapshotOrgIds: OWNER.id,
  };
  const provider: BuilderProvider = {
    admitBilling: async allocation => {
      await harness.billingAdmission?.(allocation);
    },
    launch: async (allocation, launch) => {
      if (harness.launchError) throw harness.launchError;
      harness.launches.push({ allocation, runner: launch.runner });
    },
    capture: async (_allocation, captureId) => {
      harness.captures.push({ captureId });
      // A capture id is taken once; a repeated call returns the stored outcome.
      harness.snapshotsTaken.set(captureId, 1);
      return harness.captureResult(captureId);
    },
    stop: async allocation => {
      harness.stops.push(allocation);
      return harness.stopResult;
    },
    renewLease: async () => undefined,
    runtimeReleaseId: async () => 'release-1',
    currentImage: async () => harness.currentImage,
  };
  await runInDurableObject(stub, async (instance: EnvironmentBuild, state) => {
    const host = instance as unknown as {
      initialized: Promise<void>;
      store: BuildStore;
      coordinator?: EnvironmentBuildCoordinator;
    };
    await host.initialized;
    const deps: CoordinatorDeps = {
      now: () => Date.now(),
      uuid: () => crypto.randomUUID(),
      store: host.store,
      transaction: write => state.storage.transactionSync(write),
      // Alarms are driven by `tick`, so the runtime's own alarm never races a test.
      armAlarm: async at => {
        harness.alarms.push(at);
      },
      environment: {
        reference: async () => (harness.environment.deleted ? null : reference(harness)),
        buildInput: async () =>
          harness.environment.deleted
            ? null
            : {
                reference: reference(harness),
                repoFullName: 'acme/widgets',
                commands: ['pnpm install'],
                plainVars: { PLAIN: 'value' },
                encryptedSecrets: {
                  TOKEN: {
                    encryptedData: 'x',
                    encryptedDEK: 'y',
                    algorithm: 'rsa-aes-256-gcm',
                    version: 1,
                  },
                },
              },
        actorAccess: async () => harness.environment.access,
        gitSource: async () =>
          harness.gitUnavailable
            ? { ok: false, reason: 'unavailable' }
            : {
                ok: true,
                git: {
                  url: 'https://github.com/acme/widgets.git',
                  token: 'gh-token',
                  platform: 'github',
                },
              },
        capacity: async () => 'ok',
      },
      provider,
      runnerUrl: (environment, build) =>
        `https://worker.test/environment-build/${environment}/${build}`,
      runnerCredential: async claims => `cred:${claims.buildId}:${claims.allocationId}`,
      runnerCredentialMatches: async (claims, credential) =>
        credential === `cred:${claims.buildId}:${claims.allocationId}`,
      decryptSecrets: () => ({ TOKEN: 'secret-value' }),
      billingInput: ({ sandboxId, buildId }) => ({
        sandboxId: sandboxId as never,
        subject: { type: 'org', id: OWNER.id },
        actor: { type: 'user', id: 'user-1' },
        sessionId: `environment-build:${buildId}`,
        metadata: { origin: 'environment-build' },
      }),
      builderSandboxId: 'sbx-' + '0'.repeat(48),
      unsupportedReason: owner =>
        isEnvironmentSnapshotsEnabled(
          { ENVIRONMENT_SNAPSHOT_ORG_IDS: harness.snapshotOrgIds },
          owner
        )
          ? null
          : 'Snapshots are not enabled for this organization',
      log: () => undefined,
    };
    host.coordinator = new EnvironmentBuildCoordinator(environmentId, deps);
    await state.storage.deleteAlarm();
  });
  return harness;
}

async function manualBuild(harness: Harness, requestId = crypto.randomUUID()) {
  return harness.stub.requestBuild({
    environmentId: harness.environmentId,
    owner: OWNER,
    expectedRevision: harness.environment.revision,
    requestId,
    trigger: 'manual',
    actorUserId: 'user-1',
  });
}

async function status(harness: Harness) {
  return harness.stub.status({
    environmentId: harness.environmentId,
    owner: OWNER,
    configurationRevision: harness.environment.revision,
  });
}

function runnerAuth(harness: Harness, buildId: string): RunnerAuth {
  const launch = harness.launches.at(-1);
  if (!launch) throw new Error('builder was not launched');
  return {
    environmentId: harness.environmentId,
    buildId,
    allocationId: launch.allocation.allocationId,
    credential: `cred:${buildId}:${launch.allocation.allocationId}`,
  };
}

/** One alarm pass of the coordinator, as the runtime would run it. */
async function tick(harness: Harness): Promise<void> {
  await runInDurableObject(harness.stub, async (instance: EnvironmentBuild) => {
    await (instance as unknown as { coordinator: EnvironmentBuildCoordinator }).coordinator.alarm();
  });
}

/** Run alarm passes until the build stops moving or `limit` passes elapse. */
async function drive(harness: Harness, limit = 6): Promise<void> {
  for (let pass = 0; pass < limit; pass += 1) {
    const before = JSON.stringify(await status(harness));
    await tick(harness);
    if (JSON.stringify(await status(harness)) === before) return;
  }
}

/** Admit a manual build and run it through the builder's ready report. */
async function readyBuild(harness: Harness) {
  const accepted = await manualBuild(harness);
  if (accepted.status !== 'accepted') throw new Error(`build not accepted: ${accepted.status}`);
  await tick(harness);
  const auth = runnerAuth(harness, accepted.buildId);
  return { buildId: accepted.buildId, auth };
}

afterEach(async () => {
  await reset();
});

describe('environment build lifecycle', () => {
  it('settles a billing admission when cancellation wins before launch', async () => {
    const h = await setup();
    const accepted = await manualBuild(h);
    if (accepted.status !== 'accepted') throw new Error('not accepted');
    const admitted: BuilderAllocation[] = [];
    await runInDurableObject(h.stub, (instance: EnvironmentBuild) => {
      const coordinator = (instance as unknown as { coordinator: EnvironmentBuildCoordinator })
        .coordinator;
      h.billingAdmission = async allocation => {
        admitted.push(allocation);
        await coordinator.cancel(accepted.buildId);
      };
    });
    await tick(h);
    await drive(h);
    expect(admitted).toHaveLength(1);
    expect(h.launches).toHaveLength(0);
    expect(h.stops).toEqual(admitted);
    expect((await status(h)).latestBuild?.state).toBe('canceled');
  });

  it('delays queued retries while the repository token source is unavailable', async () => {
    const h = await setup();
    await manualBuild(h);
    h.gitUnavailable = true;
    const before = Date.now();
    await tick(h);
    expect((await status(h)).activeBuild?.state).toBe('queued');
    expect(h.alarms.at(-1)).toBeGreaterThanOrEqual(before + 30_000);
    h.gitUnavailable = false;
    await tick(h);
    expect(h.launches).toHaveLength(1);
  });

  it('returns recent log output when no page cursor is supplied', async () => {
    const h = await setup();
    const { buildId, auth } = await readyBuild(h);
    await h.stub.runnerEvents(auth, {
      sequence: 0,
      logs: Array.from({ length: 512 }, (_, i) => `line ${i}`),
    });
    await h.stub.runnerEvents(auth, { sequence: 1, logs: ['failure detail at the end'] });
    const tail = await h.stub.logs({ environmentId: h.environmentId, buildId, limit: 500 });
    expect(tail?.lines).toHaveLength(500);
    expect(tail?.lines.at(-1)?.text).toBe('failure detail at the end');
    const first = await h.stub.logs({
      environmentId: h.environmentId,
      buildId,
      cursor: 0,
      limit: 10,
    });
    expect(first?.lines[0]?.text).toBe('line 0');
  });

  it('builds without a chat, publishes the snapshot and stops the exact builder', async () => {
    const harness = await setup();
    const { buildId, auth } = await readyBuild(harness);

    expect(harness.launches).toHaveLength(1);
    expect(harness.launches[0]?.runner).toEqual({
      url: `https://worker.test/environment-build/${harness.environmentId}/${buildId}`,
      credential: auth.credential,
    });
    expect(harness.launches[0]?.allocation.instance).toBe('standard-4');

    const input = await harness.stub.runnerInput(auth);
    expect(input).toMatchObject({
      buildId,
      directory: '/workspace/app',
      commands: ['pnpm install'],
      env: { PLAIN: 'value', TOKEN: 'secret-value' },
      secretKeys: ['TOKEN'],
      git: { url: 'https://github.com/acme/widgets.git', token: 'gh-token' },
    });
    await expect(
      harness.stub.runnerEvents(auth, { sequence: 0, step: 'setup', logs: ['installing'] })
    ).resolves.toEqual({ action: 'continue' });
    await expect(
      harness.stub.runnerResult(auth, {
        outcome: 'ready',
        commit: 'a'.repeat(40),
        branch: 'main',
        setupDurationMs: 1234,
      })
    ).resolves.toBe('ok');
    await drive(harness);

    const done = await status(harness);
    expect(done.activeBuild).toBeNull();
    expect(done.latestBuild).toMatchObject({
      buildId,
      state: 'succeeded',
      sourceCommit: 'a'.repeat(40),
      setupDurationMs: 1234,
      cleanup: 'confirmed',
    });
    expect(done.published).toMatchObject({ buildId, revision: 1, stale: null, size: 42 });
    expect(harness.stops.map(stop => stop.allocationId)).toEqual([auth.allocationId]);
    expect(harness.captures).toHaveLength(1);
    const logs = await harness.stub.logs({
      environmentId: harness.environmentId,
      buildId,
      cursor: 0,
      limit: 10,
    });
    expect(logs).toMatchObject({ lines: [{ seq: 1, text: 'installing' }], complete: true });
    // Secrets are not readable once the allocation is gone.
    await expect(harness.stub.runnerInput(auth)).resolves.toEqual({ refused: 'gone' });
  });

  it('deduplicates requests and refuses a second revision while a build runs', async () => {
    const harness = await setup();
    const requestId = crypto.randomUUID();
    const first = await manualBuild(harness, requestId);
    expect(first).toMatchObject({ status: 'accepted', created: true });
    await expect(manualBuild(harness, requestId)).resolves.toEqual({
      ...first,
      created: false,
    });
    await expect(manualBuild(harness)).resolves.toMatchObject({
      status: 'accepted',
      created: false,
    });

    harness.environment.revision = 2;
    await expect(manualBuild(harness)).resolves.toMatchObject({
      status: 'conflict',
      reason: 'build_in_progress',
    });
    // A stale expected revision is refused before any build is created.
    await runInDurableObject(harness.stub, async () => undefined);
  });

  it('applies a replayed event batch once and ignores a replayed result', async () => {
    const harness = await setup();
    const { buildId, auth } = await readyBuild(harness);
    await harness.stub.runnerEvents(auth, { sequence: 3, logs: ['one'] });
    await harness.stub.runnerEvents(auth, { sequence: 3, logs: ['one'] });
    await harness.stub.runnerEvents(auth, { sequence: 4, logs: ['two'] });
    const ready = {
      outcome: 'ready' as const,
      commit: 'b'.repeat(40),
      branch: 'main',
      setupDurationMs: 1,
    };
    await harness.stub.runnerResult(auth, ready);
    await harness.stub.runnerResult(auth, ready);
    await drive(harness);

    const logs = await harness.stub.logs({
      environmentId: harness.environmentId,
      buildId,
      cursor: 0,
      limit: 10,
    });
    expect(logs?.lines.map(line => line.text)).toEqual(['one', 'two']);
    expect(harness.captures).toHaveLength(1);
  });

  it('refuses a builder with another credential or allocation', async () => {
    const harness = await setup();
    const { auth } = await readyBuild(harness);

    await expect(harness.stub.runnerInput({ ...auth, credential: 'forged' })).resolves.toEqual({
      refused: 'unauthorized',
    });
    await expect(
      harness.stub.runnerEvents({ ...auth, allocationId: crypto.randomUUID() }, { sequence: 0 })
    ).resolves.toEqual({ refused: 'unauthorized' });
  });

  it('reads a lost capture reply back by its capture id and never snapshots twice', async () => {
    const harness = await setup();
    const { auth } = await readyBuild(harness);
    await harness.stub.runnerResult(auth, {
      outcome: 'ready',
      commit: 'c'.repeat(40),
      branch: 'main',
      setupDurationMs: 1,
    });
    // The first capture reply is lost after the platform stored the result.
    let lost = true;
    const stored = harness.captureResult;
    harness.captureResult = captureId => {
      if (lost) {
        lost = false;
        throw new Error('reply lost');
      }
      return stored(captureId);
    };
    await tick(harness);
    expect((await status(harness)).activeBuild?.state).toBe('capturing');
    await drive(harness);

    expect((await status(harness)).published).not.toBeNull();
    const ids = new Set(harness.captures.map(capture => capture.captureId));
    expect(ids.size).toBe(1);
  });

  it('fails an uncertain capture without replacing the published snapshot', async () => {
    const harness = await setup();
    const first = await readyBuild(harness);
    await harness.stub.runnerResult(first.auth, {
      outcome: 'ready',
      commit: 'd'.repeat(40),
      branch: 'main',
      setupDurationMs: 1,
    });
    await drive(harness);
    const published = (await status(harness)).published;

    harness.captureResult = () => ({ status: 'failed', reason: 'uncertain' });
    const second = await readyBuild(harness);
    await harness.stub.runnerResult(second.auth, {
      outcome: 'ready',
      commit: 'e'.repeat(40),
      branch: 'main',
      setupDurationMs: 1,
    });
    await drive(harness);

    const after = await status(harness);
    expect(after.latestBuild).toMatchObject({
      buildId: second.buildId,
      state: 'failed',
      failureReason: 'capture_uncertain',
    });
    expect(after.published).toEqual(published);
  });

  it('makes a build obsolete when the configuration changes during it', async () => {
    const harness = await setup();
    const { buildId, auth } = await readyBuild(harness);
    await harness.stub.runnerResult(auth, {
      outcome: 'ready',
      commit: 'f'.repeat(40),
      branch: 'main',
      setupDurationMs: 1,
    });
    harness.environment.revision = 2;
    await drive(harness);

    const after = await status(harness);
    expect(after.latestBuild).toMatchObject({
      buildId,
      state: 'obsolete',
      failureReason: 'configuration_changed',
    });
    expect(after.published).toBeNull();
    expect(harness.stops).toHaveLength(1);
  });

  it('stops a build when the environment is deleted and refuses new admission', async () => {
    const harness = await setup();
    const { buildId, auth } = await readyBuild(harness);
    harness.environment.deleted = true;
    await harness.stub.environmentDeleted({ environmentId: harness.environmentId });
    await drive(harness);

    const after = await status(harness);
    expect(after.latestBuild).toMatchObject({ buildId, state: 'obsolete' });
    // A late builder result cannot publish into a deleted environment.
    await expect(
      harness.stub.runnerResult(auth, {
        outcome: 'ready',
        commit: 'a'.repeat(40),
        branch: 'main',
        setupDurationMs: 1,
      })
    ).resolves.toEqual({ refused: 'gone' });
    expect((await status(harness)).published).toBeNull();
    await expect(manualBuild(harness)).resolves.toEqual({
      status: 'rejected',
      reason: 'not_found',
    });
  });

  it('cancels the exact allocation and tells the builder to stop', async () => {
    const harness = await setup();
    const { buildId, auth } = await readyBuild(harness);

    await expect(
      harness.stub.cancel({ environmentId: harness.environmentId, buildId })
    ).resolves.toEqual({ status: 'canceling' });
    await expect(harness.stub.runnerEvents(auth, { sequence: 1 })).resolves.toEqual({
      action: 'cancel',
    });
    await drive(harness);

    expect((await status(harness)).latestBuild).toMatchObject({ buildId, state: 'canceled' });
    expect(harness.stops.map(stop => stop.allocationId)).toEqual([auth.allocationId]);
  });

  it('fails a builder that stops reporting', async () => {
    const harness = await setup();
    const { buildId, auth } = await readyBuild(harness);
    await harness.stub.runnerEvents(auth, { sequence: 0 });
    await runInDurableObject(harness.stub, async (instance: EnvironmentBuild) => {
      const host = instance as unknown as { store: BuildStore };
      host.store.update(buildId, { last_heartbeat_at: Date.now() - 120_000 });
    });
    await drive(harness);

    expect((await status(harness)).latestBuild).toMatchObject({
      buildId,
      state: 'failed',
      failureReason: 'builder_lost',
    });
  });

  it('blocks a new build until an unconfirmed stop is confirmed', async () => {
    const harness = await setup();
    const { buildId, auth } = await readyBuild(harness);
    harness.stopResult = 'retryable';
    await harness.stub.runnerResult(auth, {
      outcome: 'failed',
      step: 'setup',
      reason: 'setup_failed',
    });
    await tick(harness);

    expect((await status(harness)).activeBuild).toMatchObject({
      buildId,
      state: 'stopping',
      outcome: 'failed',
      cleanup: 'pending',
    });
    await expect(manualBuild(harness)).resolves.toMatchObject({
      status: 'conflict',
      reason: 'cleanup_pending',
    });
    harness.stopResult = 'terminal';
    await runInDurableObject(harness.stub, async (instance: EnvironmentBuild) => {
      (instance as unknown as { store: BuildStore }).store.update(buildId, { next_cleanup_at: 0 });
    });
    await drive(harness);
    expect((await status(harness)).latestBuild).toMatchObject({ buildId, state: 'failed' });
  });

  it('bounds the stored log of one build', async () => {
    const harness = await setup();
    const { buildId, auth } = await readyBuild(harness);
    const line = 'x'.repeat(8_000);
    let sequence = 0;
    for (let written = 0; written <= MAX_BUILD_LOG_BYTES; written += line.length * 100) {
      await harness.stub.runnerEvents(auth, {
        sequence: sequence++,
        logs: Array.from({ length: 100 }, () => line),
      });
    }
    const logs = await harness.stub.logs({
      environmentId: harness.environmentId,
      buildId,
      cursor: 0,
      limit: 1000,
    });
    expect(logs?.truncated).toBe(true);
    expect(logs?.lines.at(-1)?.text).toContain('truncated');
    const bytes = logs?.lines.reduce((sum, entry) => sum + entry.text.length, 0) ?? 0;
    expect(bytes).toBeLessThanOrEqual(MAX_BUILD_LOG_BYTES + 100);
  });
});

describe('environment snapshot resolution', () => {
  const sessionReference = (harness: Harness, revision: number) => ({
    environmentId: harness.environmentId,
    owner: OWNER,
    configurationRevision: revision,
    repository: REPOSITORY,
  });

  it('denies manual and automatic builds for an organization outside the allowlist', async () => {
    const harness = await setup();
    harness.snapshotOrgIds = 'another-org';
    expect(await manualBuild(harness)).toEqual({
      status: 'rejected',
      reason: 'unsupported_provider',
    });
    expect(
      await harness.stub.resolveSnapshot({
        reference: sessionReference(harness, 1),
        actorUserId: 'user-1',
      })
    ).toEqual({
      snapshot: null,
      reason: 'unsupported',
      admission: { status: 'skipped', reason: 'unsupported' },
    });
    expect(await status(harness)).toMatchObject({
      supported: false,
      activeBuild: null,
      published: null,
    });
    expect(harness.launches).toHaveLength(0);
  });

  it('retains a published snapshot but refuses restore after organization access is removed', async () => {
    const harness = await setup();
    const { auth } = await readyBuild(harness);
    await harness.stub.runnerResult(auth, {
      outcome: 'ready',
      commit: 'a'.repeat(40),
      branch: 'main',
      setupDurationMs: 1,
    });
    await drive(harness);
    expect((await status(harness)).published).not.toBeNull();
    harness.snapshotOrgIds = '';
    expect(
      await harness.stub.resolveSnapshot({
        reference: sessionReference(harness, 1),
        actorUserId: 'user-1',
      })
    ).toMatchObject({
      snapshot: null,
      reason: 'unsupported',
      admission: { status: 'skipped', reason: 'unsupported' },
    });
    expect(await status(harness)).toMatchObject({
      supported: false,
      published: expect.any(Object),
    });
  });

  it.each(['queued', 'preparing'] as const)(
    'retires a legacy all-in-one build in %s state without capture',
    async buildState => {
      const harness = await setup();
      const accepted = await manualBuild(harness);
      if (accepted.status !== 'accepted') throw new Error('Expected an accepted build');
      if (buildState === 'preparing') await tick(harness);
      await runInDurableObject(harness.stub, async (instance: EnvironmentBuild) => {
        const host = instance as unknown as { store: BuildStore };
        host.store.update(accepted.buildId, { runtime_release: null });
      });
      await drive(harness);
      expect(harness.captures).toHaveLength(0);
      expect(harness.launches).toHaveLength(buildState === 'queued' ? 0 : 1);
      expect(harness.stops).toHaveLength(buildState === 'queued' ? 0 : 1);
      expect(await status(harness)).toMatchObject({
        activeBuild: null,
        published: null,
        latestBuild: { state: 'obsolete', failureReason: 'runtime_changed' },
      });
    }
  );

  it('does not launch a queued build after organization access is removed', async () => {
    const harness = await setup();
    await manualBuild(harness);
    harness.snapshotOrgIds = '';
    await drive(harness);
    expect(harness.launches).toHaveLength(0);
    expect(await status(harness)).toMatchObject({
      activeBuild: null,
      latestBuild: { state: 'obsolete', failureReason: 'snapshots_disabled' },
    });
  });

  it('stops a running builder after organization access is removed', async () => {
    const harness = await setup();
    await readyBuild(harness);
    harness.snapshotOrgIds = '';
    await drive(harness);
    expect(harness.stops).toHaveLength(1);
    expect(harness.captures).toHaveLength(0);
    expect(await status(harness)).toMatchObject({
      activeBuild: null,
      latestBuild: { state: 'obsolete' },
    });
  });

  it('admits one build however many sessions start without a snapshot', async () => {
    const harness = await setup();
    const first = await harness.stub.resolveSnapshot({
      reference: sessionReference(harness, 1),
      actorUserId: 'user-2',
    });
    const second = await harness.stub.resolveSnapshot({
      reference: sessionReference(harness, 1),
      actorUserId: 'user-3',
    });

    expect(first).toMatchObject({
      snapshot: null,
      reason: 'missing',
      admission: { status: 'admitted' },
    });
    expect(second).toMatchObject({
      snapshot: null,
      admission: { status: 'active', buildId: (first.admission as { buildId: string }).buildId },
    });
    expect((await status(harness)).activeBuild).toMatchObject({ trigger: 'session', revision: 1 });
  });

  it('reuses an older snapshot after an edit and admits the current revision', async () => {
    const harness = await setup();
    const { auth } = await readyBuild(harness);
    await harness.stub.runnerResult(auth, {
      outcome: 'ready',
      commit: 'a'.repeat(40),
      branch: 'main',
      setupDurationMs: 1,
    });
    await drive(harness);
    await expect(
      harness.stub.resolveSnapshot({
        reference: sessionReference(harness, 1),
        actorUserId: 'user-1',
      })
    ).resolves.toMatchObject({
      reason: 'eligible',
      snapshot: { revision: 1, stale: null },
      admission: { status: 'not_needed' },
    });

    harness.environment.revision = 2;
    const after = await harness.stub.resolveSnapshot({
      reference: sessionReference(harness, 2),
      actorUserId: 'user-1',
    });
    expect(after).toMatchObject({
      reason: 'eligible',
      snapshot: { revision: 1, stale: 'revision', baseImage: 'registry.example/runtime-free:1' },
      admission: { status: 'admitted' },
    });
    // An older admitted session never gets a newer snapshot.
    harness.environment.revision = 1;
  });

  it('skips a snapshot for another sandbox image and admits its replacement', async () => {
    const harness = await setup();
    const { auth } = await readyBuild(harness);
    await harness.stub.runnerResult(auth, {
      outcome: 'ready',
      commit: 'a'.repeat(40),
      branch: 'main',
      setupDurationMs: 1,
    });
    await drive(harness);

    harness.currentImage = 'registry.example/runtime-free:2';
    await expect(
      harness.stub.resolveSnapshot({
        reference: sessionReference(harness, 1),
        actorUserId: 'user-1',
      })
    ).resolves.toMatchObject({
      reason: 'incompatible',
      snapshot: null,
      admission: { status: 'admitted' },
    });
    const view = await status(harness);
    expect(view.published).toMatchObject({ revision: 1, stale: 'image' });
    expect(view.activeBuild).toMatchObject({ trigger: 'session', revision: 1 });
  });

  it('skips admission for a superseded session revision and for a deleted environment', async () => {
    const harness = await setup();
    harness.environment.revision = 3;
    await expect(
      harness.stub.resolveSnapshot({
        reference: sessionReference(harness, 2),
        actorUserId: 'user-1',
      })
    ).resolves.toMatchObject({ admission: { status: 'skipped', reason: 'revision_superseded' } });

    harness.environment.deleted = true;
    await harness.stub.environmentDeleted({ environmentId: harness.environmentId });
    await expect(
      harness.stub.resolveSnapshot({
        reference: sessionReference(harness, 3),
        actorUserId: 'user-1',
      })
    ).resolves.toMatchObject({ reason: 'deleted', admission: { status: 'skipped' } });
  });

  it('backs off a failed automatic build while a manual build still admits', async () => {
    const harness = await setup();
    const lookup = await harness.stub.resolveSnapshot({
      reference: sessionReference(harness, 1),
      actorUserId: 'user-1',
    });
    const buildId = (lookup.admission as { buildId: string }).buildId;
    await tick(harness);
    const auth = runnerAuth(harness, buildId);
    await harness.stub.runnerResult(auth, {
      outcome: 'failed',
      step: 'setup',
      reason: 'setup_failed',
    });
    await drive(harness);

    await expect(
      harness.stub.resolveSnapshot({
        reference: sessionReference(harness, 1),
        actorUserId: 'user-1',
      })
    ).resolves.toMatchObject({ admission: { status: 'skipped', reason: 'backoff' } });
    expect((await status(harness)).automaticBackoff).toMatchObject({ revision: 1, failures: 1 });
    await expect(manualBuild(harness)).resolves.toMatchObject({
      status: 'accepted',
      created: true,
    });
  });
});
