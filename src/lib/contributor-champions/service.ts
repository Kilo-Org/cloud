import 'server-only';

import { db } from '@/lib/drizzle';
import { fetchWithBackoff } from '@/lib/fetchWithBackoff';
import { GITHUB_ADMIN_STATS_TOKEN } from '@/lib/config.server';
import teamLoginsJson from '@/data/contributor-champion-kilo-team.json';
import {
  contributor_champion_contributors,
  contributor_champion_events,
  contributor_champion_memberships,
  contributor_champion_sync_state,
  kilocode_users,
} from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import * as z from 'zod';
import { grantCreditForCategory } from '@/lib/promotionalCredits';
import { toMicrodollars, fromMicrodollars } from '@/lib/utils';
import { captureException } from '@sentry/nextjs';

const TEAM_LOGIN_CONFIG_SCHEMA = z.union([
  z.array(z.string().min(1)),
  z.record(z.string(), z.array(z.string().min(1))),
]);

const TEAM_LOGIN_LIST = (() => {
  const parsed = TEAM_LOGIN_CONFIG_SCHEMA.parse(teamLoginsJson);
  if (Array.isArray(parsed)) return parsed;
  return Object.values(parsed).flat();
})();

const TEAM_LOGIN_SET = new Set(TEAM_LOGIN_LIST.map(login => login.trim().toLowerCase()));

const TEAM_EMAIL_DOMAINS = new Set(['kilocode.ai', 'kilo.ai']);
const TEAM_EMAILS = new Set(['vincesprints@gmail.com']);

function isTeamEmail(email: string | null): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  const domain = lower.split('@')[1];
  return (domain !== undefined && TEAM_EMAIL_DOMAINS.has(domain)) || TEAM_EMAILS.has(lower);
}

const REPO_OWNER = 'Kilo-Org';
const REPO_NAME = 'kilocode';
const REPO_FULL_NAME = `${REPO_OWNER}/${REPO_NAME}`;

const CONTRIBUTOR_TIERS = {
  contributor: 'contributor',
  ambassador: 'ambassador',
  champion: 'champion',
} as const;

const CONTRIBUTOR_TIER_SCHEMA = z.enum([
  CONTRIBUTOR_TIERS.contributor,
  CONTRIBUTOR_TIERS.ambassador,
  CONTRIBUTOR_TIERS.champion,
]);

type ContributorTier = (typeof CONTRIBUTOR_TIERS)[keyof typeof CONTRIBUTOR_TIERS];

/** Monthly credit amount in USD for each contributor tier. */
const TIER_CREDIT_USD: Record<ContributorTier, number> = {
  contributor: 0,
  ambassador: 50,
  champion: 150,
};

const CREDIT_EXPIRY_HOURS = 30 * 24; // 30 days

const SEARCH_PULL_REQUEST_LIST_ITEM_SCHEMA = z.object({
  number: z.number().int().nonnegative(),
  html_url: z.string().url(),
  title: z.string(),
  pull_request: z
    .object({
      merged_at: z.string().nullable().optional(),
    })
    .optional(),
  user: z
    .object({
      login: z.string().min(1),
      id: z.number().int().nonnegative().optional(),
      type: z.string().optional(),
      html_url: z.string().url().optional(),
    })
    .nullable(),
});

const SEARCH_PULL_REQUEST_LIST_SCHEMA = z.object({
  total_count: z.number().int().nonnegative(),
  items: z.array(SEARCH_PULL_REQUEST_LIST_ITEM_SCHEMA),
});

const PULL_REQUEST_COMMITS_SCHEMA = z.array(
  z.object({
    author: z
      .object({
        login: z.string().min(1),
      })
      .nullable(),
    commit: z.object({
      author: z
        .object({
          email: z.string().nullable().optional(),
        })
        .nullable(),
    }),
  })
);

type MergedPullRequest = {
  number: number;
  title: string;
  url: string;
  authorLogin: string;
  authorGithubUserId: number | null;
  authorProfileUrl: string;
  mergedAt: string;
};

