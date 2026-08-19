import { captureException } from '@sentry/nextjs';
import { and, eq, inArray } from 'drizzle-orm';
import { user_deletion_requests, user_deletion_steps } from '@kilocode/db/schema';
import {
  UserDeletionRequestStatus,
  UserDeletionStepKey,
  UserDeletionStepStatus,
} from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { teardownStepKeys } from '@/lib/user/deletion-queue/deletion-catalog';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import { persistRejectedPreflight } from '@/lib/user/deletion-queue/deletion-outcomes';
import { runDeletionPreflight } from '@/lib/user/deletion-queue/deletion-preflight';
import { runClaimedDeletionTask } from '@/lib/user/deletion-queue/deletion-task-runner';
import {
  buildDeletionWave,
  runUserDeletionWorker,
} from '@/lib/user/deletion-queue/deletion-worker';
import { insertTestUser } from '@/tests/helpers/user.helper';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/user/deletion-queue/deletion-preflight', () => ({
  runDeletionPreflight: jest.fn(),
}));

jest.mock('@/lib/user/deletion-queue/deletion-task-runner', () => ({
  runClaimedDeletionTask: jest.fn(),
}));

jest.mock('@/lib/user/deletion-queue/deletion-outcomes', () => {
  const actual = jest.requireActual('@/lib/user/deletion-queue/deletion-outcomes');
  return {
    ...actual,
    persistRejectedPreflight: jest.fn(),
  };
});

const captureExceptionMock = jest.mocked(captureException);
const runDeletionPreflightMock = jest.mocked(runDeletionPreflight);
const runClaimedDeletionTaskMock = jest.mocked(runClaimedDeletionTask);
const persistRejectedPreflightMock = jest.mocked(persistRejectedPreflight);

