import { eq, sql } from 'drizzle-orm';
import { user_deletion_requests, user_deletion_steps } from '@kilocode/db/schema';
import { UserDeletionRequestStatus, UserDeletionStepStatus } from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import {
  buildUserDeletionAttentionSlackNotification,
  getUserDeletionAttentionSnapshot,
  sendUserDeletionAttentionSlackSummary,
  type UserDeletionAttentionSnapshot,
} from '@/lib/user/deletion-queue/deletion-attention-slack-summary';
import { DUPLICATE_OF_ACTIVE_REQUEST_ATTENTION_CODE } from '@/lib/user/deletion-queue/deletion-types';

async function enqueueRequest(): Promise<string> {
  const email = `deletion-attention-${crypto.randomUUID()}@example.com`;
  const [result] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: null },
    targets: [{ email }],
  });
  expect(result).toMatchObject({ status: 'enqueued' });
  if (result?.status !== 'enqueued') throw new Error('Expected a deletion request');
  return result.requestId;
}

async function setStepAttention(
  requestId: string,
  status: UserDeletionStepStatus,
  stepOffset = 0
): Promise<void> {
  const steps = await db
    .select({ id: user_deletion_steps.id })
    .from(user_deletion_steps)
    .where(eq(user_deletion_steps.request_id, requestId));
  const step = steps[stepOffset];
  if (!step) throw new Error('Expected a deletion step');
  await db.update(user_deletion_steps).set({ status }).where(eq(user_deletion_steps.id, step.id));
}

function snapshot(
  overrides: Partial<UserDeletionAttentionSnapshot> = {}
): UserDeletionAttentionSnapshot {
  return {
    snapshotAt: '2026-01-03T03:04:00.000Z',
    checked: 2,
    actionable: 2,
    statusCounts: { pending: 1, inProgress: 1, finalizing: 0 },
    attentionSourceCounts: { preflight: 1, steps: 2, overlapping: 1 },
    details: [
      {
        requestId: 'request-one',
        status: UserDeletionRequestStatus.Pending,
        createdAt: '2026-01-01T00:00:00.000Z',
        hasPreflightAttention: true,
        hasStepAttention: false,
      },
      {
        requestId: 'request-two',
        status: UserDeletionRequestStatus.InProgress,
        createdAt: '2026-01-03T00:59:00.000Z',
        hasPreflightAttention: true,
        hasStepAttention: true,
      },
    ],
    ...overrides,
  };
}

describe('getUserDeletionAttentionSnapshot', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('classifies active requests once at request level', async () => {
    const duplicateOnly = await enqueueRequest();
    const duplicateWithBlockedStep = await enqueueRequest();
    const preflightAttention = await enqueueRequest();
    const inProgressBlockedStep = await enqueueRequest();
    const finalizingBlockedStep = await enqueueRequest();
    const severalBlockedSteps = await enqueueRequest();
    const overlappingAttention = await enqueueRequest();
    const terminalAttention = await enqueueRequest();

    await db
      .update(user_deletion_requests)
      .set({ preflight_attention_code: DUPLICATE_OF_ACTIVE_REQUEST_ATTENTION_CODE })
      .where(eq(user_deletion_requests.id, duplicateOnly));
    await db
      .update(user_deletion_requests)
      .set({ preflight_attention_code: DUPLICATE_OF_ACTIVE_REQUEST_ATTENTION_CODE })
      .where(eq(user_deletion_requests.id, duplicateWithBlockedStep));
    await setStepAttention(duplicateWithBlockedStep, UserDeletionStepStatus.NeedsAttention);

    await db
      .update(user_deletion_requests)
      .set({ preflight_attention_code: 'missing_target_email' })
      .where(eq(user_deletion_requests.id, preflightAttention));

    await db
      .update(user_deletion_requests)
      .set({ status: UserDeletionRequestStatus.InProgress })
      .where(eq(user_deletion_requests.id, inProgressBlockedStep));
    await setStepAttention(inProgressBlockedStep, UserDeletionStepStatus.NeedsAttention);

    await db
      .update(user_deletion_requests)
      .set({ status: UserDeletionRequestStatus.Finalizing })
      .where(eq(user_deletion_requests.id, finalizingBlockedStep));
    await setStepAttention(finalizingBlockedStep, UserDeletionStepStatus.ManualActionRequired);

    await setStepAttention(severalBlockedSteps, UserDeletionStepStatus.NeedsAttention);
    await setStepAttention(severalBlockedSteps, UserDeletionStepStatus.ManualActionRequired, 1);

    await db
      .update(user_deletion_requests)
      .set({ preflight_attention_code: 'protected_self' })
      .where(eq(user_deletion_requests.id, overlappingAttention));
    await setStepAttention(overlappingAttention, UserDeletionStepStatus.NeedsAttention);

    await db
      .update(user_deletion_requests)
      .set({
        status: UserDeletionRequestStatus.Completed,
        completed_at: sql`now()`,
        target_email: null,
        preflight_attention_code: 'protected_self',
      })
      .where(eq(user_deletion_requests.id, terminalAttention));
    await setStepAttention(terminalAttention, UserDeletionStepStatus.NeedsAttention);

    const result = await getUserDeletionAttentionSnapshot();

    expect(result).toMatchObject({
      checked: 7,
      actionable: 6,
      statusCounts: { pending: 4, inProgress: 1, finalizing: 1 },
      attentionSourceCounts: { preflight: 2, steps: 5, overlapping: 1 },
    });
    expect(result.details).toHaveLength(6);
    expect(result.details.map(detail => detail.requestId)).toEqual(
      expect.arrayContaining([
        duplicateWithBlockedStep,
        preflightAttention,
        inProgressBlockedStep,
        finalizingBlockedStep,
        severalBlockedSteps,
        overlappingAttention,
      ])
    );
    expect(result.details.map(detail => detail.requestId)).not.toEqual(
      expect.arrayContaining([duplicateOnly, terminalAttention])
    );

    const notification = buildUserDeletionAttentionSlackNotification(result);
    expect(JSON.stringify(notification)).not.toContain('deletion-attention-');
  });

  it('keeps exact counts when a detail-only attention source is omitted', async () => {
    for (let index = 0; index < 25; index += 1) {
      const requestId = await enqueueRequest();
      await db
        .update(user_deletion_requests)
        .set({
          created_at: sql`now() - interval '1 day'`,
          preflight_attention_code: 'missing_target_email',
        })
        .where(eq(user_deletion_requests.id, requestId));
    }
    const omittedStepOnly = await enqueueRequest();
    await setStepAttention(omittedStepOnly, UserDeletionStepStatus.NeedsAttention);

    const result = await getUserDeletionAttentionSnapshot();

    expect(result).toMatchObject({
      checked: 26,
      actionable: 26,
      statusCounts: { pending: 26, inProgress: 0, finalizing: 0 },
      attentionSourceCounts: { preflight: 25, steps: 1, overlapping: 0 },
    });
    expect(result.details).toHaveLength(25);
    expect(result.details.map(detail => detail.requestId)).not.toContain(omittedStepOnly);
  });
});

