import { describe, expect, it } from 'vitest';
import { CONTROL_SUPERVISOR_PATH } from './container-paths.js';
import {
  bakedLaunchCommand,
  launchSandbox,
  resolveRuntimeLaunchSelection,
  runtimeLaunchStartCommand,
  type RuntimeLaunchOps,
  type RuntimeLaunchRequest,
  type RuntimeLaunchResult,
  type RuntimeReserveResult,
  type RuntimeStartResult,
} from './runtime-launch.js';
import type { RuntimeLaunchObservation } from './runtime-launch-phase.js';
import type { RuntimeArtifactReader } from './runtime-release-loader.js';

/**
 * The common launch workflow driven through its one entrypoint with a stateful
 * fake provider. The fake carries scripted reserve/start/observe/settle/ack
 * history so the cases assert required behavior, not draft accidents.
 */

const LAUNCH_ID = 'launch-0001';
const ROTATED_ID = 'launch-0002';
const DEADLINE = Date.now() + 100_000;
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const DESCRIPTOR = JSON.stringify({
  format: 1,
  bootstrap: 1,
  platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
  abi: 'kilo-runtime-base-v1',
  cliVersion: '1.0.0',
  cliExecutable: 'kilo',
  wrapperSdkVersion: '1.0.0',
  protocol: 'v1',
  artifacts: [
    { role: 'cli', sha256: SHA_A, transferBytes: 10, expandedBytes: 4, fileCount: 1 },
    { role: 'control', sha256: SHA_B, transferBytes: 10, expandedBytes: 4, fileCount: 1 },
  ],
  caps: { maxTransferBytes: 100, maxExpandedBytes: 100, maxFileCount: 10 },
  inventory: [
    ['cli', 'kilo', 0o755, 4, SHA_A],
    ['control', 'x/y', 0o644, 4, SHA_B],
  ],
});
const ORIGIN = 'https://runtime.example.com';

const release = () => ({
  kind: 'release' as const,
  descriptor: DESCRIPTOR,
  artifactOrigin: ORIGIN,
  bootstrapContract: 1 as const,
});

function trackedReader(found: boolean): { reader: RuntimeArtifactReader; count: () => number } {
  let heads = 0;
  return {
    count: () => heads,
    reader: {
      async head() {
        heads += 1;
        return found ? { size: 10 } : null;
      },
    },
  };
}

type Attempt = {
  start: RuntimeStartResult;
  /** Observations returned in order; the last one repeats. */
  observations: RuntimeLaunchObservation[];
};

type Script = {
  reserves: RuntimeReserveResult[];
  attempts: Attempt[];
  settle?: (result: RuntimeLaunchResult) => boolean;
  ackThrows?: boolean;
  destroyOk?: boolean;
  order?: string[];
};

function fakeOps(script: Script) {
  const calls = {
    reserve: [] as {
      launchId: string;
      outerDeadlineAt: number;
      skipRepository?: true;
    }[],
    start: [] as { command: string; env: Record<string, string>; failureRetention: boolean }[],
    observe: 0,
    settle: [] as RuntimeLaunchResult[],
    ack: [] as { launchId: string; receipt?: string }[],
    retire: [] as { providerRef: string; launchId: string; outerDeadlineAt: number }[],
    destroy: [] as { providerRef: string; launchId: string; outerDeadlineAt: number }[],
  };
  let attempt = 0;
  let observeIndex = 0;
  const ops: RuntimeLaunchOps = {
    async reserveLaunch(input) {
      script.order?.push('reserve');
      calls.reserve.push({
        launchId: input.launchId,
        outerDeadlineAt: input.outerDeadlineAt,
        ...(input.skipRepository === undefined ? {} : { skipRepository: input.skipRepository }),
      });
      return script.reserves[calls.reserve.length - 1] ?? { kind: 'unavailable', reason: 'none' };
    },
    async startLaunch(input) {
      calls.start.push({
        command: input.command,
        env: input.env,
        failureRetention: input.failureRetention,
      });
      attempt = calls.start.length - 1;
      observeIndex = 0;
      return script.attempts[attempt]?.start ?? { kind: 'issued' };
    },
    async observeLaunch() {
      const observations = script.attempts[attempt]?.observations ?? [{ process: 'running' }];
      const value = observations[Math.min(observeIndex, observations.length - 1)];
      observeIndex += 1;
      calls.observe += 1;
      return value;
    },
    async settleLaunch({ result }) {
      calls.settle.push(result);
      return script.settle ? script.settle(result) : true;
    },
    async acknowledgeLaunch(input) {
      calls.ack.push(input);
      if (script.ackThrows) throw new Error('ack failed');
    },
    async retireLaunch(input) {
      calls.retire.push(input);
    },
    async destroyLaunch(input) {
      calls.destroy.push(input);
      return script.destroyOk ?? true;
    },
  };
  return { ops, calls };
}