type LeaderboardRow = {
  contributorId: string;
  githubLogin: string;
  githubProfileUrl: string;
  email: string | null;
  linkedUserId: string | null;
  linkedUserName: string | null;
  linkedUserImageUrl: string | null;
  contributionsAllTime: number;
  contributions30d: number;
  contributions90d: number;
  suggestedTier: ContributorTier | null;
  selectedTier: ContributorTier | null;
  enrolledTier: ContributorTier | null;
  enrolledAt: string | null;
  creditAmountUsd: number | null;
  creditsLastGrantedAt: string | null;
  linkedKiloUserId: string | null;
};

type DrillInWindow = 'all_time' | 'rolling_30_days';

type ContributionDrillInRow = {
  eventId: string;
  repoFullName: string;
  githubPrNumber: number;
  githubPrUrl: string;
  githubPrTitle: string;
  githubAuthorLogin: string;
  githubAuthorEmail: string | null;
  mergedAt: string;
};

type SyncSummary = {
  repoFullName: string;
  fetchedMergedPullRequests: number;
  insertedContributionEvents: number;
  upsertedContributors: number;
  checkpointMergedAt: string | null;
  startedAt: string;
  finishedAt: string;
};

type ContributorChampionProfileBadge = {
  tier: ContributorTier;
  enrolledAt: string;
};

type CreditRefreshSummary = {
  processed: number;
  granted: number;
  skippedNoUser: number;
  errored: number;
};

type AutoUpgradeSummary = {
  processed: number;
  upgraded: number;
  upgrades: Array<{
    contributorId: string;
    githubLogin: string;
    fromTier: ContributorTier;
    toTier: ContributorTier;
  }>;
};

type EnrollResult = {
  enrolledTier: ContributorTier;
  creditAmountUsd: number;
  creditGranted: boolean;
};

function getContributorTierSuggestion(input: {
  contributionsAllTime: number;
  contributions90d: number;
}): ContributorTier | null {
  if (input.contributionsAllTime >= 15) return CONTRIBUTOR_TIERS.champion;
  if (input.contributions90d >= 5) return CONTRIBUTOR_TIERS.ambassador;
  if (input.contributions90d >= 1) return CONTRIBUTOR_TIERS.contributor;
  return null;
}

function parseContributorTier(value: string | null): ContributorTier | null {
  if (value === null) return null;
  const result = CONTRIBUTOR_TIER_SCHEMA.safeParse(value);
  return result.success ? result.data : null;
}

function getGithubTokenOrThrow(): string {
  if (!GITHUB_ADMIN_STATS_TOKEN) {
    throw new Error(
      'Missing env var GITHUB_ADMIN_STATS_TOKEN; required for contributor champions sync.'
    );
  }
  return GITHUB_ADMIN_STATS_TOKEN;
}

async function githubRequest(url: string): Promise<Response> {
  const token = getGithubTokenOrThrow();
  return fetchWithBackoff(
    url,
    {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
    {
      retryResponse: response => response.status === 429 || response.status >= 500,
      maxDelayMs: 10_000,
    }
  );
}

async function mapWithConcurrencyLimit<T, TResult>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<TResult>
): Promise<TResult[]> {
  if (values.length === 0) return [];

  const results: TResult[] = [];
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= values.length) return;
      const value = values[currentIndex];
      if (value === undefined) return;
      results[currentIndex] = await mapper(value);
    }
  });

  await Promise.all(workers);
  return results;
}

async function getCurrentSyncCheckpoint(): Promise<string | null> {
  const row = await db.query.contributor_champion_sync_state.findFirst({
    where: eq(contributor_champion_sync_state.repo_full_name, REPO_FULL_NAME),
    columns: {
      last_merged_at: true,
    },
  });
  return row?.last_merged_at ?? null;
}

