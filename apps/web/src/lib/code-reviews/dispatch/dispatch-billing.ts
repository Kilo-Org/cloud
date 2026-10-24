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
 *
 * Every model the review will actually run counts: a council review pins each
 * specialist sub-agent to its own model, so the skip applies only when all of
 * them are exempt.
 */

import { subHours } from 'date-fns';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, organizations, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  accountBalanceMicrodollars,
  findOrganizationMemberBalanceRow,
  organizationMemberBalance,
} from '@kilocode/worker-utils/account-access';
import {
  processLocalExpirations,
  processOrganizationExpirations,
} from '@kilocode/web-shared/lib/creditExpiration';
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

async function loadPayerUser(owner: Owner): Promise<User | null> {
  const [user] = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, owner.userId))
    .limit(1);
  return user ?? null;
}

/**
 * Effective balance for the paying account, mirroring what the worker's
 * `/api/cloud-agent-next/balance` endpoint reports: expired credits are
 * processed first, and organization balances respect the paying member's
 * allowance. Auto top-up scheduling is a request-scoped side effect, so it is
 * intentionally not part of this read.
 */
async function loadEffectiveBalanceMicrodollars(params: {
  owner: Owner;
  user: User;
}): Promise<number> {
  const expireBefore = subHours(new Date(), Math.random());

  if (params.owner.type === 'org') {
    const row = await findOrganizationMemberBalanceRow(
      db,
      params.owner.id,
      params.user.id,
      'daily'
    );
    if (!row) return 0;

    let totalMicrodollarsAcquired = row.total_microdollars_acquired;
    if (row.next_credit_expiration_at && expireBefore >= new Date(row.next_credit_expiration_at)) {
      const expiryResult = await processOrganizationExpirations(
        {
          id: params.owner.id,
          microdollars_used: row.microdollars_used,
          next_credit_expiration_at: row.next_credit_expiration_at,
          total_microdollars_acquired: totalMicrodollarsAcquired,
        },
        expireBefore
      );
      if (expiryResult) {
        totalMicrodollarsAcquired = expiryResult.total_microdollars_acquired;
      }
    }

    return organizationMemberBalance({
      ...row,
      total_microdollars_acquired: totalMicrodollarsAcquired,
    }).balanceMicrodollars;
  }

  let user = params.user;
  if (user.next_credit_expiration_at && expireBefore >= new Date(user.next_credit_expiration_at)) {
    const result = await processLocalExpirations(user, expireBefore);
    if (result) {
      user = { ...user, ...result };
    }
  }

  return accountBalanceMicrodollars(user);
}

/**
 * Resolve whether a review on `models` may dispatch with the worker balance
 * check skipped, and when it may not, whether the paying account can cover the
 * worker's minimum admission balance.
 */
export async function resolveCodeReviewDispatchBilling(params: {
  owner: Owner;
  models: readonly string[];
}): Promise<CodeReviewDispatchBilling> {
  const organizationId = params.owner.type === 'org' ? params.owner.id : undefined;

  let everyModelExempt = true;
  let anyByok = false;
  for (const model of new Set(params.models)) {
    const eligibility = await computeCloudAgentNextBalanceCheckEligibility({
      fromDb: db,
      user: { id: params.owner.userId },
      modelId: model,
      organizationId,
    });
    if (!eligibility.isFree && !eligibility.hasUserByokAvailable) {
      everyModelExempt = false;
      break;
    }
    if (eligibility.hasUserByokAvailable) {
      anyByok = true;
    }
  }

  if (everyModelExempt) {
    return { skipBalanceCheck: true, reason: anyByok ? 'byok' : 'free_model' };
  }

  if (organizationId) {
    const [organization] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (organization?.settings?.oss_sponsorship_tier != null) {
      return { skipBalanceCheck: true, reason: 'sponsored_organization' };
    }
  }

  const user = await loadPayerUser(params.owner);
  if (!user) {
    return { skipBalanceCheck: false, canAfford: false, balanceMicrodollars: 0 };
  }

  const balanceMicrodollars = await loadEffectiveBalanceMicrodollars({
    owner: params.owner,
    user,
  });
  return {
    skipBalanceCheck: false,
    canAfford: balanceMicrodollars >= MIN_CODE_REVIEW_BALANCE_MICRODOLLARS,
    balanceMicrodollars,
  };
}
