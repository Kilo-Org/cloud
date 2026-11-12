import { sanitizedExceptionName } from '@kilocode/worker-utils/scheduled-job-observability';
import { listBlacklistedDomains } from '@kilocode/web-shared/lib/blacklist-domains-config';
import { backfillBlockBlacklistedDomainsBatch } from '@/lib/abuse/block-blacklisted-domains';
import { getPostgresErrorCode } from '@/lib/db-errors';
import type { BackfillBatchResult } from '@/lib/backfills/batch';
import { backfillBlockedAtBatch } from '@/lib/backfills/blocked-at';
import { backfillBlockedUserPepperBatch } from '@/lib/backfills/blocked-user-pepper';
import { backfillEmailDomainBatch } from '@/lib/backfills/email-domain';
import { backfillNormalizedEmailBatch } from '@/lib/backfills/normalized-email';
import { backfillSafetyIdentifiersBatch } from '@/lib/backfills/safety-identifiers';

type ScheduledBackfill = {
  name: string;
  run: () => Promise<BackfillBatchResult>;
};

// Email domains are filled before blacklisted domains are blocked.
const scheduledBackfills: ScheduledBackfill[] = [
  { name: 'normalized_email', run: backfillNormalizedEmailBatch },
  { name: 'email_domain', run: backfillEmailDomainBatch },
  {
    name: 'block_blacklisted_domains',
    run: async () =>
      backfillBlockBlacklistedDomainsBatch({
        actorId: null,
        domains: await listBlacklistedDomains(),
      }),
  },
  { name: 'blocked_at', run: backfillBlockedAtBatch },
  { name: 'blocked_user_pepper', run: backfillBlockedUserPepperBatch },
  { name: 'safety_identifiers', run: backfillSafetyIdentifiersBatch },
];

export type ScheduledBackfillOutcome = { name: string } & (
  | ({ status: 'completed' } & BackfillBatchResult)
  | { status: 'failed' }
  | { status: 'skipped' }
);

/**
 * Runs one batch of every backfill; a failing backfill does not stop the others. Backfills not
 * started by `deadlineAt` are skipped so the run can report before the function is killed.
 */
export async function runScheduledBackfills(params: {
  deadlineAt: number;
}): Promise<ScheduledBackfillOutcome[]> {
  const outcomes: ScheduledBackfillOutcome[] = [];
  for (const { name, run } of scheduledBackfills) {
    if (Date.now() >= params.deadlineAt) {
      outcomes.push({ name, status: 'skipped' });
      continue;
    }
    try {
      outcomes.push({ name, status: 'completed', ...(await run()) });
    } catch (error) {
      console.error('Scheduled backfill failed', {
        backfill: name,
        exception_name: sanitizedExceptionName(error),
        database_error_code: getPostgresErrorCode(error),
      });
      outcomes.push({ name, status: 'failed' });
    }
  }
  return outcomes;
}
