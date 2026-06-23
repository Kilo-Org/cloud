import pLimit from 'p-limit';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, readDb } from '@/lib/drizzle';
import {
  organizations,
  organization_memberships,
  kilocode_users,
  transactional_email_log,
} from '@kilocode/db/schema';
import { getOrganizationRecommendations } from './recommendations';
import { sendRecommendationsDigestEmail } from '@/lib/email';
import { errorExceptInTest, logExceptInTest } from '@/lib/utils.server';

// Cap the number of recommendations listed in the email; the rest live on the
// dashboard the email links to.
const MAX_RECOMMENDATIONS_IN_EMAIL = 3;
const ORG_DISPATCH_CONCURRENCY = 4;
// email_type for the transactional_email_log idempotency markers.
const DIGEST_EMAIL_TYPE = 'recommendations_digest';

// Period key for one weekly send: the UTC date (YYYY-MM-DD) of the week's Monday.
// Two invocations in the same week (cron overlap, a Vercel retry, a replay) compute
// the same key, so the per-recipient idempotency claim below dedupes them.
export function currentDigestPeriodKey(now: Date): string {
  const midnightUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (midnightUtc.getUTCDay() + 6) % 7;
  midnightUtc.setUTCDate(midnightUtc.getUTCDate() - daysSinceMonday);
  return midnightUtc.toISOString().slice(0, 10);
}

function digestIdempotencyKey(
  organizationId: string,
  recipient: string,
  periodKey: string
): string {
  return `${organizationId}:${recipient}:${periodKey}`;
}

export type RecommendationsDigestData = {
  organizationId: string;
  organizationName: string;
  adoptedCount: number;
  totalCount: number;
  openCount: number;
  recommendations: Array<{
    title: string;
    description: string;
    actionLabel: string;
    actionUrl: string;
  }>;
};

// Build the digest payload for one org, or null when there's nothing actionable.
// Skip-empty rule: no open recommendations means no email this week (a digest
// that says "all good" every week trains owners to ignore it).
export async function buildOrganizationRecommendationsDigest(
  organizationId: string,
  organizationName: string
): Promise<RecommendationsDigestData | null> {
  const { plan, checks, recommendations } = await getOrganizationRecommendations(organizationId);
  if (plan !== 'enterprise') {
    return null;
  }

  const openRecommendations = recommendations.filter(rec => rec.status === 'open');
  if (openRecommendations.length === 0) {
    return null;
  }

  return {
    organizationId,
    organizationName,
    adoptedCount: checks.filter(check => check.adopted).length,
    totalCount: checks.length,
    openCount: openRecommendations.length,
    recommendations: openRecommendations.slice(0, MAX_RECOMMENDATIONS_IN_EMAIL).map(rec => ({
      title: rec.title,
      description: rec.description,
      actionLabel: rec.actionLabel,
      actionUrl: rec.actionUrl,
    })),
  };
}

// Owner email addresses for an org (excludes bot users). The digest goes to owners
// only, mirroring the owner-only toggle and the recommendations dismiss/restore gate.
export async function getOrganizationOwnerEmails(organizationId: string): Promise<string[]> {
  const rows = await readDb
    .select({ email: kilocode_users.google_user_email })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.role, 'owner'),
        eq(kilocode_users.is_bot, false)
      )
    );
  return rows.map(row => row.email).filter((email): email is string => Boolean(email));
}

export type RecommendationsDigestDispatchSummary = {
  enabledOrgs: number;
  orgsSkippedEmpty: number;
  orgsSkippedNoOwners: number;
  emailsSent: number;
  duplicatesSkipped: number;
  emailFailures: number;
  orgFailures: number;
};

type RecipientSendOutcome = 'sent' | 'duplicate' | 'failed';

// Claim (org, recipient, week) before sending so the same owner can't get two
// digests for one week. The unique (email_type, idempotency_key) index makes the
// insert the atomic claim; a lost insert (rowCount 0) means another invocation
// already owns this send. If the send then fails, the claim is released so a later
// run can retry. Mirrors the kilo-pass duplicate-card email path.
async function sendDigestToRecipientOnce(
  recipient: string,
  organizationId: string,
  periodKey: string,
  digest: RecommendationsDigestData
): Promise<RecipientSendOutcome> {
  const idempotency_key = digestIdempotencyKey(organizationId, recipient, periodKey);

  const claim = await db
    .insert(transactional_email_log)
    .values({
      organization_id: organizationId,
      email_type: DIGEST_EMAIL_TYPE,
      idempotency_key,
    })
    .onConflictDoNothing();

  if ((claim.rowCount ?? 0) === 0) {
    return 'duplicate';
  }

  const result = await sendRecommendationsDigestEmail(recipient, digest);
  if (result.sent) {
    return 'sent';
  }

  // Release the claim so a future run can retry this recipient/week.
  await db
    .delete(transactional_email_log)
    .where(
      and(
        eq(transactional_email_log.email_type, DIGEST_EMAIL_TYPE),
        eq(transactional_email_log.idempotency_key, idempotency_key)
      )
    );
  logExceptInTest(
    `[recommendationsDigest] send skipped for org ${organizationId}: ${result.reason}`
  );
  return 'failed';
}

// Cron entrypoint: send the weekly recommendations digest to the owners of every
// Enterprise org that has the digest enabled and has something actionable.
export async function dispatchEnterpriseRecommendationsDigests(): Promise<RecommendationsDigestDispatchSummary> {
  // Filter to opted-in orgs in SQL so the read scales with actual recipients, not
  // the entire Enterprise population. The flag is only ever stored as `true` (it is
  // removed when disabled), so a `->> = 'true'` predicate is exact.
  const enabledOrgs = await readDb
    .select({
      id: organizations.id,
      name: organizations.name,
    })
    .from(organizations)
    .where(
      and(
        eq(organizations.plan, 'enterprise'),
        isNull(organizations.deleted_at),
        sql`${organizations.settings}->>'recommendations_digest_enabled' = 'true'`
      )
    );

  const summary: RecommendationsDigestDispatchSummary = {
    enabledOrgs: enabledOrgs.length,
    orgsSkippedEmpty: 0,
    orgsSkippedNoOwners: 0,
    emailsSent: 0,
    duplicatesSkipped: 0,
    emailFailures: 0,
    orgFailures: 0,
  };

  const periodKey = currentDigestPeriodKey(new Date());
  const limit = pLimit(ORG_DISPATCH_CONCURRENCY);
  await Promise.all(
    enabledOrgs.map(org =>
      limit(async () => {
        try {
          const digest = await buildOrganizationRecommendationsDigest(org.id, org.name);
          if (!digest) {
            summary.orgsSkippedEmpty++;
            return;
          }

          const owners = await getOrganizationOwnerEmails(org.id);
          if (owners.length === 0) {
            summary.orgsSkippedNoOwners++;
            return;
          }

          for (const recipient of owners) {
            const outcome = await sendDigestToRecipientOnce(recipient, org.id, periodKey, digest);
            if (outcome === 'sent') {
              summary.emailsSent++;
            } else if (outcome === 'duplicate') {
              summary.duplicatesSkipped++;
            } else {
              summary.emailFailures++;
            }
          }
        } catch (error) {
          summary.orgFailures++;
          errorExceptInTest('[recommendationsDigest] org dispatch failed', {
            organizationId: org.id,
            error,
          });
        }
      })
    )
  );

  return summary;
}
