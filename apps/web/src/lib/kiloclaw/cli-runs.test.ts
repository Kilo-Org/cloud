process.env.KILOCLAW_API_URL ||= 'http://localhost:8795';
process.env.KILOCLAW_INTERNAL_API_SECRET ||= 'test-secret';

import { describe, expect, it } from '@jest/globals';
import { db } from '@/lib/drizzle';
import {
  cancelCliRun,
  createCliRun,
  getCliRunInitiatedBy,
  getCliRunStatus,
  markCliRunCancelled,
  shouldPersistCliRunControllerStatus,
} from '@/lib/kiloclaw/cli-runs';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { kiloclaw_cli_runs, kiloclaw_instances } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

async function createTestInstance(userId: string): Promise<string> {
  const [row] = await db
    .insert(kiloclaw_instances)
    .values({
      id: crypto.randomUUID(),
      user_id: userId,
      sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
    })
    .returning({ id: kiloclaw_instances.id });

  if (!row) {
    throw new Error('Failed to create KiloClaw test instance');
  }

  return row.id;
}

async function getRunStatus(runId: string) {
  const [row] = await db
    .select({
      status: kiloclaw_cli_runs.status,
      completed_at: kiloclaw_cli_runs.completed_at,
    })
    .from(kiloclaw_cli_runs)
    .where(eq(kiloclaw_cli_runs.id, runId))
    .limit(1);

  if (!row) {
    throw new Error('Failed to load KiloClaw CLI run');
  }

  return {
    ...row,
    completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

async function getRunRow(runId: string) {
  const [row] = await db
    .select({
      status: kiloclaw_cli_runs.status,
      completed_at: kiloclaw_cli_runs.completed_at,
      output: kiloclaw_cli_runs.output,
      exit_code: kiloclaw_cli_runs.exit_code,
    })
    .from(kiloclaw_cli_runs)
    .where(eq(kiloclaw_cli_runs.id, runId))
    .limit(1);

  if (!row) {
    throw new Error('Failed to load KiloClaw CLI run');
  }

  return {
    ...row,
    completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

describe('cancelCliRun', () => {
  it('persists terminal controller status without calling cancel when the run already finished', async () => {
    const user = await insertTestUser();
    const instanceId = await createTestInstance(user.id);
    const startedAt = '2026-04-12T12:00:00.000Z';
    const runId = await createCliRun({
      userId: user.id,
      instanceId,
      prompt: 'run that completed before cancel',
      startedAt,
      initiatedByAdminId: null,
    });
    const cancelControllerRun = jest.fn(async () => ({ ok: true }));

    await expect(
      cancelCliRun({
        runId,
        userId: user.id,
        instanceId,
        workerInstanceId: 'ki_current',
        getControllerStatus: async () => ({
          hasRun: true,
          status: 'completed',
          output: 'done',
          exitCode: 0,
          startedAt,
          completedAt: '2026-04-12T12:01:00.000Z',
          prompt: 'run that completed before cancel',
        }),
        cancelControllerRun,
      })
    ).resolves.toEqual({ ok: true, runFound: true, cancelled: false });

    expect(cancelControllerRun).not.toHaveBeenCalled();
    await expect(getRunStatus(runId)).resolves.toEqual({
      status: 'completed',
      completed_at: '2026-04-12T12:01:00.000Z',
    });
  });

  it('persists failed and does not cancel when controller has no active run', async () => {
    const user = await insertTestUser();
    const instanceId = await createTestInstance(user.id);
    const runId = await createCliRun({
      userId: user.id,
      instanceId,
      prompt: 'lost run before cancel',
      startedAt: '2026-04-12T12:00:00.000Z',
      initiatedByAdminId: null,
    });
    const cancelControllerRun = jest.fn(async () => ({ ok: true }));

    await expect(
      cancelCliRun({
        runId,
        userId: user.id,
        instanceId,
        workerInstanceId: 'ki_current',
        getControllerStatus: async () => ({
          hasRun: false,
          status: null,
          output: null,
          exitCode: null,
          startedAt: null,
          completedAt: null,
          prompt: null,
        }),
        cancelControllerRun,
      })
    ).resolves.toEqual({ ok: true, runFound: true, cancelled: false });

    expect(cancelControllerRun).not.toHaveBeenCalled();

    const row = await getRunRow(runId);
    expect(row.status).toBe('failed');
    expect(row.output).toBe(
      '[run state unavailable: controller no longer has an active CLI run for this record]'
    );
    expect(row.completed_at).not.toBeNull();
  });

  it('persists failed and does not cancel when controller timestamp belongs to a different run', async () => {
    const user = await insertTestUser();
    const instanceId = await createTestInstance(user.id);
    const runId = await createCliRun({
      userId: user.id,
      instanceId,
      prompt: 'stale running row',
      startedAt: '2026-04-12T12:00:00.000Z',
      initiatedByAdminId: null,
    });
    const cancelControllerRun = jest.fn(async () => ({ ok: true }));

    await expect(
      cancelCliRun({
        runId,
        userId: user.id,
        instanceId,
        workerInstanceId: 'ki_current',
        getControllerStatus: async () => ({
          hasRun: true,
          status: 'running',
          output: null,
          exitCode: null,
          startedAt: '2026-04-12T12:05:00.000Z',
          completedAt: null,
          prompt: 'newer run',
        }),
        cancelControllerRun,
      })
    ).resolves.toEqual({ ok: true, runFound: true, cancelled: false });

    expect(cancelControllerRun).not.toHaveBeenCalled();

    const row = await getRunRow(runId);
    expect(row.status).toBe('failed');
    expect(row.output).toBe('[run state unavailable: controller has moved on to a newer run]');
    expect(row.completed_at).not.toBeNull();
  });

  it('preserves existing partial output when controller reports hasRun: false during cancel', async () => {
    const user = await insertTestUser();
    const instanceId = await createTestInstance(user.id);
    const runId = await createCliRun({
      userId: user.id,
      instanceId,
      prompt: 'run with partial output before lost',
      startedAt: '2026-04-12T12:00:00.000Z',
      initiatedByAdminId: null,
    });

    // Simulate partial output already written to the row while it was running.
    await db
      .update(kiloclaw_cli_runs)
      .set({ output: 'partial output before cancel' })
      .where(eq(kiloclaw_cli_runs.id, runId));

    const cancelControllerRun = jest.fn(async () => ({ ok: true }));

    await expect(
      cancelCliRun({
        runId,
        userId: user.id,
        instanceId,
        workerInstanceId: 'ki_current',
        getControllerStatus: async () => ({
          hasRun: false,
          status: null,
          output: null,
          exitCode: null,
          startedAt: null,
          completedAt: null,
          prompt: null,
        }),
        cancelControllerRun,
      })
    ).resolves.toEqual({ ok: true, runFound: true, cancelled: false });

    expect(cancelControllerRun).not.toHaveBeenCalled();

    // The row's existing partial output should be preserved, not replaced with
    // the LOST_CONTROLLER_RUN_OUTPUT sentinel.
    const row = await getRunRow(runId);
    expect(row.status).toBe('failed');
    expect(row.output).toBe('partial output before cancel');
    expect(row.completed_at).not.toBeNull();
  });

  it('reports cancelled: false when the DB row left running between the SELECT and the cancel UPDATE', async () => {
    const user = await insertTestUser();
    const instanceId = await createTestInstance(user.id);
    const startedAt = '2026-04-12T12:00:00.000Z';
    const runId = await createCliRun({
      userId: user.id,
      instanceId,
      prompt: 'run that a concurrent poll completed',
      startedAt,
      initiatedByAdminId: null,
    });

    // Simulate a concurrent getCliRunStatus poll persisting a terminal state
    // while cancelCliRun is waiting for the controller cancel response.
    await db
      .update(kiloclaw_cli_runs)
      .set({ status: 'completed', completed_at: '2026-04-12T12:01:00.000Z' })
      .where(eq(kiloclaw_cli_runs.id, runId));

    const result = await cancelCliRun({
      runId,
      userId: user.id,
      instanceId,
      workerInstanceId: 'ki_current',
      getControllerStatus: async () => ({
        hasRun: true,
        status: 'running',
        output: null,
        exitCode: null,
        startedAt,
        completedAt: null,
        prompt: 'run that a concurrent poll completed',
      }),
      cancelControllerRun: async () => ({ ok: true }),
    });

    expect(result).toEqual({ ok: true, runFound: true, cancelled: false });
    await expect(getRunStatus(runId)).resolves.toEqual({
      status: 'completed',
      completed_at: '2026-04-12T12:01:00.000Z',
    });
  });

  it('returns ok: false when the controller rejects the cancel', async () => {
    const user = await insertTestUser();
    const instanceId = await createTestInstance(user.id);
    const startedAt = '2026-04-12T12:00:00.000Z';
    const runId = await createCliRun({
      userId: user.id,
      instanceId,
      prompt: 'run that exits between status poll and cancel',
      startedAt,
      initiatedByAdminId: null,
    });

    const result = await cancelCliRun({
      runId,
      userId: user.id,
      instanceId,
      workerInstanceId: 'ki_current',
      getControllerStatus: async () => ({
        hasRun: true,
        status: 'running',
        output: null,
        exitCode: null,
        startedAt,
        completedAt: null,
        prompt: 'run that exits between status poll and cancel',
      }),
      // The run exited between the status poll and the cancel request.
      cancelControllerRun: async () => ({ ok: false }),
    });

    expect(result).toEqual({ ok: false, runFound: true, cancelled: false });

    // The DB row should remain 'running' so the caller can retry or poll.
    await expect(getRunStatus(runId)).resolves.toEqual({
      status: 'running',
      completed_at: null,
    });
  });
});

describe('markCliRunCancelled', () => {
  it('does not cancel an instance-scoped run when instanceId is null', async () => {
    const user = await insertTestUser();
    const instanceId = await createTestInstance(user.id);
    const runId = await createCliRun({
      userId: user.id,
      instanceId,
      prompt: 'instance-scoped run',
      startedAt: '2026-04-12T12:00:00.000Z',
      initiatedByAdminId: null,
    });

    await markCliRunCancelled({
      runId,
      userId: user.id,
      instanceId: null,
    });

    await expect(getRunStatus(runId)).resolves.toEqual({
      status: 'running',
      completed_at: null,
    });
  });

  it('cancels a running run scoped to a null instance', async () => {
    const user = await insertTestUser();
    const runId = await createCliRun({
      userId: user.id,
      instanceId: null,
      prompt: 'legacy null-instance run',
      startedAt: '2026-04-12T12:00:00.000Z',
      initiatedByAdminId: null,
    });

    await markCliRunCancelled({
      runId,
      userId: user.id,
      instanceId: null,
    });

    const row = await getRunStatus(runId);
    expect(row.status).toBe('cancelled');
    expect(row.completed_at).not.toBeNull();
  });

  it('cancels a running run scoped to the provided instance id', async () => {
    const user = await insertTestUser();
    const instanceId = await createTestInstance(user.id);
    const runId = await createCliRun({
      userId: user.id,
      instanceId,
      prompt: 'instance-scoped run',
      startedAt: '2026-04-12T12:00:00.000Z',
      initiatedByAdminId: null,
    });

    await markCliRunCancelled({
      runId,
      userId: user.id,
      instanceId,
    });

    const row = await getRunStatus(runId);
    expect(row.status).toBe('cancelled');
    expect(row.completed_at).not.toBeNull();
  });
});

describe('shouldPersistCliRunControllerStatus', () => {
  it('returns true when the controller run matches the stored row timestamp', () => {
    expect(
      shouldPersistCliRunControllerStatus(
        { started_at: '2026-04-08T12:00:00.000Z' },
        {
          hasRun: true,
          status: 'completed',
          startedAt: '2026-04-08T12:00:00Z',
        }
      )
    ).toBe(true);
  });

  it('returns false when the controller status is still running', () => {
    expect(
      shouldPersistCliRunControllerStatus(
        { started_at: '2026-04-08T12:00:00.000Z' },
        {
          hasRun: true,
          status: 'running',
          startedAt: '2026-04-08T12:00:00Z',
        }
      )
    ).toBe(false);
  });

  it('returns false when the controller timestamp belongs to a different run', () => {
    expect(
      shouldPersistCliRunControllerStatus(
        { started_at: '2026-04-08T12:00:00.000Z' },
        {
          hasRun: true,
          status: 'failed',
          startedAt: '2026-04-08T12:05:00Z',
        }
      )
    ).toBe(false);
  });

  it('returns false when the stored row timestamp is missing', () => {
    expect(
      shouldPersistCliRunControllerStatus(
        { started_at: null },
        {
          hasRun: true,
          status: 'completed',
          startedAt: '2026-04-08T12:00:00Z',
        }
      )
    ).toBe(false);
  });

  it('returns false when the controller timestamp is missing', () => {
    expect(
      shouldPersistCliRunControllerStatus(
        { started_at: '2026-04-08T12:00:00.000Z' },
        {
          hasRun: true,
          status: 'completed',
          startedAt: null,
        }
      )
    ).toBe(false);
  });

  it('returns false when there is no controller run', () => {
    expect(
      shouldPersistCliRunControllerStatus(
        { started_at: '2026-04-08T12:00:00.000Z' },
        {
          hasRun: false,
          status: 'completed',
          startedAt: '2026-04-08T12:00:00Z',
        }
      )
    ).toBe(false);
  });
});

describe('getCliRunStatus', () => {
  it('returns the row state without calling the controller when already terminal', async () => {
    const user = await insertTestUser();
    const instanceId = await createTestInstance(user.id);
    const startedAt = '2026-04-12T12:00:00.000Z';
    const runId = await createCliRun({
      userId: user.id,
      instanceId,
      prompt: 'completed run',
      startedAt,
      initiatedByAdminId: null,
    });

    // Manually mark the run as completed so the row is terminal.
    await db
      .update(kiloclaw_cli_runs)
      .set({
        status: 'completed',
        output: 'done',
        exit_code: 0,
        completed_at: '2026-04-12T12:01:00.000Z',
      })
      .where(eq(kiloclaw_cli_runs.id, runId));

    const getControllerStatus = jest.fn();

    const result = await getCliRunStatus({
      runId,
      userId: user.id,
      instanceId,
      workerInstanceId: 'ki_current',
      getControllerStatus,
    });

    expect(getControllerStatus).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      hasRun: true,
      status: 'completed',
      output: 'done',
      exitCode: 0,
      prompt: 'completed run',
      initiatedBy: 'user',
    });
    // startedAt and completedAt come from the raw DB string; just check they
    // parse to the right instant rather than asserting an exact format.
    expect(new Date(result.startedAt!).toISOString()).toBe('2026-04-12T12:00:00.000Z');
    expect(new Date(result.completedAt!).toISOString()).toBe('2026-04-12T12:01:00.000Z');
  });

  it('persists failed with lost-run output when controller returns hasRun: false', async () => {
    const user = await insertTestUser();
    const instanceId = await createTestInstance(user.id);
    const startedAt = '2026-04-12T12:00:00.000Z';
    const runId = await createCliRun({
      userId: user.id,
      instanceId,
      prompt: 'lost run',
      startedAt,
      initiatedByAdminId: null,
    });

    const result = await getCliRunStatus({
      runId,
      userId: user.id,
      instanceId,
      workerInstanceId: 'ki_current',
      getControllerStatus: async () => ({
        hasRun: false,
        status: null,
        output: null,
        exitCode: null,
        startedAt: null,
        completedAt: null,
        prompt: null,
      }),
    });

    expect(result.status).toBe('failed');
    expect(result.output).toBe(
      '[run state unavailable: controller no longer has an active CLI run for this record]'
    );
    expect(result.hasRun).toBe(true);
    expect(result.prompt).toBe('lost run');
    expect(result.initiatedBy).toBe('user');
    expect(result.completedAt).not.toBeNull();

    // Also verify the DB row was persisted.
    const row = await getRunRow(runId);
    expect(row.status).toBe('failed');
    expect(row.output).toBe(
      '[run state unavailable: controller no longer has an active CLI run for this record]'
    );
    expect(row.completed_at).not.toBeNull();
  });

  it('persists failed with superseded message when controller timestamp mismatches the row', async () => {
    const user = await insertTestUser();
    const instanceId = await createTestInstance(user.id);
    const startedAt = '2026-04-12T12:00:00.000Z';
    const runId = await createCliRun({
      userId: user.id,
      instanceId,
      prompt: 'stale row',
      startedAt,
      initiatedByAdminId: null,
    });

    const result = await getCliRunStatus({
      runId,
      userId: user.id,
      instanceId,
      workerInstanceId: 'ki_current',
      getControllerStatus: async () => ({
        hasRun: true,
        status: 'running',
        output: null,
        exitCode: null,
        startedAt: '2026-04-12T12:05:00.000Z', // Different timestamp
        completedAt: null,
        prompt: 'newer run on controller',
      }),
    });

    expect(result).toMatchObject({
      hasRun: true,
      status: 'failed',
      output: '[run state unavailable: controller has moved on to a newer run]',
      exitCode: null,
      prompt: 'stale row',
      initiatedBy: 'user',
    });
    expect(new Date(result.startedAt!).toISOString()).toBe(startedAt);
    expect(result.completedAt).not.toBeNull();

    // DB row should be persisted as failed.
    const row = await getRunRow(runId);
    expect(row.status).toBe('failed');
    expect(row.output).toBe('[run state unavailable: controller has moved on to a newer run]');
    expect(row.completed_at).not.toBeNull();
  });

  it('returns controller state pass-through when controller says running and timestamps match', async () => {
    const user = await insertTestUser();
    const instanceId = await createTestInstance(user.id);
    const startedAt = '2026-04-12T12:00:00.000Z';
    const runId = await createCliRun({
      userId: user.id,
      instanceId,
      prompt: 'active run',
      startedAt,
      initiatedByAdminId: null,
    });

    const result = await getCliRunStatus({
      runId,
      userId: user.id,
      instanceId,
      workerInstanceId: 'ki_current',
      getControllerStatus: async () => ({
        hasRun: true,
        status: 'running',
        output: 'partial output',
        exitCode: null,
        startedAt: '2026-04-12T12:00:00Z',
        completedAt: null,
        prompt: 'active run',
      }),
    });

    expect(result).toEqual({
      hasRun: true,
      status: 'running',
      output: 'partial output',
      exitCode: null,
      startedAt: '2026-04-12T12:00:00Z',
      completedAt: null,
      prompt: 'active run',
      initiatedBy: 'user',
    });

    // DB row should not be persisted (still running).
    const row = await getRunRow(runId);
    expect(row.status).toBe('running');
    expect(row.completed_at).toBeNull();
  });

  it('persists and returns terminal state when controller reached a terminal state for this run', async () => {
    const user = await insertTestUser();
    const admin = await insertTestUser();
    const instanceId = await createTestInstance(user.id);
    const startedAt = '2026-04-12T12:00:00.000Z';
    const runId = await createCliRun({
      userId: user.id,
      instanceId,
      prompt: 'run that completed',
      startedAt,
      initiatedByAdminId: admin.id,
    });

    const result = await getCliRunStatus({
      runId,
      userId: user.id,
      instanceId,
      workerInstanceId: 'ki_current',
      getControllerStatus: async () => ({
        hasRun: true,
        status: 'completed',
        output: 'final output',
        exitCode: 0,
        startedAt: '2026-04-12T12:00:00Z',
        completedAt: '2026-04-12T12:01:00.000Z',
        prompt: 'run that completed',
      }),
    });

    expect(result).toEqual({
      hasRun: true,
      status: 'completed',
      output: 'final output',
      exitCode: 0,
      startedAt: '2026-04-12T12:00:00Z',
      completedAt: '2026-04-12T12:01:00.000Z',
      prompt: 'run that completed',
      initiatedBy: 'admin',
    });

    // Verify the DB row was persisted with terminal state.
    const row = await getRunRow(runId);
    expect(row.status).toBe('completed');
    expect(row.output).toBe('final output');
    expect(row.exit_code).toBe(0);
    expect(row.completed_at).toBe('2026-04-12T12:01:00.000Z');
  });

  it('preserves existing output when controller has moved on and row already has output', async () => {
    const user = await insertTestUser();
    const instanceId = await createTestInstance(user.id);
    const startedAt = '2026-04-12T12:00:00.000Z';
    const runId = await createCliRun({
      userId: user.id,
      instanceId,
      prompt: 'run with partial output',
      startedAt,
      initiatedByAdminId: null,
    });

    // Simulate partial output already written to the row while it was running.
    await db
      .update(kiloclaw_cli_runs)
      .set({ output: 'partial output before superseded' })
      .where(eq(kiloclaw_cli_runs.id, runId));

    const result = await getCliRunStatus({
      runId,
      userId: user.id,
      instanceId,
      workerInstanceId: 'ki_current',
      getControllerStatus: async () => ({
        hasRun: true,
        status: 'completed',
        output: 'output from newer run',
        exitCode: 0,
        startedAt: '2026-04-12T12:05:00.000Z',
        completedAt: '2026-04-12T12:06:00.000Z',
        prompt: 'newer run',
      }),
    });

    expect(result.status).toBe('failed');
    expect(result.output).toBe('partial output before superseded');

    const row = await getRunRow(runId);
    expect(row.status).toBe('failed');
    expect(row.output).toBe('partial output before superseded');
    expect(row.completed_at).not.toBeNull();
  });

  it('returns empty status when the run does not exist', async () => {
    const user = await insertTestUser();

    const result = await getCliRunStatus({
      runId: crypto.randomUUID(),
      userId: user.id,
      instanceId: null,
      workerInstanceId: 'ki_current',
      getControllerStatus: async () => {
        throw new Error('should not be called');
      },
    });

    expect(result).toEqual({
      hasRun: false,
      status: null,
      output: null,
      exitCode: null,
      startedAt: null,
      completedAt: null,
      prompt: null,
      initiatedBy: null,
    });
  });
});

describe('getCliRunInitiatedBy', () => {
  it('returns user when admin id is null', () => {
    expect(getCliRunInitiatedBy({ initiated_by_admin_id: null })).toBe('user');
  });

  it('returns admin when admin id is present', () => {
    expect(getCliRunInitiatedBy({ initiated_by_admin_id: 'admin-user-id' })).toBe('admin');
  });
});
