import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter, ProviderLaunchOptions } from '../../sandbox-control/provider.js';
import { DEADLINE_MS } from '../../sandbox-control/deadlines.js';
import { logger } from '../../logger.js';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

import { SandboxControlV2 } from './sandbox-do.js';

const SANDBOX_ID = 'sandbox-test';
const ALLOCATION_ID = 'allocation-test';
const selection = {
  source: 'environment' as const,
  candidate: {
    reference: {
      environmentId: '11111111-1111-4111-8111-111111111111',
      owner: { type: 'user' as const, id: 'user-test' },
      configurationRevision: 1,
      repository: { platform: 'github' as const, repoFullName: 'acme/widgets' },
    },
    actorUserId: 'user-test',
    buildCommands: 1,
  },
  buildId: null,
};
const launchOptions: ProviderLaunchOptions = {
  snapshot: { snapshotId: 'snapshot-test', baseImage: 'image-test' },
};
const input = {
  allocationId: ALLOCATION_ID,
  createdRef: 'ref-test',
  launchDeadline: 11_000,
  selection,
  launchEnv: {},
  startupCommand: { argv: ['test'] },
  startupCommandFor: async (launchDeadline: number) => ({
    argv: ['retry', String(launchDeadline)],
  }),
  launchOptions,
};
const RETRY_DEADLINE = 11_000 + DEADLINE_MS.repositoryStartup;

type SandboxUnit = {
  sandboxId: string;
  provider: Pick<ProviderAdapter, 'launch' | 'environmentSnapshots'>;
  readAllocation: () => Promise<{ kind: string; allocationId: string }>;
  stopRef: () => Promise<{ confirmed: boolean; errorName: string; cause: string }>;
  startSnapshotRetry: (
    allocationId: string,
    createDeadlineAt: number,
    step: 'restore' | 'environment_snapshot'
  ) => Promise<boolean>;
  notifySnapshotStartFailure: () => Promise<void>;
  failCreationRoutes: () => Promise<void>;
  launchWithSnapshotRetry: (request: typeof input) => Promise<unknown>;
  failSnapshotStart: (allocationId: string, error: unknown) => Promise<void>;
};

