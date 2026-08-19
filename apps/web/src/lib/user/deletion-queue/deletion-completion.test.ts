import { and, eq, inArray } from 'drizzle-orm';
import { user_deletion_requests, user_deletion_steps } from '@kilocode/db/schema';
import {
  UserDeletionRequestStatus,
  UserDeletionStepKey,
  UserDeletionStepStatus,
} from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { catalogForVersion, teardownStepKeys } from '@/lib/user/deletion-queue/deletion-catalog';
import {
  advanceDeletionGates,
  sweepUnclaimableDeletionGates,
} from '@/lib/user/deletion-queue/deletion-completion';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import { persistHandlerOutcome } from '@/lib/user/deletion-queue/deletion-outcomes';
import { insertTestUser } from '@/tests/helpers/user.helper';

describe('deletion completion gates', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('advances an email-only request to completed when teardowns and anonymize are not_applicable', async () => {
    const requestId = await enqueueEmailOnly();
    await setRequestStatus(requestId, UserDeletionRequestStatus.InProgress);
    await setStepsStatus(requestId, [...teardownStepKeys(), UserDeletionStepKey.Anonymize], {
      status: UserDeletionStepStatus.NotApplicable,
    });

    await advanceDeletionGates(requestId);

    const request = await loadRequest(requestId);
    expect(request?.status).toBe(UserDeletionRequestStatus.Completed);
    expect(request?.anonymized_at).toBeNull();
  });

  it('completes a finalizing request after the last catalog task is persisted', async () => {
    const requestId = await enqueueEmailOnly();
    await setRequestStatus(requestId, UserDeletionRequestStatus.Finalizing);
    await setStepsStatus(
      requestId,
      catalogForVersion(1)
        .map(entry => entry.stepKey)
        .filter(key => key !== UserDeletionStepKey.Anonymize),
      { status: UserDeletionStepStatus.NotApplicable }
    );
    const claimToken = crypto.randomUUID();
    await setStepsStatus(requestId, [UserDeletionStepKey.Anonymize], {
      status: UserDeletionStepStatus.Running,
      claim_token: claimToken,
      claimed_until: new Date(Date.now() + 60_000).toISOString(),
    });

    const persisted = await persistHandlerOutcome({
      requestId,
      stepKey: UserDeletionStepKey.Anonymize,
      claimToken,
      outcome: { kind: 'not_applicable' },
    });

    expect(persisted.kind).toBe('applied');
    const request = await loadRequest(requestId);
    expect(request?.status).toBe(UserDeletionRequestStatus.Completed);
  });

  it('recovers a stuck finalizing request via the unclaimable sweep', async () => {
    const requestId = await enqueueEmailOnly();
    await setRequestStatus(requestId, UserDeletionRequestStatus.Finalizing);
    await setStepsStatus(
      requestId,
      catalogForVersion(1).map(entry => entry.stepKey),
      { status: UserDeletionStepStatus.Succeeded }
    );

    await sweepUnclaimableDeletionGates(Date.now() + 40_000);

    const request = await loadRequest(requestId);
    expect(request?.status).toBe(UserDeletionRequestStatus.Completed);
  });

  it('recovers an email-only anonymize not_applicable persist via the sweep', async () => {
    const requestId = await enqueueEmailOnly();
    await setRequestStatus(requestId, UserDeletionRequestStatus.InProgress);
    await setStepsStatus(requestId, [...teardownStepKeys(), UserDeletionStepKey.Anonymize], {
      status: UserDeletionStepStatus.NotApplicable,
    });

    await sweepUnclaimableDeletionGates(Date.now() + 40_000);

    const request = await loadRequest(requestId);
    expect(request?.status).toBe(UserDeletionRequestStatus.Completed);
  });
});

async function enqueueEmailOnly(): Promise<string> {
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({
    google_user_email: `email-only-${crypto.randomUUID()}@example.com`,
  });
  const [result] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: admin.id },
    targets: [{ email: user.google_user_email }],
  });
  expect(result.status).toBe('enqueued');
  if (result.status !== 'enqueued') throw new Error('expected enqueued');
  return result.requestId;
}

async function setRequestStatus(requestId: string, status: UserDeletionRequestStatus) {
  await db
    .update(user_deletion_requests)
    .set({ status })
    .where(eq(user_deletion_requests.id, requestId));
}

async function setStepsStatus(
  requestId: string,
  stepKeys: readonly UserDeletionStepKey[],
  values: {
    status: UserDeletionStepStatus;
    claim_token?: string | null;
    claimed_until?: string | null;
  }
) {
  await db
    .update(user_deletion_steps)
    .set({
      status: values.status,
      claim_token: values.claim_token ?? null,
      claimed_until: values.claimed_until ?? null,
    })
    .where(
      and(
        eq(user_deletion_steps.request_id, requestId),
        inArray(user_deletion_steps.step_key, [...stepKeys])
      )
    );
}

async function loadRequest(requestId: string) {
  const [request] = await db
    .select()
    .from(user_deletion_requests)
    .where(eq(user_deletion_requests.id, requestId));
  return request;
}
