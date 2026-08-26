import { and, eq } from 'drizzle-orm';
import { user_deletion_requests, user_deletion_steps } from '@kilocode/db/schema';
import {
  UserDeletionRequestStatus,
  UserDeletionStepKey,
  UserDeletionStepStatus,
} from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import { selectNextTaskForRequest } from '@/lib/user/deletion-queue/deletion-task-selector';
import { insertTestUser } from '@/tests/helpers/user.helper';

describe('deletion task selector catalog compatibility', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('waits for completion email before selecting Pylon contact on new v2 requests', async () => {
    const requestId = await createV2Request();
    await markAllTasksSucceeded(requestId, [
      UserDeletionStepKey.CompletionEmail,
      UserDeletionStepKey.PylonContact,
    ]);

    const completion = await selectNextTaskForRequest({ requestId, remainingMs: 60_000 });
    expect(completion?.step.step_key).toBe(UserDeletionStepKey.CompletionEmail);

    await markTaskSucceeded(requestId, UserDeletionStepKey.CompletionEmail);
    const contact = await selectNextTaskForRequest({ requestId, remainingMs: 60_000 });
    expect(contact?.step.step_key).toBe(UserDeletionStepKey.PylonContact);
  });

  it('keeps pre-deployment v2 requests without completion email compatible', async () => {
    const requestId = await createV2Request();
    await db
      .delete(user_deletion_steps)
      .where(
        and(
          eq(user_deletion_steps.request_id, requestId),
          eq(user_deletion_steps.step_key, UserDeletionStepKey.CompletionEmail)
        )
      );
    await markAllTasksSucceeded(requestId, [UserDeletionStepKey.PylonContact]);

    const contact = await selectNextTaskForRequest({ requestId, remainingMs: 60_000 });
    expect(contact?.step.step_key).toBe(UserDeletionStepKey.PylonContact);
  });

  it('does not select dependent work when a required finalization task is missing', async () => {
    const requestId = await createV2Request();
    await markAllTasksSucceeded(requestId, [UserDeletionStepKey.PylonContact]);
    await db
      .delete(user_deletion_steps)
      .where(
        and(
          eq(user_deletion_steps.request_id, requestId),
          eq(user_deletion_steps.step_key, UserDeletionStepKey.PylonFinalize)
        )
      );

    await expect(selectNextTaskForRequest({ requestId, remainingMs: 60_000 })).rejects.toThrow(
      `missing required step ${UserDeletionStepKey.PylonFinalize}`
    );
  });
});

async function createV2Request(): Promise<string> {
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({
    google_user_email: `selector-${crypto.randomUUID()}@example.com`,
  });
  const [result] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: admin.id },
    targets: [{ email: user.google_user_email, trustedUserId: user.id }],
  });
  expect(result.status).toBe('enqueued');
  if (result.status !== 'enqueued') throw new Error('expected enqueued request');

  await db
    .update(user_deletion_requests)
    .set({ status: UserDeletionRequestStatus.Finalizing })
    .where(eq(user_deletion_requests.id, result.requestId));
  return result.requestId;
}

async function markAllTasksSucceeded(requestId: string, except: UserDeletionStepKey[]) {
  const steps = await db
    .select({ step_key: user_deletion_steps.step_key })
    .from(user_deletion_steps)
    .where(eq(user_deletion_steps.request_id, requestId));
  for (const step of steps) {
    if (except.includes(step.step_key)) continue;
    await markTaskSucceeded(requestId, step.step_key);
  }
}

async function markTaskSucceeded(requestId: string, stepKey: UserDeletionStepKey) {
  await db
    .update(user_deletion_steps)
    .set({
      status: UserDeletionStepStatus.Succeeded,
      claim_token: null,
      claimed_until: null,
    })
    .where(
      and(eq(user_deletion_steps.request_id, requestId), eq(user_deletion_steps.step_key, stepKey))
    );
}
