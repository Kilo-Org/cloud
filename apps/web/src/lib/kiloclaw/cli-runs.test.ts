import { describe, expect, it } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { createCliRun, markCliRunCancelled, shouldPersistCliRunControllerStatus } from '@/lib/kiloclaw/cli-runs';
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

  return row;
}

describe('markCliRunCancelled', () => {
  it('does not cancel an instance-scoped run when instanceId is null', async () => {
    const user = await insertTestUser();
    const instanceId = await createTestInstance(user.id);
    const runId = await createCliRun({
      userId: user.id,
      instanceId,
      prompt: 'instance-scoped run',
      startedAt: '2026-04-12T12:00:00.000Z',
      initiatedBy: 'user',
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
      initiatedBy: 'user',
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
      initiatedBy: 'user',
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

  it('keeps unscoped cancellation behavior when instanceId is omitted', async () => {
    const user = await insertTestUser();
    const instanceId = await createTestInstance(user.id);
    const runId = await createCliRun({
      userId: user.id,
      instanceId,
      prompt: 'unscoped run',
      startedAt: '2026-04-12T12:00:00.000Z',
      initiatedBy: 'user',
    });

    await markCliRunCancelled({
      runId,
      userId: user.id,
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