describe('buildDeletionWave', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('skips an unclaimable in-progress request and still picks later teardown work', async () => {
    const older = await enqueueInProgress({
      email: `older-${crypto.randomUUID()}@example.com`,
      lastProgressAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await setStepsStatus(older, [...teardownStepKeys(), UserDeletionStepKey.Anonymize], {
      status: UserDeletionStepStatus.Succeeded,
    });

    const newer = await enqueueInProgress({
      email: `newer-${crypto.randomUUID()}@example.com`,
      lastProgressAt: new Date().toISOString(),
    });

    const wave = await buildDeletionWave(Date.now() + 40_000);
    expect(wave.some(item => item.requestId === newer && item.kind === 'task')).toBe(true);
    expect(wave.some(item => item.requestId === older)).toBe(false);
  });

  it('fills the second concurrent slot from the request that contributed the first wave item', async () => {
    const older = await enqueueInProgress({
      email: `older-fill-${crypto.randomUUID()}@example.com`,
      lastProgressAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await setStepsStatus(older, [...teardownStepKeys(), UserDeletionStepKey.Anonymize], {
      status: UserDeletionStepStatus.Succeeded,
    });

    const newer = await enqueueInProgress({
      email: `newer-fill-${crypto.randomUUID()}@example.com`,
      lastProgressAt: new Date().toISOString(),
    });

    const wave = await buildDeletionWave(Date.now() + 40_000);
    expect(wave).toHaveLength(2);
    expect(wave.every(item => item.kind === 'task' && item.requestId === newer)).toBe(true);
  });

  it('does not keep re-selecting the same unclaimable request', async () => {
    const requestId = await enqueueInProgress({
      email: `stuck-${crypto.randomUUID()}@example.com`,
      lastProgressAt: new Date().toISOString(),
    });
    await setStepsStatus(requestId, [...teardownStepKeys(), UserDeletionStepKey.Anonymize], {
      status: UserDeletionStepStatus.Succeeded,
    });

    const started = Date.now();
    const wave = await buildDeletionWave(started + 40_000);
    expect(wave).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('concurrent waves claim disjoint step IDs', async () => {
    await enqueueInProgress({
      email: `concurrent-${crypto.randomUUID()}@example.com`,
      lastProgressAt: new Date().toISOString(),
    });

    const [left, right] = await Promise.all([
      buildDeletionWave(Date.now() + 40_000),
      buildDeletionWave(Date.now() + 40_000),
    ]);

    const claimedIds = [...left, ...right]
      .filter(item => item.kind === 'task')
      .map(item => item.stepId);
    expect(claimedIds.length).toBeGreaterThan(0);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);

    const running = await db
      .select({ id: user_deletion_steps.id })
      .from(user_deletion_steps)
      .where(eq(user_deletion_steps.status, UserDeletionStepStatus.Running));
    expect(running.map(step => step.id).sort()).toEqual([...claimedIds].sort());
  });
});

describe('runUserDeletionWorker rejected items', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    captureExceptionMock.mockClear();
    runDeletionPreflightMock.mockReset();
    runClaimedDeletionTaskMock.mockReset();
    persistRejectedPreflightMock.mockReset();
  });

  it('persists worker_item_rejected for a rejected claimed task and returns failure', async () => {
    const requestId = await enqueueInProgress({
      email: `reject-task-${crypto.randomUUID()}@example.com`,
      lastProgressAt: new Date().toISOString(),
    });
    const thrown = new Error('claimed task rejected');
    runClaimedDeletionTaskMock.mockRejectedValue(thrown);

    const result = await runUserDeletionWorker({ now: Date.now() });

    expect(result.outcome).toBe('failure');
    expect(result.processed).toBe(0);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      thrown,
      expect.objectContaining({
        tags: { source: 'user-deletion-worker' },
        extra: expect.objectContaining({ requestId, waveItemKind: 'task' }),
      })
    );
    const retrying = await db
      .select()
      .from(user_deletion_steps)
      .where(
        and(
          eq(user_deletion_steps.request_id, requestId),
          eq(user_deletion_steps.last_error_code, 'worker_item_rejected')
        )
      );
    expect(retrying.length).toBeGreaterThan(0);
  });

  it('persists preflight_throw for a rejected preflight and returns failure', async () => {
    const requestId = await enqueuePending();
    const thrown = new Error('preflight rejected');
    runDeletionPreflightMock.mockRejectedValue(thrown);
    persistRejectedPreflightMock.mockImplementation(async id => {
      await db
        .update(user_deletion_requests)
        .set({ preflight_attention_code: 'preflight_throw' })
        .where(eq(user_deletion_requests.id, id));
      return true;
    });

    const result = await runUserDeletionWorker({ now: Date.now() });

    expect(result.outcome).toBe('failure');
    expect(result.processed).toBe(0);
    expect(persistRejectedPreflightMock).toHaveBeenCalledWith(requestId);
    const [request] = await db
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId));
    expect(request?.preflight_attention_code).toBe('preflight_throw');
  });

  it('still returns failure when fallback persistence throws', async () => {
    await enqueuePending();
    runDeletionPreflightMock.mockRejectedValue(new Error('preflight rejected'));
    persistRejectedPreflightMock.mockRejectedValue(new Error('persist failed'));

    const result = await runUserDeletionWorker({ now: Date.now() });

    expect(result.outcome).toBe('failure');
    expect(result.processed).toBe(0);
    expect(captureExceptionMock).toHaveBeenCalledTimes(2);
  });
});

async function enqueuePending() {
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({
    google_user_email: `pending-${crypto.randomUUID()}@example.com`,
  });
  const [result] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: admin.id },
    targets: [{ email: user.google_user_email, trustedUserId: user.id }],
  });
  expect(result.status).toBe('enqueued');
  if (result.status !== 'enqueued') throw new Error('expected enqueued');
  return result.requestId;
}

async function enqueueInProgress(params: { email: string; lastProgressAt: string }) {
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({ google_user_email: params.email });
  const [result] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: admin.id },
    targets: [{ email: user.google_user_email, trustedUserId: user.id }],
  });
  expect(result.status).toBe('enqueued');
  if (result.status !== 'enqueued') throw new Error('expected enqueued');

  await db
    .update(user_deletion_requests)
    .set({
      status: UserDeletionRequestStatus.InProgress,
      last_progress_at: params.lastProgressAt,
    })
    .where(eq(user_deletion_requests.id, result.requestId));
  return result.requestId;
}

async function setStepsStatus(
  requestId: string,
  stepKeys: readonly UserDeletionStepKey[],
  values: { status: UserDeletionStepStatus }
) {
  await db
    .update(user_deletion_steps)
    .set({ status: values.status })
    .where(
      and(
        eq(user_deletion_steps.request_id, requestId),
        inArray(user_deletion_steps.step_key, [...stepKeys])
      )
    );
}
