import { and, eq } from 'drizzle-orm';
import { user_deletion_steps } from '@kilocode/db/schema';
import {
  UserDeletionCompletionEmailState,
  UserDeletionStepStatus,
  type UserDeletionTaskProgress,
} from '@kilocode/db/schema-types';
import { sendAccountDeletionCompletedEmail } from '@/lib/email';
import { db } from '@/lib/drizzle';
import {
  USER_DELETION_PROVIDER_TIMEOUT_MS,
  USER_DELETION_STOP_STARTING_RESERVE_MS,
} from '@/lib/user/deletion-queue/deletion-constants';
import type {
  DeletionHandlerContext,
  DeletionHandlerOutcome,
} from '@/lib/user/deletion-queue/deletion-types';
import {
  continueIfLowTime,
  requireTargetEmail,
  type DeletionHandler,
} from '@/lib/user/deletion-queue/handlers/common';

async function saveProgress(
  context: DeletionHandlerContext,
  progress: UserDeletionTaskProgress
): Promise<DeletionHandlerOutcome | null> {
  const [updated] = await db
    .update(user_deletion_steps)
    .set({ progress_json: progress })
    .where(
      and(
        eq(user_deletion_steps.request_id, context.requestId),
        eq(user_deletion_steps.step_key, context.stepKey),
        eq(user_deletion_steps.claim_token, context.claimToken),
        eq(user_deletion_steps.status, UserDeletionStepStatus.Running)
      )
    )
    .returning({ id: user_deletion_steps.id });
  if (updated) return null;
  return { kind: 'retry', errorCode: 'claim_lost', httpStatusClass: 'error' };
}

function withState(
  progress: UserDeletionTaskProgress,
  state: UserDeletionCompletionEmailState
): UserDeletionTaskProgress {
  return { ...progress, completion_email_state: state };
}

async function sendWithProviderTimeout(
  context: DeletionHandlerContext,
  email: string
): Promise<Awaited<ReturnType<typeof sendAccountDeletionCompletedEmail>>> {
  const timeoutMs = Math.max(
    1,
    Math.min(
      USER_DELETION_PROVIDER_TIMEOUT_MS,
      context.remainingMs() - USER_DELETION_STOP_STARTING_RESERVE_MS
    )
  );
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error('Completion email provider timed out')),
        timeoutMs
      );
    });
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new Error('Completion email provider aborted'));
      abortHandler = onAbort;
      if (context.signal.aborted) {
        onAbort();
      } else {
        context.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    return await Promise.race([sendAccountDeletionCompletedEmail(email), timeout, aborted]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (abortHandler) context.signal.removeEventListener('abort', abortHandler);
  }
}

export const handleCompletionEmail: DeletionHandler = async ({ request, step, context }) => {
  if (request.pylon_ticket_ref) {
    return { kind: 'not_applicable' };
  }

  const emailOrOutcome = requireTargetEmail(request);
  if (typeof emailOrOutcome !== 'string') return emailOrOutcome;

  const stop = continueIfLowTime(context, step.progress_json);
  if (stop) return stop;

  const state = step.progress_json.completion_email_state;
  if (state === UserDeletionCompletionEmailState.Sent) {
    return { kind: 'succeeded', progress: step.progress_json };
  }
  if (
    state === UserDeletionCompletionEmailState.Sending ||
    state === UserDeletionCompletionEmailState.Ambiguous
  ) {
    return {
      kind: 'needs_attention',
      errorCode: 'completion_email_ambiguous',
      progress: step.progress_json,
    };
  }

  const sendingProgress = withState(step.progress_json, UserDeletionCompletionEmailState.Sending);
  const lost = await saveProgress(context, sendingProgress);
  if (lost) return lost;

  try {
    const result = await sendWithProviderTimeout(context, emailOrOutcome);
    if (result.sent) {
      return {
        kind: 'succeeded',
        progress: withState(sendingProgress, UserDeletionCompletionEmailState.Sent),
      };
    }

    return {
      kind: 'needs_attention',
      errorCode:
        result.reason === 'neverbounce_rejected'
          ? 'completion_email_rejected'
          : 'completion_email_unavailable',
      progress: withState(sendingProgress, UserDeletionCompletionEmailState.NotSent),
    };
  } catch {
    const ambiguousProgress = withState(
      sendingProgress,
      UserDeletionCompletionEmailState.Ambiguous
    );
    const lostAfterSend = await saveProgress(context, ambiguousProgress);
    if (lostAfterSend) return lostAfterSend;
    return {
      kind: 'needs_attention',
      errorCode: 'completion_email_ambiguous',
      progress: ambiguousProgress,
    };
  }
};