describe('buildUserDeletionAttentionSlackNotification', () => {
  it('renders totals, bounded linked details, deterministic ages, and no PII', () => {
    const fixtureEmail = 'must-not-appear@example.com';
    const statuses = [
      UserDeletionRequestStatus.Pending,
      UserDeletionRequestStatus.InProgress,
      UserDeletionRequestStatus.Finalizing,
    ];
    const details = Array.from({ length: 25 }, (_, index) => ({
      requestId: `request-${index + 1}`,
      status: statuses[index % statuses.length] ?? UserDeletionRequestStatus.Pending,
      createdAt: index === 0 ? '2026-01-01T00:00:00.000Z' : '2026-01-03T00:59:00.000Z',
      hasPreflightAttention: true,
      hasStepAttention: index % 2 === 0,
    }));
    const notification = buildUserDeletionAttentionSlackNotification(
      snapshot({
        checked: 28,
        actionable: 28,
        statusCounts: { pending: 10, inProgress: 9, finalizing: 9 },
        attentionSourceCounts: { preflight: 20, steps: 15, overlapping: 7 },
        details,
      })
    );
    const rendered = JSON.stringify(notification);

    expect(notification.text).toContain('GDPR deletion attention: 28 actionable requests.');
    expect(notification.text).toContain('pending 10, in progress 9, finalizing 9');
    expect(notification.text).toContain('request-1> · pending · 2d 3h');
    expect(rendered).toContain('request-2> · in_progress · 2h 5m');
    expect(rendered).toContain('request-3> · finalizing · 2h 5m');
    expect(rendered).toContain('request-25> · pending · 2h 5m');
    expect(rendered).toContain('/admin/deletion-queue/request-25');
    expect(rendered).toContain('3 additional actionable requests not shown.');
    expect(rendered).not.toContain(fixtureEmail);
    expect(notification.blocks).toHaveLength(10);
    expect(notification.blocks?.length).toBeLessThanOrEqual(50);
    expect(notification.unfurl_links).toBe(false);
    expect(notification.unfurl_media).toBe(false);
  });
});

describe('sendUserDeletionAttentionSlackSummary', () => {
  it('skips the sender for an empty current-state snapshot', async () => {
    const sendNotification = jest.fn();
    const result = await sendUserDeletionAttentionSlackSummary({
      getSnapshot: jest
        .fn()
        .mockResolvedValue(snapshot({ checked: 4, actionable: 0, details: [] })),
      sendNotification,
    });

    expect(result).toEqual({ checked: 4, actionable: 0, listed: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sends one normal-config notification for actionable requests', async () => {
    const sendNotification = jest.fn().mockResolvedValue(undefined);
    const result = await sendUserDeletionAttentionSlackSummary({
      getSnapshot: jest.fn().mockResolvedValue(snapshot()),
      sendNotification,
    });

    expect(result).toEqual({ checked: 2, actionable: 2, listed: 2 });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0]).toHaveLength(1);
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ unfurl_links: false, unfurl_media: false })
    );
  });

  it('propagates sender failures for the next cron run', async () => {
    const error = new Error('Slack unavailable');

    await expect(
      sendUserDeletionAttentionSlackSummary({
        getSnapshot: jest.fn().mockResolvedValue(snapshot()),
        sendNotification: jest.fn().mockRejectedValue(error),
      })
    ).rejects.toBe(error);
  });
});
