import {
  USER_DELETION_ANONYMIZE_MIN_STATEMENT_TIMEOUT_MS,
  USER_DELETION_ANONYMIZE_TIMEOUT_BUFFER_MS,
} from '@/lib/user/deletion-queue/deletion-constants';
import { userIdKeyedAbsenceOutcome } from '@/lib/user/deletion-queue/deletion-subject';
import { continueIfLowTime, type DeletionHandler } from '@/lib/user/deletion-queue/handlers/common';

export const handleAnonymize: DeletionHandler = async ({ request, context }) => {
  const absence = userIdKeyedAbsenceOutcome(request);
  if (absence) return absence;
  const userId = request.user_id;
  if (!userId) return { kind: 'needs_attention', errorCode: 'legacy_identity_unresolved' };

  const stop = continueIfLowTime(context);
  if (stop) return stop;

  const remainingMs = context.remainingMs();
  if (
    remainingMs - USER_DELETION_ANONYMIZE_TIMEOUT_BUFFER_MS <
    USER_DELETION_ANONYMIZE_MIN_STATEMENT_TIMEOUT_MS
  ) {
    return { kind: 'continue' };
  }

  return { kind: 'succeeded' };
};
