import { UserDeletionCloudSubjectResolution } from '@kilocode/db/schema-types';
import type { UserDeletionRequest } from '@kilocode/db/schema';
import type { DeletionHandlerOutcome } from '@/lib/user/deletion-queue/deletion-types';

export function userIdKeyedAbsenceOutcome(
  request: UserDeletionRequest
): DeletionHandlerOutcome | null {
  if (request.user_id) return null;
  if (
    request.cloud_subject_resolution === UserDeletionCloudSubjectResolution.AuthoritativeAbsence
  ) {
    return { kind: 'not_applicable', errorCode: 'authoritative_absence' };
  }
  if (request.cloud_subject_resolution === UserDeletionCloudSubjectResolution.PriorQueueCleanup) {
    return { kind: 'not_applicable', errorCode: 'prior_queue_cleanup' };
  }
  return { kind: 'needs_attention', errorCode: 'legacy_identity_unresolved' };
}
