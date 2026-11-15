import { createHash } from 'node:crypto';

import {
  agent_configs,
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  code_review_analytics_findings,
  code_review_analytics_results,
  kilocode_users,
  organization_memberships,
} from '@kilocode/db/schema';
import { and, asc, eq, like } from 'drizzle-orm';

import { type SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';

export const usage = '<owner-email>';

/**
 * Completed, analytics-captured Code Reviewer rows for every organization the
 * given owner belongs to, so the mobile Code Reviewer Analytics screen renders
 * real numbers for both platforms and all three periods.
 *
 * The screen counts a review only when all of these hold, which is what the
 * fixture writes (`analyticsDashboardQuery` in
 * `apps/web/src/lib/code-reviews/analytics/db.ts`): the review is `completed`
 * for the requested platform and organization, its newest attempt is
 * `completed`, dispatched with `analytics_enabled_at_dispatch = true` and
 * completed inside the window, and a `code_review_analytics_results` row with
 * `capture_status = 'captured'` exists for that review and attempt, with its
 * `code_review_analytics_findings`.
 *
 * Each platform gets nine reviews at four ages (5, 20, 45 and 75 days), so the
 * 7-day period counts four, the 30-day period counts five and the 90-day period
 * counts nine; GitHub carries three findings per review and GitLab two, so the
 * platforms differ too.
 *
 * Every row hangs off a review whose `repo_full_name` starts with
 * {@link REPO_MARKER}: a rerun deletes those reviews (attempts, results and
 * findings cascade) and inserts fresh ones under the same derived ids. The
 * account and its organizations must already exist; this seed creates neither.
 */
const REPO_MARKER = 'dev-seed-analytics/';

const PLATFORMS = ['github', 'gitlab'] as const;

type SeedPlatform = (typeof PLATFORMS)[number];

type AnalyticsResultInsert = typeof code_review_analytics_results.$inferInsert;
type FindingInsert = typeof code_review_analytics_findings.$inferInsert;

type ReviewBlueprint = {
  ageInDays: number;
  changeType: NonNullable<AnalyticsResultInsert['change_type']>;
  impact: NonNullable<AnalyticsResultInsert['impact_level']>;
  complexity: NonNullable<AnalyticsResultInsert['complexity_level']>;
  confidence: NonNullable<AnalyticsResultInsert['classification_confidence']>;
};

type FindingBlueprint = {
  severity: FindingInsert['severity'];
  category: FindingInsert['category'];
  securityClass: FindingInsert['security_class'];
};

/**
 * The nine reviews per platform. Their ages put four inside the 7-day period,
 * five inside the 30-day one, and all nine inside the 90-day one; the
 * classification values only vary the breakdowns, not the counted reviews.
 */
const REVIEW_BLUEPRINTS = [
  { ageInDays: 5, changeType: 'feature', impact: 'high', complexity: 'medium', confidence: 'high' },
  { ageInDays: 5, changeType: 'bug_fix', impact: 'low', complexity: 'low', confidence: 'high' },
  {
    ageInDays: 5,
    changeType: 'refactor',
    impact: 'medium',
    complexity: 'high',
    confidence: 'medium',
  },
  {
    ageInDays: 5,
    changeType: 'maintenance',
    impact: 'low',
    complexity: 'low',
    confidence: 'high',
  },
  {
    ageInDays: 20,
    changeType: 'dependency',
    impact: 'medium',
    complexity: 'low',
    confidence: 'low',
  },
  { ageInDays: 45, changeType: 'test', impact: 'medium', complexity: 'medium', confidence: 'high' },
  {
    ageInDays: 45,
    changeType: 'documentation',
    impact: 'low',
    complexity: 'low',
    confidence: 'medium',
  },
  { ageInDays: 75, changeType: 'mixed', impact: 'high', complexity: 'high', confidence: 'high' },
  {
    ageInDays: 75,
    changeType: 'other',
    impact: 'medium',
    complexity: 'medium',
    confidence: 'medium',
  },
] as const satisfies readonly ReviewBlueprint[];

/**
 * Two finding counts, both inside the 2–4 range a captured result carries, so
 * the GitHub and GitLab dashboards differ. The GitHub list holds one security
 * finding because `category = 'security'` requires a `security_class`.
 */
const FINDINGS_BY_PLATFORM = {
  github: [
    { severity: 'critical', category: 'correctness', securityClass: null },
    { severity: 'warning', category: 'security', securityClass: 'injection' },
    { severity: 'suggestion', category: 'performance', securityClass: null },
  ],
  gitlab: [
    { severity: 'warning', category: 'reliability', securityClass: null },
    { severity: 'suggestion', category: 'documentation', securityClass: null },
  ],
} as const satisfies Record<SeedPlatform, readonly FindingBlueprint[]>;

const PERIODS = [7, 30, 90] as const;

type Period = (typeof PERIODS)[number];

/**
 * Mirrors `createDefaultCodeReviewConfig({ reviewAnalyticsEnabled: true })`
 * from `apps/web/src/lib/code-reviews/core/default-config.ts`. A seed topic must
 * not import from `apps/web/src` (server-only Next runtime, `dev/seed/AGENTS.md`),
 * so the object is repeated here; `model_slug` is `PRIMARY_DEFAULT_MODEL`.
 */
const REVIEW_ANALYTICS_CONFIG = {
  review_style: 'balanced',
  focus_areas: [],
  custom_instructions: null,
  model_slug: 'deepseek/deepseek-v4.1-flash-1017',
  thinking_effort: null,
  gate_threshold: 'off',
  repository_selection_mode: 'all',
  selected_repository_ids: [],
  manually_added_repositories: [],
  disable_review_md: true,
  review_memory_enabled: false,
  review_analytics_enabled: true,
};

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const MINUTE_IN_MS = 60 * 1000;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-reviewer-analytics ${usage}`);
  console.log(
    'Seeds completed, analytics-captured Code Reviewer reviews for every organization the owner belongs to.'
  );
  console.log('Requires a localhost database and an existing account with memberships.');
  console.log('Open a returned deep link in a signed-in mobile development client.');
}

/**
 * Stable UUID for a fixture key. A rerun replaces the same rows instead of
 * adding new ones, and the review, attempt and result ids stay referable.
 */
function seedUuid(key: string): string {
  const hex = createHash('md5').update(`app:mobile-reviewer-analytics:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function seedSha(key: string): string {
  return createHash('sha1').update(`app:mobile-reviewer-analytics:${key}`).digest('hex');
}

function repoFullName(platform: SeedPlatform): string {
  return `${REPO_MARKER}${platform}-service`;
}

function analyticsDeepLink(organizationId: string): string {
  return `kiloapp:///(app)/code-reviewer/${organizationId}/analytics`;
}

/**
 * Mirrors `withPlatformRepositoryMode` in
 * `apps/web/src/lib/code-reviews/core/repository-mode.ts`: GitLab honours only
 * `selected`, so its stored config cannot keep the default `all`.
 */
function agentConfigFor(platform: SeedPlatform) {
  return platform === 'gitlab'
    ? { ...REVIEW_ANALYTICS_CONFIG, repository_selection_mode: 'selected' }
    : REVIEW_ANALYTICS_CONFIG;
}

function expectedCounts(platform: SeedPlatform, period: Period) {
  const reviews = REVIEW_BLUEPRINTS.filter(b => b.ageInDays <= period).length;
  return { reviews, findings: reviews * FINDINGS_BY_PLATFORM[platform].length };
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const [email, ...extra] = args;
  if (!email || extra.length > 0 || !/^kilo-[a-z0-9-]+@example\.com$/.test(email)) {
    printUsage();
    throw new Error('Provide one owned fake email matching kilo-<name>@example.com.');
  }
  assertLocalSeedDatabase('app:mobile-reviewer-analytics');
  const db = getSeedDb();

  const users = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, email));
  const user = users.at(0);
  if (!user) {
    throw new Error(
      `No account for ${email}. Create it first: pnpm dev:seed app:mobile-org-admin ${email} <admin-email> <member-email>`
    );
  }

  const memberships = await db
    .select({ organizationId: organization_memberships.organization_id })
    .from(organization_memberships)
    .where(eq(organization_memberships.kilo_user_id, user.id))
    .orderBy(asc(organization_memberships.organization_id));
  if (memberships.length === 0) {
    throw new Error(
      `${email} is not a member of any organization. Add a membership first, for example with pnpm dev:seed app:mobile-org-admin.`
    );
  }

  const now = Date.now();
  const reviews: (typeof cloud_agent_code_reviews.$inferInsert)[] = [];
  const attempts: (typeof cloud_agent_code_review_attempts.$inferInsert)[] = [];
  const results: AnalyticsResultInsert[] = [];
  const findings: (typeof code_review_analytics_findings.$inferInsert)[] = [];

  for (const membership of memberships) {
    const organizationId = membership.organizationId;
    for (const platform of PLATFORMS) {
      for (const [index, blueprint] of REVIEW_BLUEPRINTS.entries()) {
        const key = `${organizationId}:${platform}:${index}`;
        const completedAt = new Date(
          now - blueprint.ageInDays * DAY_IN_MS - index * 7 * MINUTE_IN_MS
        ).toISOString();
        const startedAt = new Date(Date.parse(completedAt) - 6 * MINUTE_IN_MS).toISOString();
        const reviewId = seedUuid(key);
        const attemptId = seedUuid(`${key}:attempt`);
        const resultId = seedUuid(`${key}:result`);
        const repository = repoFullName(platform);

        reviews.push({
          id: reviewId,
          owned_by_organization_id: organizationId,
          repo_full_name: repository,
          pr_number: 100 + index,
          pr_url: `https://example.com/${repository}/pull/${100 + index}`,
          pr_title: `${blueprint.changeType}: update ${repository}`,
          pr_author: `analytics-dev-${(index % 3) + 1}`,
          pr_author_github_id: platform === 'github' ? String(48000001 + (index % 3)) : null,
          base_ref: 'main',
          head_ref: `feature/review-${index + 1}`,
          head_sha: seedSha(`${key}:head`),
          platform,
          status: 'completed',
          model: 'anthropic/claude-sonnet-4.6',
          started_at: startedAt,
          completed_at: completedAt,
          created_at: startedAt,
        });
        attempts.push({
          id: attemptId,
          code_review_id: reviewId,
          attempt_number: 1,
          status: 'completed',
          analytics_enabled_at_dispatch: true,
          publication_status: 'published',
          started_at: startedAt,
          completed_at: completedAt,
        });
        results.push({
          id: resultId,
          code_review_id: reviewId,
          source_attempt_id: attemptId,
          capture_status: 'captured',
          change_type: blueprint.changeType,
          impact_level: blueprint.impact,
          complexity_level: blueprint.complexity,
          classification_confidence: blueprint.confidence,
          finalized_at: completedAt,
        });
        for (const [ordinal, finding] of FINDINGS_BY_PLATFORM[platform].entries()) {
          findings.push({
            analytics_result_id: resultId,
            ordinal,
            severity: finding.severity,
            category: finding.category,
            security_class: finding.securityClass,
          });
        }
      }
    }
  }

  // Delete first so a rerun after a manual change restores the fixture; the
  // attempts, analytics results and findings cascade from the reviews.
  await Promise.all(
    memberships.map(membership =>
      db
        .delete(cloud_agent_code_reviews)
        .where(
          and(
            eq(cloud_agent_code_reviews.owned_by_organization_id, membership.organizationId),
            like(cloud_agent_code_reviews.repo_full_name, `${REPO_MARKER}%`)
          )
        )
    )
  );
  await db.insert(cloud_agent_code_reviews).values(reviews);
  await db.insert(cloud_agent_code_review_attempts).values(attempts);
  await db.insert(code_review_analytics_results).values(results);
  await db.insert(code_review_analytics_findings).values(findings);

  // The screen reads `review_analytics_enabled` from the organization's
  // `code_review` config; without a row it shows the muted "analytics off" note.
  // The analytics toggle writes the same row with `is_enabled: false`
  // (`setReviewAnalyticsEnabled` in
  // `apps/web/src/lib/code-reviews/analytics/settings.ts`), and review dispatch
  // reads that flag, so the fixture leaves the agent off exactly as the toggle
  // does. An existing row wins, so a manual save survives a rerun.
  await db
    .insert(agent_configs)
    .values(
      memberships.flatMap(membership =>
        PLATFORMS.map(platform => ({
          owned_by_organization_id: membership.organizationId,
          agent_type: 'code_review',
          platform,
          config: agentConfigFor(platform),
          is_enabled: false,
          created_by: user.id,
        }))
      )
    )
    .onConflictDoNothing({
      target: [
        agent_configs.owned_by_organization_id,
        agent_configs.agent_type,
        agent_configs.platform,
      ],
    });

  const counts: SeedResult = {};
  for (const platform of PLATFORMS) {
    for (const period of PERIODS) {
      const expected = expectedCounts(platform, period);
      counts[`${platform}Reviews${period}`] = expected.reviews;
      counts[`${platform}Findings${period}`] = expected.findings;
    }
  }

  const organizations: SeedResult = {
    organizationCount: memberships.length,
  };
  for (const [index, membership] of memberships.entries()) {
    organizations[`organization${index + 1}Id`] = membership.organizationId;
    organizations[`organization${index + 1}DeepLink`] = analyticsDeepLink(
      membership.organizationId
    );
  }

  console.log(
    'This fixture represents: completed reviews the Analytics screen captured, with a different count for each period and platform.'
  );
  console.log(
    `Rows are keyed by ${REPO_MARKER}; a rerun replaces them and keeps an existing analytics setting. Suggested next step: open an organization deep link on the signed-in mobile app and switch platform and period.`
  );

  return {
    email,
    userId: user.id,
    ...organizations,
    ...counts,
  };
}
