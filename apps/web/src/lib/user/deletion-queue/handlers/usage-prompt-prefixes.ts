import type { DeletionHandler } from '@/lib/user/deletion-queue/handlers/common';
import { userIdKeyedAbsenceOutcome } from '@/lib/user/deletion-queue/deletion-subject';

// Usage no longer stores prompt prefixes and the columns are being dropped, so there is
// nothing to scrub. The step key stays because persisted queue rows still reference it.
export const handleUsagePromptPrefixes: DeletionHandler = async ({ request, step }) => {
  const absence = userIdKeyedAbsenceOutcome(request);
  if (absence) return absence;

  // not_applicable resets progress_json, so keep the counts from an earlier partial scrub.
  const { processed_count = 0, scanned_count = 0 } = step.progress_json;
  return processed_count > 0 || scanned_count > 0
    ? { kind: 'succeeded', progress: step.progress_json }
    : { kind: 'not_applicable' };
};
