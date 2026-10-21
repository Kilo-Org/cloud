/**
 * Credit admission for code review dispatch.
 *
 * Code Reviewer reviews run on Cloud Agent sessions, and the cloud-agent-next
 * balance middleware refuses to start a billable session when the paying
 * account cannot cover the minimum balance. Decide that here, before a worker
 * call, so an unaffordable review is reported to the customer instead of
 * preparing a session that cannot run.
 *
 * Reviews keep the balance-check skip only for the cases current source already
 * treats as not billed to the Kilo balance:
 * - free models and BYOK-capable models, mirroring
 *   `createCloudAgentNextClientForModel` in
 *   `apps/web/src/lib/cloud-agent-next/cloud-agent-client.ts`;
 * - OSS-sponsored organizations, the documented exception in
 *   `services/code-review-infra/src/types.ts`.
 */

import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { computeCloudAgentNextBalanceCheckEligibility } from '@/lib/cloud-agent-next/balance-check-eligibility';
import type { Owner } from '../core';

/**
 * Same floor as `MIN_BALANCE_DOLLARS` in
 * `services/cloud-agent-next/src/balance-validation.ts`. The worker is the
 * enforcing authority; keeping the dispatch gate on the same value means an
 * unaffordable review is refused here instead of after a session is prepared.
 */
export const MIN_CODE_REVIEW_BALANCE_MICRODOLLARS = 1_000_000;

export type CodeReviewDispatchBilling =
  | {
      skipBalanceCheck: true;
      reason: 'free_model' | 'byok' | 'sponsored_organization';
    }
  | {
      skipBalanceCheck: false;
      canAfford: boolean;
      balanceMicrodollars: number;
    };

type CodeReviewPayer = {
  balanceMicrodollars: number;
  sponsored: boolean;
};

async function loadCodeReviewPayer(owner: Owner): Promise<CodeReviewPayer | null> {
  if (owner.type === 'org') {
    const [organization] = await db
      .select({
        totalMicrodollarsAcquired: organizations.total_microdollars_acquired,
        microdollarsUsed: organizations.microdollars_used,
        settings: organizations.settings,
      })
      .from(organizations)
      .where(eq(organizations.id, owner.id))
      .limit(1);

    if (!organization) return null;

    return {
      balanceMicrodollars: organization.totalMicrodollarsAcquired - organization.microdollarsUsed,
      sponsored: organization.settings?.oss_sponsorship_tier != null,
    };
  }

  const [user] = await db
    .select({
      totalMicrodollarsAcquired: kilocode_users.total_microdollars_acquired,
      microdollarsUsed: kilocode_users.microdollars_used,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, owner.userId))
    .limit(1);

  if (!user) return null;

  return {
    balanceMicrodollars: user.totalMicrodollarsAcquired - user.microdollarsUsed,
    sponsored: false,
  };
}

/**
 * Resolve whether a review on `model` may dispatch with the worker balance
 * check skipped, and when it may not, whether the paying account can cover the
 * worker's minimum admission balance.
 */
export async function resolveCodeReviewDispatchBilling(params: {
  owner: Owner;
  model: string;
}): Promise<CodeReviewDispatchBilling> {
  const eligibility = await computeCloudAgentNextBalanceCheckEligibility({
    fromDb: db,
    user: { id: params.owner.userId },
    modelId: params.model,
    organizationId: params.owner.type === 'org' ? params.owner.id : undefined,
  });

  if (eligibility.isFree) {
    return { skipBalanceCheck: true, reason: 'free_model' };
  }
  if (eligibility.hasUserByokAvailable) {
    return { skipBalanceCheck: true, reason: 'byok' };
  }

  const payer = await loadCodeReviewPayer(params.owner);
  if (payer?.sponsored) {
    return { skipBalanceCheck: true, reason: 'sponsored_organization' };
  }

  const balanceMicrodollars = payer?.balanceMicrodollars ?? 0;
  return {
    skipBalanceCheck: false,
    canAfford: balanceMicrodollars >= MIN_CODE_REVIEW_BALANCE_MICRODOLLARS,
    balanceMicrodollars,
  };
}
