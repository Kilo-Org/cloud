import pLimit from 'p-limit';
import { and, eq, isNull } from 'drizzle-orm';
import { readDb } from '@/lib/drizzle';
import { organizations, organization_memberships, kilocode_users } from '@kilocode/db/schema';
import { getOrganizationRecommendations } from './recommendations';
import { sendRecommendationsDigestEmail } from '@/lib/email';
import { errorExceptInTest, logExceptInTest } from '@/lib/utils.server';

// Cap the number of recommendations listed in the email; the rest live on the
// dashboard the email links to.
const MAX_RECOMMENDATIONS_IN_EMAIL = 3;
const ORG_DISPATCH_CONCURRENCY = 4;

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
  emailFailures: number;
  orgFailures: number;
};

// Cron entrypoint: send the weekly recommendations digest to the owners of every
// Enterprise org that has the digest enabled and has something actionable.
export async function dispatchEnterpriseRecommendationsDigests(): Promise<RecommendationsDigestDispatchSummary> {
  const orgs = await readDb
    .select({
      id: organizations.id,
      name: organizations.name,
      settings: organizations.settings,
    })
    .from(organizations)
    .where(and(eq(organizations.plan, 'enterprise'), isNull(organizations.deleted_at)));

  const enabledOrgs = orgs.filter(org => org.settings?.recommendations_digest_enabled === true);

  const summary: RecommendationsDigestDispatchSummary = {
    enabledOrgs: enabledOrgs.length,
    orgsSkippedEmpty: 0,
    orgsSkippedNoOwners: 0,
    emailsSent: 0,
    emailFailures: 0,
    orgFailures: 0,
  };

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
            const result = await sendRecommendationsDigestEmail(recipient, digest);
            if (result.sent) {
              summary.emailsSent++;
            } else {
              summary.emailFailures++;
              logExceptInTest(
                `[recommendationsDigest] send skipped for org ${org.id}: ${result.reason}`
              );
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