function unit(launch: ProviderAdapter['launch']) {
  const sandbox = Object.create(SandboxControlV2.prototype) as SandboxUnit;
  sandbox.sandboxId = SANDBOX_ID;
  sandbox.provider = { launch };
  sandbox.readAllocation = async () => ({ kind: 'creating', allocationId: ALLOCATION_ID });
  sandbox.stopRef = vi.fn(async () => ({
    confirmed: true,
    errorName: 'none',
    cause: 'stop_confirmed',
  }));
  sandbox.startSnapshotRetry = vi.fn(async () => true);
  sandbox.notifySnapshotStartFailure = vi.fn(async () => {});
  sandbox.failCreationRoutes = vi.fn(async () => {});
  return sandbox;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SandboxControlV2 snapshot start diagnostics', () => {
  it('preserves create-time snapshot launch errors without stopping or retrying launch', async () => {
    const error = new TypeError('provider rejected start');
    const launch = vi.fn(async () => {
      throw error;
    });
    const sandbox = unit(launch);
    sandbox.provider = { launch, environmentSnapshots: 'create' };

    await expect(sandbox.launchWithSnapshotRetry(input)).rejects.toBe(error);
    expect(sandbox.stopRef).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'DO launch deadline without a provider error',
      launch: vi.fn(() => new Promise<never>(() => {})),
      launchFailureStage: 'launch_deadline',
      launchErrorName: 'Error',
      launchCause: 'Sandbox_launch_timed_out',
      elapsedMs: 1_000,
    },
    {
      name: 'provider rejection before snapshot classification',
      launch: vi.fn(async () => {
        vi.setSystemTime(11_000);
        throw Object.assign(new Error('provider rejected start'), {
          name: 'ProviderRejectionError',
        });
      }),
      launchFailureStage: 'provider_rejection',
      launchErrorName: 'ProviderRejectionError',
      launchCause: 'provider_rejected_start',
      elapsedMs: 1_000,
    },
    {
      name: 'transient snapshot failure',
      launch: vi.fn(async () => ({
        startSource: 'repository' as const,
        snapshotFailed: true as const,
      })),
      launchFailureStage: 'provider_snapshot',
      launchErrorName: 'unknown',
      launchCause: 'transient',
      elapsedMs: 0,
    },
  ])(
    'records one failure and the blocked stage when the stop after $name fails',
    async scenario => {
      const fields = vi.spyOn(logger, 'withFields');
      const sandbox = unit(scenario.launch);
      sandbox.stopRef = vi.fn(async () => ({
        confirmed: false,
        errorName: 'none',
        cause: 'stop_not_confirmed',
      }));
      const failed = sandbox.launchWithSnapshotRetry(input).catch(error => error);
      await vi.advanceTimersByTimeAsync(1_000);
      const error = await failed;
      expect(error).toBeInstanceOf(Error);
      await sandbox.failSnapshotStart(ALLOCATION_ID, error);

      const records = fields.mock.calls.map(([record]) => record);
      expect(records.filter(record => record.diagnosticEvent === 'snapshot_launch_failed')).toEqual(
        [
          expect.objectContaining({
            sandboxId: SANDBOX_ID,
            allocationId: ALLOCATION_ID,
            source: 'environment',
            failureStage: 'retry_stop',
            reason: 'stop_failed',
            errorName: 'none',
            cause: 'stop_not_confirmed',
            launchFailureStage: scenario.launchFailureStage,
            launchErrorName: scenario.launchErrorName,
            launchCause: scenario.launchCause,
            attempt: 1,
            elapsedMs: scenario.elapsedMs,
          }),
        ]
      );
      expect(records.filter(record => record.diagnosticEvent === 'snapshot_start_blocked')).toEqual(
        [
          expect.objectContaining({
            reason: 'environment_snapshot_start_failed',
            failureStage: 'retry_stop',
            errorName: 'none',
            cause: 'stop_not_confirmed',
          }),
        ]
      );
      expect(scenario.launch).toHaveBeenCalledTimes(1);
      expect(sandbox.startSnapshotRetry).not.toHaveBeenCalled();
    }
  );

  it('gives a retry after a DO launch deadline its own deadline and startup command', async () => {
    const fields = vi.spyOn(logger, 'withFields');
    const calls: Array<{ argv: readonly string[]; deadlineAt: number | undefined }> = [];
    const launch = vi.fn<ProviderAdapter['launch']>((_ref, startup, options) => {
      calls.push({ argv: startup.command.argv, deadlineAt: options?.deadlineAt });
      return new Promise<never>(() => {});
    });
    const sandbox = unit(launch);
    const failed = sandbox
      .launchWithSnapshotRetry({
        ...input,
        launchOptions: { ...launchOptions, deadlineAt: 11_000 },
      })
      .catch(error => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sandbox.stopRef).toHaveBeenCalledTimes(1);
    expect(sandbox.startSnapshotRetry).toHaveBeenCalledWith(
      ALLOCATION_ID,
      RETRY_DEADLINE,
      'environment_snapshot'
    );
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.repositoryStartup);
    expect(await failed).toMatchObject({ reason: 'transient' });

    expect(calls).toEqual([
      { argv: ['test'], deadlineAt: 11_000 },
      { argv: ['retry', String(RETRY_DEADLINE)], deadlineAt: RETRY_DEADLINE },
    ]);
    expect(sandbox.stopRef).toHaveBeenCalledTimes(1);
    const records = fields.mock.calls.map(([record]) => record);
    expect(records.filter(record => record.diagnosticEvent === 'snapshot_launch_retry')).toEqual([
      expect.objectContaining({
        allocationId: ALLOCATION_ID,
        attempt: 2,
        previousDeadlineAt: 11_000,
        deadlineAt: RETRY_DEADLINE,
      }),
    ]);
    expect(
      records
        .filter(record => record.diagnosticEvent === 'snapshot_launch_failed')
        .map(record => [record.attempt, record.failureStage])
    ).toEqual([
      [1, 'launch_deadline'],
      [2, 'launch_deadline'],
    ]);
  });

  it('does not relaunch when the allocation changes before the retry deadline moves', async () => {
    const fields = vi.spyOn(logger, 'withFields');
    const launch = vi.fn(async () => {
      throw new TypeError('provider rejected start');
    });
    const sandbox = unit(launch);
    sandbox.startSnapshotRetry = vi.fn(async () => false);
    await expect(sandbox.launchWithSnapshotRetry(input)).resolves.toMatchObject({ owned: true });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(
      fields.mock.calls
        .map(([record]) => record)
        .filter(record => record.diagnosticEvent === 'snapshot_launch_failed')
    ).toEqual([
      expect.objectContaining({
        failureStage: 'allocation_owned',
        reason: 'allocation_owned',
        attempt: 1,
      }),
    ]);
  });

  it('does not stop or relaunch an allocation owned by a connected wrapper', async () => {
    const fields = vi.spyOn(logger, 'withFields');
    const launch = vi.fn(async () => {
      throw new TypeError('provider rejected start');
    });
    const sandbox = unit(launch);
    sandbox.readAllocation = async () => ({ kind: 'connected', allocationId: ALLOCATION_ID });
    await expect(sandbox.launchWithSnapshotRetry(input)).resolves.toMatchObject({ owned: true });
    expect(sandbox.stopRef).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(
      fields.mock.calls
        .map(([record]) => record)
        .filter(record => record.diagnosticEvent === 'snapshot_launch_failed')
    ).toEqual([
      expect.objectContaining({
        failureStage: 'allocation_owned',
        reason: 'allocation_owned',
        errorName: 'TypeError',
        cause: 'provider_rejected_start',
        attempt: 1,
      }),
    ]);
  });

  it('keeps the same snapshot and gives the bounded second attempt its own deadline', async () => {
    const fields = vi.spyOn(logger, 'withFields');
    const options: Array<ProviderLaunchOptions | undefined> = [];
    const launch = vi.fn<ProviderAdapter['launch']>(async (_ref, _startup, launchOptions) => {
      options.push(launchOptions);
      if (options.length === 1) throw new TypeError('provider rejected start');
      return { startSource: 'repository' };
    });
    const sandbox = unit(launch);
    await expect(
      sandbox.launchWithSnapshotRetry({
        ...input,
        launchOptions: { ...launchOptions, deadlineAt: input.launchDeadline },
      })
    ).resolves.toMatchObject({ owned: false });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(sandbox.stopRef).toHaveBeenCalledTimes(1);
    expect(options.map(option => option?.snapshot)).toEqual([
      input.launchOptions.snapshot,
      input.launchOptions.snapshot,
    ]);
    expect(options.map(option => option?.deadlineAt)).toEqual([
      input.launchDeadline,
      10_000 + DEADLINE_MS.repositoryStartup,
    ]);
    expect(options.map(option => option?.snapshotDiagnostic)).toEqual([
      { allocationId: ALLOCATION_ID, source: 'environment', attempt: 1, startedAt: 10_000 },
      { allocationId: ALLOCATION_ID, source: 'environment', attempt: 2, startedAt: 10_000 },
    ]);
    expect(
      fields.mock.calls
        .map(([record]) => record)
        .filter(record => record.diagnosticEvent === 'snapshot_launch_failed')
    ).toHaveLength(1);
  });

  it('records a deadline before the first provider call', async () => {
    const fields = vi.spyOn(logger, 'withFields');
    const launch = vi.fn<ProviderAdapter['launch']>();
    const sandbox = unit(launch);
    await expect(
      sandbox.launchWithSnapshotRetry({ ...input, launchDeadline: 10_000 })
    ).rejects.toThrow('Snapshot start failed');
    expect(launch).not.toHaveBeenCalled();
    expect(
      fields.mock.calls
        .map(([record]) => record)
        .filter(record => record.diagnosticEvent === 'snapshot_launch_failed')
    ).toEqual([
      expect.objectContaining({
        failureStage: 'launch_deadline',
        reason: 'launch_deadline',
        errorName: 'Error',
        cause: 'Sandbox_launch_timed_out',
        attempt: 1,
        elapsedMs: 0,
      }),
    ]);
  });

  it('records the ownership race during retry without stopping or relaunching', async () => {
    const fields = vi.spyOn(logger, 'withFields');
    const launch = vi.fn(async () => {
      throw new TypeError('provider rejected start');
    });
    const sandbox = unit(launch);
    sandbox.readAllocation = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'creating', allocationId: ALLOCATION_ID })
      .mockResolvedValue({ kind: 'connected', allocationId: ALLOCATION_ID });
    await expect(sandbox.launchWithSnapshotRetry(input)).resolves.toMatchObject({ owned: true });
    expect(sandbox.stopRef).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(
      fields.mock.calls
        .map(([record]) => record)
        .filter(record => record.diagnosticEvent === 'snapshot_launch_failed')
    ).toEqual([
      expect.objectContaining({
        failureStage: 'allocation_owned',
        reason: 'allocation_owned',
        errorName: 'TypeError',
        cause: 'provider_rejected_start',
      }),
    ]);
  });

  it('preserves a provider rejection when the retry stop fails', async () => {
    const fields = vi.spyOn(logger, 'withFields');
    const sandbox = unit(async () => {
      throw new TypeError('provider rejected start');
    });
    sandbox.stopRef = async () => ({
      confirmed: false,
      errorName: 'none',
      cause: 'stop_not_confirmed',
    });
    await expect(sandbox.launchWithSnapshotRetry(input)).rejects.toThrow('Snapshot start failed');
    expect(
      fields.mock.calls
        .map(([record]) => record)
        .filter(record => record.diagnosticEvent === 'snapshot_launch_failed')
    ).toEqual([
      expect.objectContaining({
        failureStage: 'retry_stop',
        reason: 'stop_failed',
        launchFailureStage: 'provider_rejection',
        launchErrorName: 'TypeError',
        launchCause: 'provider_rejected_start',
      }),
    ]);
  });

  it('bounds and sanitizes provider error names and causes', async () => {
    const fields = vi.spyOn(logger, 'withFields');
    const sandbox = unit(async () => {
      vi.setSystemTime(11_000);
      throw Object.assign(new Error('provider rejected start '.repeat(100)), {
        name: 'Provider Error '.repeat(100),
      });
    });
    await expect(sandbox.launchWithSnapshotRetry(input)).rejects.toThrow('Snapshot start failed');
    const records = fields.mock.calls
      .map(([record]) => record)
      .filter(record => record.diagnosticEvent === 'snapshot_launch_failed');
    expect(records).toEqual(
      [1, 2].map(attempt =>
        expect.objectContaining({
          attempt,
          errorName: 'Provider_Error_'.repeat(100).slice(0, 128),
          cause: 'provider_rejected_start_'.repeat(100).slice(0, 128),
        })
      )
    );
  });
});