async function listMergedPullRequestsSince(options: {
  checkpointMergedAt: string | null;
  maxPages: number;
}): Promise<MergedPullRequest[]> {
  const fromDate = options.checkpointMergedAt
    ? options.checkpointMergedAt.slice(0, 10)
    : '2000-01-01';
  const toDate = new Date().toISOString().slice(0, 10);

  const merged: MergedPullRequest[] = [];
  const perPage = 100;

  for (let page = 1; page <= options.maxPages; page += 1) {
    const url = new URL('https://api.github.com/search/issues');
    url.searchParams.set(
      'q',
      `repo:${REPO_OWNER}/${REPO_NAME} is:pr is:merged merged:${fromDate}..${toDate}`
    );
    url.searchParams.set('sort', 'updated');
    url.searchParams.set('direction', 'desc');
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));

    const response = await githubRequest(url.toString());
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`GitHub search PRs failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`);
    }

    const searchResult = SEARCH_PULL_REQUEST_LIST_SCHEMA.parse(await response.json());

    for (const pullRequest of searchResult.items) {
      const mergedAt = pullRequest.pull_request?.merged_at ?? null;
      if (!mergedAt || !pullRequest.user) continue;
      if (pullRequest.user.type === 'Bot') continue;

      const authorLogin = pullRequest.user.login;
      if (TEAM_LOGIN_SET.has(authorLogin.toLowerCase())) continue;

      if (options.checkpointMergedAt && mergedAt <= options.checkpointMergedAt) {
        continue;
      }

      merged.push({
        number: pullRequest.number,
        title: pullRequest.title,
        url: pullRequest.html_url,
        authorLogin,
        authorGithubUserId: pullRequest.user.id ?? null,
        authorProfileUrl: pullRequest.user.html_url ?? `https://github.com/${authorLogin}`,
        mergedAt,
      });
    }

    if (searchResult.items.length < perPage) break;
  }

  return merged;
}

