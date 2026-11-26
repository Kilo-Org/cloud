import { and, eq } from 'drizzle-orm';
import { user_deletion_requests, user_deletion_steps } from '@kilocode/db/schema';
import {
  UserDeletionCloudSubjectResolution,
  UserDeletionRequestStatus,
  UserDeletionStepKey,
  UserDeletionStepStatus,
  type UserDeletionTaskProgress,
} from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import { handleUsagePromptPrefixes } from '@/lib/user/deletion-queue/handlers/usage-prompt-prefixes';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

describe('handleUsagePromptPrefixes', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('returns not_applicable when the step has no recorded progress', async () => {
    const { request, step, claimToken } = await prepareRunningStep();

    await expect(
      handleUsagePromptPrefixes({
        request,
        step,
        context: handlerContext(request.id, claimToken),
      })
    ).resolves.toEqual({ kind: 'not_applicable' });
  });

  it('returns succeeded and keeps the counts from an earlier partial scrub', async () => {
    const progress = { processed_count: 4, scanned_count: 10, cursor: 'a\tb' };
    const { request, step, claimToken } = await prepareRunningStep(progress);

    await expect(
      handleUsagePromptPrefixes({
        request,
        step,
        context: handlerContext(request.id, claimToken),
      })
    ).resolves.toEqual({ kind: 'succeeded', progress });
  });

  it('ignores malformed persisted progress', async () => {
    const { request, step, claimToken } = await prepareRunningStep({ cursor: 'not-a-cursor' });

    await expect(
      handleUsagePromptPrefixes({
        request,
        step,
        context: handlerContext(request.id, claimToken),
      })
    ).resolves.toEqual({ kind: 'not_applicable' });
  });

  it('returns not_applicable with the absence reason when the user is already gone', async () => {
    const { request, step, claimToken } = await prepareRunningStep();
    const absentRequest = {
      ...request,
      user_id: null,
      cloud_subject_resolution: UserDeletionCloudSubjectResolution.AuthoritativeAbsence,
    };

    await expect(
      handleUsagePromptPrefixes({
        request: absentRequest,
        step,
        context: handlerContext(request.id, claimToken),
      })
    ).resolves.toEqual({ kind: 'not_applicable', errorCode: 'authoritative_absence' });
  });

  it('needs attention when the user identity was never resolved', async () => {
    const { request, step, claimToken } = await prepareRunningStep();
    const unresolvedRequest = {
      ...request,
      user_id: null,
      cloud_subject_resolution: UserDeletionCloudSubjectResolution.Unresolved,
    };

    await expect(
      handleUsagePromptPrefixes({
        request: unresolvedRequest,
        step,
        context: handlerContext(request.id, claimToken),
      })
    ).resolves.toEqual({ kind: 'needs_attention', errorCode: 'legacy_identity_unresolved' });
  });
});

async function prepareRunningStep(progress: UserDeletionTaskProgress = {}) {
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({
    google_user_email: `target-${crypto.randomUUID()}@example.com`,
  });
  const [enqueued] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: admin.id },
    targets: [{ email: user.google_user_email, trustedUserId: user.id }],
  });
  if (!enqueued || enqueued.status !== 'enqueued') {
    throw new Error('expected deletion request to be enqueued');
  }

  const claimToken = crypto.randomUUID();
  await db
    .update(user_deletion_requests)
    .set({ status: UserDeletionRequestStatus.InProgress })
    .where(eq(user_deletion_requests.id, enqueued.requestId));
  await db
    .update(user_deletion_steps)
    .set({
      status: UserDeletionStepStatus.Running,
      claim_token: claimToken,
      claimed_until: new Date(Date.now() + 60_000).toISOString(),
      progress_json: progress,
    })
    .where(
      and(
        eq(user_deletion_steps.request_id, enqueued.requestId),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.UsagePromptPrefixes)
      )
    );

  const [request] = await db
    .select()
    .from(user_deletion_requests)
    .where(eq(user_deletion_requests.id, enqueued.requestId));
  const [step] = await db
    .select()
    .from(user_deletion_steps)
    .where(
      and(
        eq(user_deletion_steps.request_id, enqueued.requestId),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.UsagePromptPrefixes)
      )
    );
  if (!request || !step) throw new Error('expected request and usage prompt step');
  return { request, step, claimToken };
}

function handlerContext(requestId: string, claimToken: string): DeletionHandlerContext {
  return {
    requestId,
    stepKey: UserDeletionStepKey.UsagePromptPrefixes,
    claimToken,
    deadlineAt: Date.now() + 60_000,
    remainingMs: () => 60_000,
    signal: new AbortController().signal,
  };
}