function request(
  ops: RuntimeLaunchOps | undefined,
  overrides: Partial<RuntimeLaunchRequest> = {}
): RuntimeLaunchRequest {
  return {
    ops,
    selection: { kind: 'baked' },
    allocationId: 'alloc-1',
    launchId: LAUNCH_ID,
    outerDeadlineAt: DEADLINE,
    reader: trackedReader(true).reader,
    effects: {
      grantSecret: async () => 'secret',
      onReserved: async () => true,
    },
    launchEnv: { CALLER: 'value' },
    clock: { now: () => 0, sleep: async () => undefined },
    ...overrides,
  };
}

const handoffFor = (launchId: string) => JSON.stringify({ launchId, outcome: 'handoff' });
const failed = (code: number, id = LAUNCH_ID) =>
  JSON.stringify({ launchId: id, outcome: 'installer_failed', code });

describe('resolveRuntimeLaunchSelection', () => {
  it('selects a release only for a valid descriptor and trusted HTTPS origin', () => {
    expect(
      resolveRuntimeLaunchSelection({ descriptor: DESCRIPTOR, artifactOrigin: ORIGIN })
    ).toEqual(release());
  });

  it('selects baked only when both are absent', () => {
    expect(
      resolveRuntimeLaunchSelection({ descriptor: undefined, artifactOrigin: undefined })
    ).toEqual({ kind: 'baked' });
  });

  it('fails closed on an incomplete or invalid explicit configuration', () => {
    expect(() =>
      resolveRuntimeLaunchSelection({ descriptor: DESCRIPTOR, artifactOrigin: undefined })
    ).toThrow();
    expect(() =>
      resolveRuntimeLaunchSelection({ descriptor: DESCRIPTOR, artifactOrigin: 'http://insecure' })
    ).toThrow();
    expect(() =>
      resolveRuntimeLaunchSelection({ descriptor: undefined, artifactOrigin: ORIGIN })
    ).toThrow();
    expect(() =>
      resolveRuntimeLaunchSelection({ descriptor: '{"format":1}', artifactOrigin: ORIGIN })
    ).toThrow();
  });
});

describe('bakedLaunchCommand', () => {
  it('is the canonical supervisor exec with no installer or artifact material', () => {
    const command = bakedLaunchCommand();
    expect(command).toBe(`exec /bin/sh ${CONTROL_SUPERVISOR_PATH}`);
    expect(command).not.toContain('install');
    expect(command).not.toContain('KILO_RUNTIME_');
  });
});

describe('runtimeLaunchStartCommand', () => {
  it('inlines descriptor, origin and grant into the command, never an env object', () => {
    const command = runtimeLaunchStartCommand({
      launchId: LAUNCH_ID,
      deadlineAt: DEADLINE,
      failureRetention: true,
      descriptor: DESCRIPTOR,
      origin: ORIGIN,
      grant: 'grant-token',
    });
    expect(command).toContain('KILO_RUNTIME_DESCRIPTOR=');
    expect(command).toContain('KILO_RUNTIME_ARTIFACT_ORIGIN=');
    expect(command).toContain('KILO_RUNTIME_ARTIFACT_GRANT=');
    expect(command).toContain('grant-token');
    expect(command).toContain(`launch_id='${LAUNCH_ID}'`);
  });
});