async function getPullRequestAuthorEmail(options: {
  pullRequestNumber: number;
  authorLogin: string;
}): Promise<string | null> {
  const url = new URL(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${options.pullRequestNumber}/commits`
  );
  url.searchParams.set('per_page', '250');

  const response = await githubRequest(url.toString());
  if (!response.ok) {
    return null;
  }

  const commits = PULL_REQUEST_COMMITS_SCHEMA.parse(await response.json());
  const authorLoginLower = options.authorLogin.toLowerCase();

  for (const commit of commits) {
    const commitAuthorLogin = commit.author?.login;
    const commitEmail = commit.commit.author?.email;
    if (!commitAuthorLogin || !commitEmail) continue;
    if (commitAuthorLogin.toLowerCase() === authorLoginLower) {
      return commitEmail.toLowerCase();
    }
  }

  for (const commit of commits) {
    const commitEmail = commit.commit.author?.email;
    if (commitEmail) {
      return commitEmail.toLowerCase();
    }
  }

  return null;
}

export async function syncContributorChampionData(): Promise<SyncSummary> {
  const startedAt = new Date().toISOString();
  const checkpointMergedAt = await getCurrentSyncCheckpoint();

  const mergedPullRequests = await listMergedPullRequestsSince({
    checkpointMergedAt,
    maxPages: 10,
  });

  if (mergedPullRequests.length === 0) {
    await db
      .insert(contributor_champion_sync_state)
      .values({
        repo_full_name: REPO_FULL_NAME,
        last_merged_at: checkpointMergedAt,
        last_synced_at: startedAt,
      })
      .onConflictDoUpdate({
        target: contributor_champion_sync_state.repo_full_name,
        set: {
          last_synced_at: startedAt,
          updated_at: sql`now()`,
        },
      });

    return {
      repoFullName: REPO_FULL_NAME,
      fetchedMergedPullRequests: 0,
      insertedContributionEvents: 0,
      upsertedContributors: 0,
      checkpointMergedAt,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const pullRequestsWithEmail = await mapWithConcurrencyLimit(mergedPullRequests, 4, async pullRequest => {
    const email = await getPullRequestAuthorEmail({
      pullRequestNumber: pullRequest.number,
      authorLogin: pullRequest.authorLogin,
    });
    return {
      ...pullRequest,
      authorEmail: email,
    };
  });

  let insertedContributionEvents = 0;
  let upsertedContributors = 0;

  await db.transaction(async tx => {
    const normalizedTeamLogins = Array.from(TEAM_LOGIN_SET);
    if (normalizedTeamLogins.length > 0) {
      await tx.execute(sql`
        DELETE FROM contributor_champion_contributors
        WHERE lower(github_login) IN (${sql.join(
          normalizedTeamLogins.map(login => sql`${login}`),
          sql`, `
        )})
      `);
    }

    for (const pullRequest of pullRequestsWithEmail) {
      if (isTeamEmail(pullRequest.authorEmail)) continue;

      const contributorRows = await tx
        .insert(contributor_champion_contributors)
        .values({
          github_login: pullRequest.authorLogin,
          github_profile_url: pullRequest.authorProfileUrl,
          github_user_id: pullRequest.authorGithubUserId,
        })
        .onConflictDoUpdate({
          target: contributor_champion_contributors.github_login,
          set: {
            github_profile_url: pullRequest.authorProfileUrl,
            github_user_id: pullRequest.authorGithubUserId,
            updated_at: sql`now()`,
          },
        })
        .returning({
          id: contributor_champion_contributors.id,
        });

      const contributorId = contributorRows[0]?.id;
      if (!contributorId) continue;
      upsertedContributors += 1;

      const insertedRows = await tx
        .insert(contributor_champion_events)
        .values({
          contributor_id: contributorId,
          repo_full_name: REPO_FULL_NAME,
          github_pr_number: pullRequest.number,
          github_pr_url: pullRequest.url,
          github_pr_title: pullRequest.title,
          github_author_login: pullRequest.authorLogin,
          github_author_email: pullRequest.authorEmail,
          merged_at: pullRequest.mergedAt,
        })
        .onConflictDoNothing()
        .returning({
          id: contributor_champion_events.id,
        });

      if (insertedRows.length > 0) {
        insertedContributionEvents += 1;
      }
    }

    await tx.execute(sql`
      UPDATE contributor_champion_contributors AS c
      SET
        all_time_contributions = stats.contribution_count,
        first_contribution_at = stats.first_merged_at,
        last_contribution_at = stats.last_merged_at,
        updated_at = now()
      FROM (
        SELECT
          contributor_id,
          count(*)::int AS contribution_count,
          min(merged_at) AS first_merged_at,
          max(merged_at) AS last_merged_at
        FROM contributor_champion_events
        GROUP BY contributor_id
      ) AS stats
      WHERE c.id = stats.contributor_id
    `);

    const maxMergedAt = pullRequestsWithEmail
      .map(pullRequest => pullRequest.mergedAt)
      .sort((left, right) => (left > right ? -1 : left < right ? 1 : 0))[0];

    await tx
      .insert(contributor_champion_sync_state)
      .values({
        repo_full_name: REPO_FULL_NAME,
        last_merged_at: maxMergedAt ?? checkpointMergedAt,
        last_synced_at: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: contributor_champion_sync_state.repo_full_name,
        set: {
          last_merged_at: maxMergedAt ?? checkpointMergedAt,
          last_synced_at: new Date().toISOString(),
          updated_at: sql`now()`,
        },
      });
  });

  return {
    repoFullName: REPO_FULL_NAME,
    fetchedMergedPullRequests: mergedPullRequests.length,
    insertedContributionEvents,
    upsertedContributors,
    checkpointMergedAt,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

export async function getContributorChampionLeaderboard(): Promise<LeaderboardRow[]> {
  const rows = await db.execute<{
    contributor_id: string;
    github_login: string;
    github_profile_url: string;
    email: string | null;
    linked_user_id: string | null;
    linked_user_name: string | null;
    linked_user_image_url: string | null;
    contributions_all_time: number;
    contributions_30d: number;
    contributions_90d: number;
    selected_tier: string | null;
    enrolled_tier: string | null;
    enrolled_at: string | null;
    credit_amount_microdollars: number | null;
    credits_last_granted_at: string | null;
    membership_linked_kilo_user_id: string | null;
  }>(sql`
    WITH last_email AS (
      SELECT DISTINCT ON (contributor_id)
        contributor_id,
        github_author_email
      FROM contributor_champion_events
      WHERE github_author_email IS NOT NULL
      ORDER BY contributor_id, merged_at DESC
    ),
    counts_30d AS (
      SELECT contributor_id, count(*)::int AS contribution_count
      FROM contributor_champion_events
      WHERE merged_at >= now() - interval '30 days'
      GROUP BY contributor_id
    ),
    counts_90d AS (
      SELECT contributor_id, count(*)::int AS contribution_count
      FROM contributor_champion_events
      WHERE merged_at >= now() - interval '90 days'
      GROUP BY contributor_id
    )
    SELECT
      c.id AS contributor_id,
      c.github_login,
      c.github_profile_url,
      COALESCE(le.github_author_email, c.manual_email) AS email,
      COALESCE(u.id, mu.id) AS linked_user_id,
      COALESCE(u.google_user_name, mu.google_user_name) AS linked_user_name,
      COALESCE(u.google_user_image_url, mu.google_user_image_url) AS linked_user_image_url,
      c.all_time_contributions AS contributions_all_time,
      COALESCE(c30.contribution_count, 0) AS contributions_30d,
      COALESCE(c90.contribution_count, 0) AS contributions_90d,
      m.selected_tier,
      m.enrolled_tier,
      m.enrolled_at,
      m.credit_amount_microdollars,
      m.credits_last_granted_at,
      m.linked_kilo_user_id AS membership_linked_kilo_user_id
    FROM contributor_champion_contributors c
    LEFT JOIN last_email le ON le.contributor_id = c.id
    LEFT JOIN kilocode_users u ON lower(u.google_user_email) = lower(le.github_author_email)
    LEFT JOIN counts_30d c30 ON c30.contributor_id = c.id
    LEFT JOIN counts_90d c90 ON c90.contributor_id = c.id
    LEFT JOIN contributor_champion_memberships m ON m.contributor_id = c.id
    LEFT JOIN kilocode_users mu ON mu.id = m.linked_kilo_user_id
    ORDER BY
      COALESCE(c30.contribution_count, 0) DESC,
      c.all_time_contributions DESC,
      c.github_login ASC
  `);

  return rows.rows
    .filter(row => !isTeamEmail(row.email))
    .map(row => {
      const suggestedTier = getContributorTierSuggestion({
        contributionsAllTime: row.contributions_all_time,
        contributions90d: row.contributions_90d,
      });

      const creditMicrodollars = Number(row.credit_amount_microdollars ?? 0);

      return {
        contributorId: row.contributor_id,
        githubLogin: row.github_login,
        githubProfileUrl: row.github_profile_url,
        email: row.email,
        linkedUserId: row.linked_user_id,
        linkedUserName: row.linked_user_name,
        linkedUserImageUrl: row.linked_user_image_url,
        contributionsAllTime: row.contributions_all_time,
        contributions30d: row.contributions_30d,
        contributions90d: row.contributions_90d,
        suggestedTier,
        selectedTier: parseContributorTier(row.selected_tier),
        enrolledTier: parseContributorTier(row.enrolled_tier),
        enrolledAt: row.enrolled_at,
        creditAmountUsd: creditMicrodollars > 0 ? fromMicrodollars(creditMicrodollars) : null,
        creditsLastGrantedAt: row.credits_last_granted_at,
        linkedKiloUserId: row.membership_linked_kilo_user_id,
      };
    });
}

export async function getContributorContributionDrillIn(input: {
  contributorId: string;
  window: DrillInWindow;
}): Promise<ContributionDrillInRow[]> {
  const whereClauses = [eq(contributor_champion_events.contributor_id, input.contributorId)];

  if (input.window === 'rolling_30_days') {
    whereClauses.push(gte(contributor_champion_events.merged_at, sql`now() - interval '30 days'`));
  }

  const rows = await db
    .select({
      eventId: contributor_champion_events.id,
      repoFullName: contributor_champion_events.repo_full_name,
      githubPrNumber: contributor_champion_events.github_pr_number,
      githubPrUrl: contributor_champion_events.github_pr_url,
      githubPrTitle: contributor_champion_events.github_pr_title,
      githubAuthorLogin: contributor_champion_events.github_author_login,
      githubAuthorEmail: contributor_champion_events.github_author_email,
      mergedAt: contributor_champion_events.merged_at,
    })
    .from(contributor_champion_events)
    .where(and(...whereClauses))
    .orderBy(sql`${contributor_champion_events.merged_at} DESC`);

  return rows;
}

export async function upsertContributorSelectedTier(input: {
  contributorId: string;
  selectedTier: ContributorTier;
}): Promise<void> {
  await db
    .insert(contributor_champion_memberships)
    .values({
      contributor_id: input.contributorId,
      selected_tier: input.selectedTier,
    })
    .onConflictDoUpdate({
      target: contributor_champion_memberships.contributor_id,
      set: {
        selected_tier: input.selectedTier,
        updated_at: sql`now()`,
      },
    });
}

export async function getContributorChampionReviewQueue(): Promise<LeaderboardRow[]> {
  const leaderboard = await getContributorChampionLeaderboard();
  return leaderboard.filter(
    row => row.enrolledTier === null && row.enrolledAt === null && row.contributionsAllTime > 0
  );
}

async function grantContributorChampionCredits(
  user: User,
  amountUsd: number
): Promise<boolean> {
  if (amountUsd <= 0) return false;

  const result = await grantCreditForCategory(user, {
    credit_category: 'contributor-champion-credits',
    amount_usd: amountUsd,
    expiry_hours: CREDIT_EXPIRY_HOURS,
    counts_as_selfservice: false,
  });

  return result.success;
}

export async function enrollContributorChampion(input: {
  contributorId: string;
  tier: ContributorTier | null;
}): Promise<EnrollResult> {
  const leaderboard = await getContributorChampionLeaderboard();
  const row = leaderboard.find(value => value.contributorId === input.contributorId);
  if (!row) {
    throw new Error('Contributor not found');
  }

  const resolvedTier = input.tier ?? row.selectedTier ?? row.suggestedTier;
  if (!resolvedTier) {
    throw new Error('No selected tier available for enrollment');
  }

  const creditAmountUsd = TIER_CREDIT_USD[resolvedTier];
  const creditAmountMicrodollars = toMicrodollars(creditAmountUsd);
  const linkedKiloUserId = row.linkedUserId;

  const now = new Date().toISOString();

  // Upsert membership first, then grant credits to avoid double-grant on concurrent requests
  await db
    .insert(contributor_champion_memberships)
    .values({
      contributor_id: input.contributorId,
      selected_tier: row.selectedTier ?? resolvedTier,
      enrolled_tier: resolvedTier,
      enrolled_at: now,
      credit_amount_microdollars: creditAmountMicrodollars,
      linked_kilo_user_id: linkedKiloUserId,
    })
    .onConflictDoUpdate({
      target: contributor_champion_memberships.contributor_id,
      set: {
        selected_tier: row.selectedTier ?? resolvedTier,
        enrolled_tier: resolvedTier,
        enrolled_at: now,
        credit_amount_microdollars: creditAmountMicrodollars,
        linked_kilo_user_id: linkedKiloUserId,
        updated_at: sql`now()`,
      },
    });

  // Grant credits after membership is persisted
  let creditGranted = false;
  if (creditAmountUsd > 0 && linkedKiloUserId) {
    const [linkedUser] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, linkedKiloUserId))
      .limit(1);

    if (linkedUser) {
      creditGranted = await grantContributorChampionCredits(linkedUser, creditAmountUsd);
    }
  }

  // Update credits_last_granted_at only after successful grant
  if (creditGranted) {
    await db
      .update(contributor_champion_memberships)
      .set({ credits_last_granted_at: now })
      .where(eq(contributor_champion_memberships.contributor_id, input.contributorId));
  }

  return {
    enrolledTier: resolvedTier,
    creditAmountUsd,
    creditGranted,
  };
}

export async function getEnrolledContributorChampions(): Promise<LeaderboardRow[]> {
  const leaderboard = await getContributorChampionLeaderboard();
  return leaderboard.filter(row => row.enrolledTier !== null || row.enrolledAt !== null);
}

export async function refreshContributorChampionCredits(): Promise<CreditRefreshSummary> {
  const summary: CreditRefreshSummary = {
    processed: 0,
    granted: 0,
    skippedNoUser: 0,
    errored: 0,
  };

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Query all enrolled memberships eligible for credit refresh
  // Use FOR UPDATE SKIP LOCKED to prevent double-grants from concurrent cron runs
  const eligibleRows = await db.execute<{
    id: string;
    contributor_id: string;
    credit_amount_microdollars: bigint;
    linked_kilo_user_id: string | null;
  }>(sql`
    SELECT id, contributor_id, credit_amount_microdollars, linked_kilo_user_id
    FROM contributor_champion_memberships
    WHERE enrolled_tier IS NOT NULL
      AND credit_amount_microdollars > 0
      AND linked_kilo_user_id IS NOT NULL
      AND (credits_last_granted_at IS NULL OR credits_last_granted_at <= ${thirtyDaysAgo})
    FOR UPDATE SKIP LOCKED
  `).then(result => result.rows);

  for (const row of eligibleRows) {
    summary.processed += 1;

    if (!row.linked_kilo_user_id) {
      summary.skippedNoUser += 1;
      continue;
    }

    try {
      const [linkedUser] = await db
        .select()
        .from(kilocode_users)
        .where(eq(kilocode_users.id, row.linked_kilo_user_id))
        .limit(1);

      if (!linkedUser) {
        summary.skippedNoUser += 1;
        continue;
      }

      const amountUsd = fromMicrodollars(Number(row.credit_amount_microdollars));
      const granted = await grantContributorChampionCredits(linkedUser, amountUsd);

      if (granted) {
        await db
          .update(contributor_champion_memberships)
          .set({
            credits_last_granted_at: new Date().toISOString(),
            updated_at: sql`now()`,
          })
          .where(eq(contributor_champion_memberships.id, row.id));

        summary.granted += 1;
      } else {
        summary.errored += 1;
      }
    } catch (error) {
      captureException(error, {
        tags: { source: 'contributor_champion_credit_refresh' },
        extra: { membershipId: row.id, contributorId: row.contributor_id },
      });
      summary.errored += 1;
    }
  }

  return summary;
}

export async function processAutoTierUpgrades(): Promise<AutoUpgradeSummary> {
  const summary: AutoUpgradeSummary = {
    processed: 0,
    upgraded: 0,
    upgrades: [],
  };

  // Query all enrolled contributors with their PR counts
  const enrolledRows = await db
    .select({
      membershipId: contributor_champion_memberships.id,
      contributorId: contributor_champion_memberships.contributor_id,
      enrolledTier: contributor_champion_memberships.enrolled_tier,
      githubLogin: contributor_champion_contributors.github_login,
      allTimeContributions: contributor_champion_contributors.all_time_contributions,
    })
    .from(contributor_champion_memberships)
    .innerJoin(
      contributor_champion_contributors,
      eq(
        contributor_champion_memberships.contributor_id,
        contributor_champion_contributors.id
      )
    )
    .where(isNotNull(contributor_champion_memberships.enrolled_tier));

  for (const row of enrolledRows) {
    summary.processed += 1;

    const currentTier = parseContributorTier(row.enrolledTier);
    if (!currentTier) continue;

    let newTier: ContributorTier | null = null;

    // Auto-upgrade uses all-time PR count (not 90-day rolling window).
    // This intentionally differs from getContributorTierSuggestion() which uses 90d.
    if (row.allTimeContributions >= 15 && currentTier !== 'champion') {
      newTier = 'champion';
    } else if (
      row.allTimeContributions >= 5 &&
      currentTier === 'contributor'
    ) {
      newTier = 'ambassador';
    }

    if (!newTier) continue;

    const newCreditAmountMicrodollars = toMicrodollars(TIER_CREDIT_USD[newTier]);

    await db
      .update(contributor_champion_memberships)
      .set({
        enrolled_tier: newTier,
        credit_amount_microdollars: newCreditAmountMicrodollars,
        updated_at: sql`now()`,
      })
      .where(eq(contributor_champion_memberships.id, row.membershipId));

    summary.upgraded += 1;
    summary.upgrades.push({
      contributorId: row.contributorId,
      githubLogin: row.githubLogin,
      fromTier: currentTier,
      toTier: newTier,
    });
  }

  return summary;
}

export async function getContributorChampionProfileBadgeForUser(input: {
  userId: string;
}): Promise<ContributorChampionProfileBadge | null> {
  const rows = await db.execute<{
    enrolled_tier: string;
    enrolled_at: string;
  }>(sql`
    WITH matched_contributors AS (
      SELECT DISTINCT e.contributor_id
      FROM contributor_champion_events e
      INNER JOIN kilocode_users u ON lower(u.google_user_email) = lower(e.github_author_email)
      WHERE u.id = ${input.userId}
      UNION
      SELECT m.contributor_id
      FROM contributor_champion_memberships m
      WHERE m.linked_kilo_user_id = ${input.userId}
    )
    SELECT m.enrolled_tier, m.enrolled_at
    FROM contributor_champion_memberships m
    INNER JOIN matched_contributors mc ON mc.contributor_id = m.contributor_id
    WHERE m.enrolled_tier IS NOT NULL AND m.enrolled_at IS NOT NULL
    ORDER BY m.enrolled_at DESC
    LIMIT 1
  `);

  const row = rows.rows[0];
  if (!row) return null;

  const tier = parseContributorTier(row.enrolled_tier);
  if (!tier) return null;

  return {
    tier,
    enrolledAt: row.enrolled_at,
  };
}

export { TIER_CREDIT_USD };

type KiloUserSearchResult = {
  userId: string;
  email: string;
  name: string | null;
};

export async function searchKiloUsersByEmail(query: string): Promise<KiloUserSearchResult[]> {
  if (!query || query.length < 2) return [];

  const rows = await db.execute<{
    id: string;
    google_user_email: string;
    google_user_name: string | null;
  }>(sql`
    SELECT id, google_user_email, google_user_name
    FROM kilocode_users
    WHERE lower(google_user_email) LIKE ${`%${query.toLowerCase().replace(/[%_]/g, '\\$&')}%`}
    ORDER BY google_user_email ASC
    LIMIT 10
  `);

  return rows.rows.map(row => ({
    userId: row.id,
    email: row.google_user_email,
    name: row.google_user_name,
  }));
}

export async function manualEnrollContributor(input: {
  email: string;
  githubLogin: string | null;
  tier: ContributorTier;
  kiloUserId: string | null;
}): Promise<EnrollResult> {
  const resolvedTier = input.tier;
  const creditAmountUsd = TIER_CREDIT_USD[resolvedTier];
  const creditAmountMicrodollars = toMicrodollars(creditAmountUsd);

  // Create or find contributor record
  const githubLogin = input.githubLogin ?? `manual-${input.email.replace('@', '-at-').replace(/\./g, '-')}`;
  const githubProfileUrl = input.githubLogin
    ? `https://github.com/${input.githubLogin}`
    : '#';

  const contributorRows = await db
    .insert(contributor_champion_contributors)
    .values({
      github_login: githubLogin,
      github_profile_url: githubProfileUrl,
      manual_email: input.email,
    })
    .onConflictDoUpdate({
      target: contributor_champion_contributors.github_login,
      set: {
        manual_email: input.email,
        updated_at: sql`now()`,
      },
    })
    .returning({ id: contributor_champion_contributors.id });

  const contributorId = contributorRows[0]?.id;
  if (!contributorId) {
    throw new Error('Failed to create contributor record');
  }

  const now = new Date().toISOString();

  // Create membership (without credits_last_granted_at — set after grant)
  await db
    .insert(contributor_champion_memberships)
    .values({
      contributor_id: contributorId,
      selected_tier: resolvedTier,
      enrolled_tier: resolvedTier,
      enrolled_at: now,
      credit_amount_microdollars: creditAmountMicrodollars,
      linked_kilo_user_id: input.kiloUserId,
    })
    .onConflictDoUpdate({
      target: contributor_champion_memberships.contributor_id,
      set: {
        selected_tier: resolvedTier,
        enrolled_tier: resolvedTier,
        enrolled_at: now,
        credit_amount_microdollars: creditAmountMicrodollars,
        linked_kilo_user_id: input.kiloUserId,
        updated_at: sql`now()`,
      },
    });

  // Grant initial credits if applicable
  let creditGranted = false;
  if (creditAmountUsd > 0 && input.kiloUserId) {
    const kiloUserRow = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, input.kiloUserId))
      .limit(1)
      .then(rows => rows[0]);
    if (kiloUserRow) {
      creditGranted = await grantContributorChampionCredits(kiloUserRow, creditAmountUsd);
    }
  }

  // Update credits_last_granted_at only if credits were actually granted
  if (creditGranted) {
    await db
      .update(contributor_champion_memberships)
      .set({ credits_last_granted_at: now })
      .where(eq(contributor_champion_memberships.contributor_id, contributorId));
  }

  return { enrolledTier: resolvedTier, creditAmountUsd, creditGranted };
}

export type {
  ContributorTier,
  DrillInWindow,
  LeaderboardRow,
  ContributionDrillInRow,
  SyncSummary,
  ContributorChampionProfileBadge,
  CreditRefreshSummary,
  AutoUpgradeSummary,
  EnrollResult,
};
