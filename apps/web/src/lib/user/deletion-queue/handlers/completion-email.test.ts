import { and, eq } from 'drizzle-orm';
import { user_deletion_requests, user_deletion_steps } from '@kilocode/db/schema';
import {
  UserDeletionCompletionEmailState,
  UserDeletionStepKey,
  UserDeletionStepStatus,
  type UserDeletionTaskProgress,
} from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { sendAccountDeletionCompletedEmail } from '@/lib/email';
import { handleCompletionEmail } from '@/lib/user/deletion-queue/handlers/completion-email';

jest.mock('@/lib/email', () => ({
  sendAccountDeletionCompletedEmail: jest.fn(),
}));

const sendCompletionEmail = jest.mocked(sendAccountDeletionCompletedEmail);
const TARGET_EMAIL = 'completion-email@example.com';

describe('handleCompletionEmail', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    sendCompletionEmail.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends one completion email for a no-ticket request', async () => {
    const { request, step, context } = await setupCompletionRequest();
    sendCompletionEmail.mockResolvedValue({ sent: true });

    const outcome = await handleCompletionEmail({ request, step, context });

    expect(outcome).toEqual({
      kind: 'succeeded',
      progress: {
        completion_email_state: UserDeletionCompletionEmailState.Sent,
      },
    });
    expect(sendCompletionEmail).toHaveBeenCalledTimes(1);
    expect(sendCompletionEmail).toHaveBeenCalledWith(TARGET_EMAIL);
    await expect(loadProgress(request.id)).resolves.toEqual({
      completion_email_state: UserDeletionCompletionEmailState.Sending,
    });
  });

  it('does not send Mailgun completion email for a ticket-backed request', async () => {
    const { request, step, context } = await setupCompletionRequest({ ticket: '#iss-completion' });

    await expect(handleCompletionEmail({ request, step, context })).resolves.toEqual({
      kind: 'not_applicable',
    });
    expect(sendCompletionEmail).not.toHaveBeenCalled();
  });

  it('does not resend when the durable state is already sent', async () => {
    const { request, step, context } = await setupCompletionRequest({
      progress: { completion_email_state: UserDeletionCompletionEmailState.Sent },
    });

    await expect(handleCompletionEmail({ request, step, context })).resolves.toEqual({
      kind: 'succeeded',
      progress: { completion_email_state: UserDeletionCompletionEmailState.Sent },
    });
    expect(sendCompletionEmail).not.toHaveBeenCalled();
  });

  it.each([UserDeletionCompletionEmailState.Sending, UserDeletionCompletionEmailState.Ambiguous])(
    'stops without sending when durable state is %s',
    async state => {
      const { request, step, context } = await setupCompletionRequest({
        progress: { completion_email_state: state },
      });

      await expect(handleCompletionEmail({ request, step, context })).resolves.toEqual({
        kind: 'needs_attention',
        errorCode: 'completion_email_ambiguous',
        progress: { completion_email_state: state },
      });
      expect(sendCompletionEmail).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['neverbounce_rejected', 'completion_email_rejected'],
    ['provider_not_configured', 'completion_email_unavailable'],
  ] as const)('surfaces %s without making the state ambiguous', async (reason, errorCode) => {
    const { request, step, context } = await setupCompletionRequest();
    sendCompletionEmail.mockResolvedValue({ sent: false, reason });

    await expect(handleCompletionEmail({ request, step, context })).resolves.toEqual({
      kind: 'needs_attention',
      errorCode,
      progress: { completion_email_state: UserDeletionCompletionEmailState.NotSent },
    });
    expect(sendCompletionEmail).toHaveBeenCalledTimes(1);
  });

  it('retains ambiguity when the sender throws and does not retry automatically', async () => {
    const { request, step, context } = await setupCompletionRequest();
    sendCompletionEmail.mockRejectedValueOnce(new Error('provider timeout'));

    await expect(handleCompletionEmail({ request, step, context })).resolves.toEqual({
      kind: 'needs_attention',
      errorCode: 'completion_email_ambiguous',
      progress: { completion_email_state: UserDeletionCompletionEmailState.Ambiguous },
    });
    expect(await loadProgress(request.id)).toEqual({
      completion_email_state: UserDeletionCompletionEmailState.Ambiguous,
    });

    const retried = await setupClaimForExistingStep(request.id, {
      completion_email_state: UserDeletionCompletionEmailState.Ambiguous,
    });
    await expect(
      handleCompletionEmail({ request, step: retried.step, context: retried.context })
    ).resolves.toMatchObject({
      kind: 'needs_attention',
      errorCode: 'completion_email_ambiguous',
    });
    expect(sendCompletionEmail).toHaveBeenCalledTimes(1);
  });

  it('does not write the pre-send checkpoint or send after losing the claim', async () => {
    const { request, step, context } = await setupCompletionRequest();
    await db
      .update(user_deletion_steps)
      .set({ claim_token: crypto.randomUUID() })
      .where(eq(user_deletion_steps.id, step.id));

    await expect(handleCompletionEmail({ request, step, context })).resolves.toEqual({
      kind: 'retry',
      errorCode: 'claim_lost',
      httpStatusClass: 'error',
    });
    expect(sendCompletionEmail).not.toHaveBeenCalled();
    await expect(loadProgress(request.id)).resolves.toEqual({});
  });
});

async function setupCompletionRequest(params?: {
  ticket?: string;
  progress?: UserDeletionTaskProgress;
}) {
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({ google_user_email: TARGET_EMAIL });
  const [result] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: admin.id },
    targets: [
      {
        email: TARGET_EMAIL,
        ...(params?.ticket ? { pylonTicket: params.ticket } : {}),
        ...(user ? { trustedUserId: user.id } : {}),
      },
    ],
  });
  expect(result.status).toBe('enqueued');
  if (result.status !== 'enqueued') throw new Error('expected enqueued');

  const [request] = await db
    .select()
    .from(user_deletion_requests)
    .where(eq(user_deletion_requests.id, result.requestId));
  if (!request) throw new Error('missing request');

  const claim = await setupClaimForExistingStep(request.id, params?.progress);
  return { request, ...claim };
}

async function setupClaimForExistingStep(
  requestId: string,
  progress: UserDeletionTaskProgress = {}
) {
  const claimToken = crypto.randomUUID();
  const [step] = await db
    .select()
    .from(user_deletion_steps)
    .where(
      and(
        eq(user_deletion_steps.request_id, requestId),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.CompletionEmail)
      )
    );
  if (!step) throw new Error('missing completion email step');

  const [claimed] = await db
    .update(user_deletion_steps)
    .set({
      status: UserDeletionStepStatus.Running,
      claim_token: claimToken,
      claimed_until: new Date(Date.now() + 60_000).toISOString(),
      progress_json: progress,
    })
    .where(eq(user_deletion_steps.id, step.id))
    .returning();
  if (!claimed) throw new Error('missing claimed completion email step');

  const context: DeletionHandlerContext = {
    requestId,
    stepKey: UserDeletionStepKey.CompletionEmail,
    claimToken,
    deadlineAt: Date.now() + 60_000,
    remainingMs: () => 60_000,
    signal: new AbortController().signal,
  };
  return { step: claimed, context };
}

async function loadProgress(requestId: string): Promise<UserDeletionTaskProgress> {
  const [step] = await db
    .select({ progress_json: user_deletion_steps.progress_json })
    .from(user_deletion_steps)
    .where(
      and(
        eq(user_deletion_steps.request_id, requestId),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.CompletionEmail)
      )
    );
  return step?.progress_json ?? {};
}