describe('launchSandbox', () => {
  it('starts baked with the canonical supervisor command and no artifact preflight', async () => {
    const reader = trackedReader(true);
    const grantSecret = { count: 0 };
    const { ops, calls } = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-1',
          startSource: 'image',
          attemptDeadlineAt: DEADLINE,
        },
      ],
      attempts: [{ start: { kind: 'issued' }, observations: [{ process: 'supervisor' }] }],
    });
    const result = await launchSandbox(
      request(ops, {
        reader: reader.reader,
        effects: {
          grantSecret: async () => {
            grantSecret.count += 1;
            return 'secret';
          },
          onReserved: async () => true,
        },
      })
    );
    expect(result).toEqual({ kind: 'handoff', startSource: 'image' });
    expect(calls.start[0].command).toBe(`exec /bin/sh ${CONTROL_SUPERVISOR_PATH}`);
    expect(calls.start[0].env).toEqual({ CALLER: 'value' });
    expect(reader.count()).toBe(0);
    expect(grantSecret.count).toBe(0);
    expect(calls.settle).toEqual([{ kind: 'handoff', startSource: 'image' }]);
    expect(calls.ack).toEqual([]);
  });

  it('reserves and commits the ref before the delayed artifact preflight', async () => {
    const order: string[] = [];
    const { ops } = fakeOps({
      order,
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-1',
          startSource: 'repository',
          attemptDeadlineAt: DEADLINE,
        },
      ],
      attempts: [
        {
          start: { kind: 'issued' },
          observations: [{ receipt: handoffFor(LAUNCH_ID), process: 'supervisor' }],
        },
      ],
    });
    const result = await launchSandbox(
      request(ops, {
        selection: release(),
        reader: {
          async head() {
            if (order[order.length - 1] !== 'preflight') order.push('preflight');
            return { size: 10 };
          },
        },
        effects: {
          grantSecret: async () => 'secret',
          onReserved: async () => {
            order.push('onReserved');
            return true;
          },
        },
      })
    );
    expect(result).toEqual({ kind: 'handoff', startSource: 'repository' });
    expect(order).toEqual(['reserve', 'onReserved', 'preflight']);
  });

  it('reconciles an unknown start by observation and never repeats the start', async () => {
    const { ops, calls } = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-1',
          startSource: 'repository',
          attemptDeadlineAt: DEADLINE,
        },
      ],
      attempts: [
        {
          start: { kind: 'unknown', reason: 'transport' },
          observations: [{ receipt: handoffFor(LAUNCH_ID), process: 'supervisor' }],
        },
      ],
    });
    const result = await launchSandbox(request(ops, { selection: release() }));
    expect(result).toEqual({ kind: 'handoff', startSource: 'repository' });
    expect(calls.start).toHaveLength(1);
    expect(calls.settle).toEqual([{ kind: 'handoff', startSource: 'repository' }]);
  });

  it('does not treat a handoff receipt without supervisor PID1 as success', async () => {
    const runningClock = { now: () => DEADLINE, sleep: async () => undefined };
    const running = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-1',
          startSource: 'image',
          attemptDeadlineAt: DEADLINE,
        },
      ],
      attempts: [
        {
          start: { kind: 'issued' },
          observations: [{ receipt: handoffFor(LAUNCH_ID), process: 'running' }],
        },
      ],
    });
    expect(
      await launchSandbox(request(running.ops, { selection: release(), clock: runningClock }))
    ).toEqual({ kind: 'deadline' });

    const terminal = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-1',
          startSource: 'image',
          attemptDeadlineAt: DEADLINE,
        },
      ],
      attempts: [
        {
          start: { kind: 'issued' },
          observations: [{ receipt: handoffFor(LAUNCH_ID), process: 'terminal' }],
        },
      ],
    });
    expect(await launchSandbox(request(terminal.ops, { selection: release() }))).toEqual({
      kind: 'bootstrap-failed',
    });
  });

  it('lets a typed failure receipt win even while supervisor PID1 is alive', async () => {
    const { ops, calls } = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-1',
          startSource: 'repository',
          attemptDeadlineAt: DEADLINE,
        },
      ],
      attempts: [
        {
          start: { kind: 'issued' },
          observations: [{ receipt: failed(71), process: 'supervisor' }],
        },
      ],
    });
    const result = await launchSandbox(
      request(ops, { selection: release(), failureRetention: true })
    );
    expect(result).toEqual({ kind: 'installer-failed', reason: 'runtime_artifact_unauthorized' });
    expect(calls.settle).toEqual([
      { kind: 'installer-failed', reason: 'runtime_artifact_unauthorized' },
    ]);
    expect(calls.ack).toEqual([{ launchId: LAUNCH_ID, receipt: failed(71) }]);
  });

  it('never fabricates a typed failure from a foreign receipt or a terminal process', async () => {
    const { ops } = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-1',
          startSource: 'image',
          attemptDeadlineAt: DEADLINE,
        },
      ],
      attempts: [
        {
          start: { kind: 'issued' },
          observations: [
            {
              receipt: JSON.stringify({ launchId: 'someone-else', outcome: 'handoff' }),
              process: 'terminal',
            },
          ],
        },
      ],
    });
    expect(await launchSandbox(request(ops, { selection: release() }))).toEqual({
      kind: 'bootstrap-failed',
    });
  });

  it('never acknowledges a rejected settlement and reports ownership lost', async () => {
    const { ops, calls } = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-1',
          startSource: 'image',
          attemptDeadlineAt: DEADLINE,
        },
      ],
      attempts: [
        {
          start: { kind: 'issued' },
          observations: [{ receipt: failed(73), process: 'running' }],
        },
      ],
      settle: () => false,
    });
    const result = await launchSandbox(
      request(ops, { selection: release(), failureRetention: true })
    );
    expect(result).toEqual({ kind: 'ownership-lost' });
    expect(calls.ack).toEqual([]);
  });

  it('does not start after the owner retires the reserved token', async () => {
    const { ops, calls } = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-1',
          startSource: 'image',
          attemptDeadlineAt: DEADLINE,
        },
      ],
      attempts: [],
    });
    const result = await launchSandbox(
      request(ops, {
        effects: {
          grantSecret: async () => 'secret',
          onReserved: async () => false,
        },
      })
    );
    expect(result).toEqual({ kind: 'ownership-lost' });
    expect(calls.start).toHaveLength(0);
    expect(calls.settle).toHaveLength(0);
  });

  it('fails an explicit release before any physical work when no ops are supplied', async () => {
    const result = await launchSandbox(request(undefined, { selection: release() }));
    expect(result).toEqual({ kind: 'unsupported-release' });
  });

  it('reports a recoverable reservation failure with no physical start', async () => {
    const { ops, calls } = fakeOps({
      reserves: [{ kind: 'unavailable', reason: 'admission' }],
      attempts: [],
    });
    const result = await launchSandbox(request(ops));
    expect(result).toEqual({ kind: 'reservation-failed', reason: 'admission' });
    expect(calls.start).toHaveLength(0);
  });

  it('fails a present but unpublished descriptor after reserving and before start', async () => {
    const { ops, calls } = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-1',
          startSource: 'repository',
          attemptDeadlineAt: DEADLINE,
        },
      ],
      attempts: [],
    });
    const result = await launchSandbox(
      request(ops, { selection: release(), reader: trackedReader(false).reader })
    );
    expect(result).toEqual({ kind: 'installer-failed', reason: 'runtime_artifact_missing' });
    expect(calls.reserve).toHaveLength(1);
    expect(calls.start).toHaveLength(0);
  });

  it('falls back to the image once with a fresh nonce, env and grant under the same outer deadline', async () => {
    const grantSecret = { count: 0 };
    const { ops, calls } = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-repo',
          startSource: 'repository',
          attemptDeadlineAt: DEADLINE,
        },
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-image',
          startSource: 'image',
          attemptDeadlineAt: DEADLINE,
        },
      ],
      attempts: [
        { start: { kind: 'snapshot-failed' }, observations: [] },
        {
          start: { kind: 'issued' },
          observations: [{ receipt: handoffFor(ROTATED_ID), process: 'supervisor' }],
        },
      ],
    });
    const rotated = { count: 0 };
    const result = await launchSandbox(
      request(ops, {
        selection: release(),
        repoKey: 'repo-key',
        effects: {
          grantSecret: async () => {
            grantSecret.count += 1;
            return 'secret';
          },
          onReserved: async () => true,
          rotateFallbackNonce: async ({ previousLaunchId, outerDeadlineAt }) => {
            rotated.count += 1;
            expect(previousLaunchId).toBe(LAUNCH_ID);
            expect(outerDeadlineAt).toBe(DEADLINE);
            return { launchId: ROTATED_ID, launchEnv: { CALLER: 'rotated' } };
          },
        },
      })
    );
    expect(result).toEqual({ kind: 'handoff', startSource: 'image' });
    expect(rotated.count).toBe(1);
    expect(calls.destroy).toEqual([
      { providerRef: 'ref-repo', launchId: LAUNCH_ID, outerDeadlineAt: DEADLINE },
    ]);
    expect(calls.reserve[1]).toEqual({
      launchId: ROTATED_ID,
      outerDeadlineAt: DEADLINE,
      skipRepository: true,
    });
    expect(calls.start[1].env).toEqual({ CALLER: 'rotated' });
    expect(calls.start[1].command).toContain(`launch_id='${ROTATED_ID}'`);
    expect(calls.start[1].command).toContain('KILO_RUNTIME_ARTIFACT_GRANT=');
    // A fresh grant is minted for the image attempt.
    expect(grantSecret.count).toBe(2);
  });

  it('never falls back for a typed installer failure', async () => {
    const { ops, calls } = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-repo',
          startSource: 'repository',
          attemptDeadlineAt: DEADLINE,
        },
      ],
      attempts: [
        {
          start: { kind: 'issued' },
          observations: [{ receipt: failed(77), process: 'supervisor' }],
        },
      ],
    });
    const result = await launchSandbox(
      request(ops, {
        selection: release(),
        repoKey: 'repo-key',
        effects: {
          grantSecret: async () => 'secret',
          onReserved: async () => true,
          rotateFallbackNonce: async () => ({ launchId: ROTATED_ID, launchEnv: {} }),
        },
      })
    );
    expect(result).toEqual({ kind: 'installer-failed', reason: 'runtime_supervisor_missing' });
    expect(calls.destroy).toHaveLength(0);
    expect(calls.start).toHaveLength(1);
  });

  it('reports snapshot failure without fallback when no rotation effect exists', async () => {
    const { ops, calls } = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-repo',
          startSource: 'repository',
          attemptDeadlineAt: DEADLINE,
        },
      ],
      attempts: [{ start: { kind: 'snapshot-failed' }, observations: [] }],
    });
    const result = await launchSandbox(request(ops, { repoKey: 'repo-key' }));
    expect(result).toEqual({ kind: 'snapshot-failed' });
    expect(calls.destroy).toHaveLength(0);
    expect(calls.start).toHaveLength(1);
  });
  it('does zero physical work when the attempt bound is already past', async () => {
    const past = Date.now() - 1;
    const { ops, calls } = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-1',
          startSource: 'image',
          attemptDeadlineAt: past,
        },
      ],
      attempts: [],
    });
    const result = await launchSandbox(request(ops, { outerDeadlineAt: DEADLINE }));
    expect(result).toEqual({ kind: 'deadline' });
    expect(calls.start).toHaveLength(0);
    expect(calls.settle).toEqual([{ kind: 'deadline' }]);
  });

  it('settles an exact deadline result when attempt equals the outer bound', async () => {
    const deadline = Date.now() - 1;
    const { ops, calls } = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-1',
          startSource: 'image',
          attemptDeadlineAt: deadline,
        },
      ],
      attempts: [],
    });
    const result = await launchSandbox(
      request(ops, {
        outerDeadlineAt: deadline,
        effects: { grantSecret: async () => 'secret', onReserved: async () => true },
      })
    );
    expect(result).toEqual({ kind: 'deadline' });
    expect(calls.start).toHaveLength(0);
  });

  it('replays an exact settled outcome with no preflight, grant, start or settle', async () => {
    const reader = trackedReader(true);
    const { ops, calls } = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'settled',
          providerRef: 'ref-1',
          startSource: 'repository',
          attemptDeadlineAt: DEADLINE,
          outcome: { kind: 'installer-failed', reason: 'runtime_artifact_unauthorized' },
        },
      ],
      attempts: [],
    });
    const phases: string[] = [];
    const result = await launchSandbox(
      request(ops, {
        selection: release(),
        reader: reader.reader,
        effects: {
          grantSecret: async () => 'secret',
          onReserved: async ({ phase }) => {
            phases.push(phase);
            return true;
          },
        },
      })
    );
    expect(result).toEqual({ kind: 'installer-failed', reason: 'runtime_artifact_unauthorized' });
    expect(phases).toEqual(['settled']);
    expect(reader.count()).toBe(0);
    expect(calls.start).toHaveLength(0);
    expect(calls.settle).toHaveLength(0);
  });

  it('reconciles an already-issued reentry without a second physical start or preflight', async () => {
    const reader = trackedReader(true);
    const { ops, calls } = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'issued',
          providerRef: 'ref-1',
          startSource: 'repository',
          attemptDeadlineAt: DEADLINE,
          start: { kind: 'unknown', reason: 'transport' },
        },
      ],
      attempts: [
        {
          start: { kind: 'issued' },
          observations: [{ receipt: handoffFor(LAUNCH_ID), process: 'supervisor' }],
        },
      ],
    });
    const result = await launchSandbox(
      request(ops, { selection: release(), reader: reader.reader })
    );
    expect(result).toEqual({ kind: 'handoff', startSource: 'repository' });
    expect(reader.count()).toBe(0);
    expect(calls.start).toHaveLength(0);
    expect(calls.observe).toBeGreaterThan(0);
  });

  it('ends a refused start as ownership lost with zero observations', async () => {
    const { ops, calls } = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-1',
          startSource: 'image',
          attemptDeadlineAt: DEADLINE,
        },
      ],
      attempts: [{ start: { kind: 'refused', reason: 'stale_token' }, observations: [] }],
    });
    const result = await launchSandbox(request(ops));
    expect(result).toEqual({ kind: 'ownership-lost' });
    expect(calls.observe).toBe(0);
    expect(calls.settle).toHaveLength(0);
  });

  it('ends a retired observation immediately as ownership lost', async () => {
    const { ops, calls } = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-1',
          startSource: 'image',
          attemptDeadlineAt: DEADLINE,
        },
      ],
      attempts: [
        { start: { kind: 'issued' }, observations: [{ retired: true, process: 'unknown' }] },
      ],
    });
    const result = await launchSandbox(request(ops));
    expect(result).toEqual({ kind: 'ownership-lost' });
    expect(calls.observe).toBe(1);
    expect(calls.settle).toHaveLength(0);
  });

  it('retires its own reservation when the owner refuses the commit', async () => {
    const { ops, calls } = fakeOps({
      reserves: [
        {
          kind: 'reserved',
          phase: 'reserved',
          providerRef: 'ref-1',
          startSource: 'image',
          attemptDeadlineAt: DEADLINE,
        },
      ],
      attempts: [],
    });
    const result = await launchSandbox(
      request(ops, {
        effects: { grantSecret: async () => 'secret', onReserved: async () => false },
      })
    );
    expect(result).toEqual({ kind: 'ownership-lost' });
    expect(calls.retire).toEqual([
      { providerRef: 'ref-1', launchId: LAUNCH_ID, outerDeadlineAt: DEADLINE },
    ]);
    expect(calls.start).toHaveLength(0);
  });
});
