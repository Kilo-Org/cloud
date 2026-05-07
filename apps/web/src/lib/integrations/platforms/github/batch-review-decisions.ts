import 'server-only';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import { github_branch_pull_requests } from '@kilocode/db/schema';
import { fetchBatchedReviewDecisions } from '@/lib/integrations/platforms/github/adapter';
import { getIntegrationForOwner } from '@/lib/integrations/db/platform-integrations';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { logExceptInTest } from '@/lib/utils.server';

export type TenantOwner = {
  userId: string;
  organizationId: string | null;
};

function parseGitHubOwnerRepo(gitUrl: string): { owner: string; repo: string } | null {
  const httpsMatch = gitUrl.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i
  );
  if (httpsMatch?.[1] && httpsMatch[2]) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  const sshMatch = gitUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch?.[1] && sshMatch[2]) return { owner: sshMatch[1], repo: sshMatch[2] };
  return null;
}

type ClaimedRow = {
  git_url: string;
  git_branch: string;
  pr_number: number | null;
  owned_by_organization_id: string | null;
  owned_by_user_id: string | null;
  review_decision_fetching_at: string | null;
};

async function claimPendingReviewRows(owner: TenantOwner): Promise<ClaimedRow[]> {
  const tenantPredicate =
    owner.organizationId !== null
      ? and(
          eq(github_branch_pull_requests.owned_by_organization_id, owner.organizationId),
          isNull(github_branch_pull_requests.owned_by_user_id)
        )
      : and(
          isNull(github_branch_pull_requests.owned_by_organization_id),
          eq(github_branch_pull_requests.owned_by_user_id, owner.userId)
        );

  return db
    .update(github_branch_pull_requests)
    .set({ review_decision_fetching_at: sql`now()` })
    .where(
      and(
        eq(github_branch_pull_requests.review_decision_pending, true),
        or(
          isNull(github_branch_pull_requests.review_decision_fetching_at),
          sql`${github_branch_pull_requests.review_decision_fetching_at} < now() - interval '2 minutes'`
        ),
        tenantPredicate
      )
    )
    .returning({
      git_url: github_branch_pull_requests.git_url,
      git_branch: github_branch_pull_requests.git_branch,
      pr_number: github_branch_pull_requests.pr_number,
      owned_by_organization_id: github_branch_pull_requests.owned_by_organization_id,
      owned_by_user_id: github_branch_pull_requests.owned_by_user_id,
      review_decision_fetching_at: github_branch_pull_requests.review_decision_fetching_at,
    });
}

type FlushedRow = {
  git_url: string;
  git_branch: string;
  owned_by_organization_id: string | null;
  owned_by_user_id: string | null;
  fetching_at: string;
  decision: string | null;
};

function tenantPredicateForOwner(
  organizationId: string | null,
  userId: string | null
): ReturnType<typeof and> {
  if (organizationId !== null) {
    return and(
      eq(github_branch_pull_requests.owned_by_organization_id, organizationId),
      isNull(github_branch_pull_requests.owned_by_user_id)
    );
  }
  if (userId !== null) {
    return and(
      isNull(github_branch_pull_requests.owned_by_organization_id),
      eq(github_branch_pull_requests.owned_by_user_id, userId)
    );
  }
  // The github_branch_pull_requests_owner_check CHECK constraint guarantees
  // exactly one of these is non-null; reaching here means a row violated it.
  throw new Error('github_branch_pull_requests row has neither org nor user owner');
}

async function flushBatchResults(results: FlushedRow[]): Promise<void> {
  if (results.length === 0) return;

  await db.transaction(async tx => {
    for (const row of results) {
      const tenantPredicate = tenantPredicateForOwner(
        row.owned_by_organization_id,
        row.owned_by_user_id
      );

      await tx
        .update(github_branch_pull_requests)
        .set({
          pr_review_decision: row.decision,
          review_decision_pending: false,
          review_decision_fetching_at: null,
          pr_last_synced_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(github_branch_pull_requests.git_url, row.git_url),
            eq(github_branch_pull_requests.git_branch, row.git_branch),
            tenantPredicate,
            // TOCTOU guard: only clear the flag if we still hold the claim.
            // A concurrent webhook that re-set review_decision_pending=true will
            // have bumped review_decision_fetching_at via a new claim, so this
            // WHERE won't match and the flag stays true for the next batch.
            eq(github_branch_pull_requests.review_decision_fetching_at, row.fetching_at)
          )
        );
    }
  });
}

type AbandonedRow = {
  git_url: string;
  git_branch: string;
  owned_by_organization_id: string | null;
  owned_by_user_id: string | null;
  fetching_at: string;
};

/**
 * Clear `review_decision_pending` for claimed rows that the batch can't act on
 * (no GitHub integration, no parseable owner/repo, no pr_number). Without this,
 * those rows would stay flagged and clients polling on `reviewDecisionPending`
 * would never see the flag clear. `pr_review_decision` is left untouched so any
 * earlier value is preserved; the UI will still reflect "no review decision"
 * if it was already null.
 */
async function abandonClaimedRows(rows: AbandonedRow[]): Promise<void> {
  if (rows.length === 0) return;

  await db.transaction(async tx => {
    for (const row of rows) {
      const tenantPredicate = tenantPredicateForOwner(
        row.owned_by_organization_id,
        row.owned_by_user_id
      );

      await tx
        .update(github_branch_pull_requests)
        .set({
          review_decision_pending: false,
          review_decision_fetching_at: null,
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(github_branch_pull_requests.git_url, row.git_url),
            eq(github_branch_pull_requests.git_branch, row.git_branch),
            tenantPredicate,
            // Same TOCTOU guard as flushBatchResults: a concurrent webhook
            // that re-flagged the row will have a different fetching_at,
            // so we leave it pending for the next batch.
            eq(github_branch_pull_requests.review_decision_fetching_at, row.fetching_at)
          )
        );
    }
  });
}

function abandonRowsFromClaimed(rows: ClaimedRow[]): AbandonedRow[] {
  const out: AbandonedRow[] = [];
  for (const row of rows) {
    if (!row.review_decision_fetching_at) continue;
    out.push({
      git_url: row.git_url,
      git_branch: row.git_branch,
      owned_by_organization_id: row.owned_by_organization_id,
      owned_by_user_id: row.owned_by_user_id,
      fetching_at: row.review_decision_fetching_at,
    });
  }
  return out;
}

export async function executeBatchReviewDecisionFetch(owner: TenantOwner): Promise<void> {
  let claimed: ClaimedRow[];
  try {
    claimed = await claimPendingReviewRows(owner);
  } catch (error) {
    captureException(error, { tags: { source: 'batch_review_decision_claim' } });
    return;
  }

  if (claimed.length === 0) return;

  let integration: {
    platform_installation_id: string | null;
    github_app_type: string | null;
  } | null;
  try {
    integration = await getIntegrationForOwner(
      owner.organizationId !== null
        ? { type: 'org', id: owner.organizationId }
        : { type: 'user', id: owner.userId },
      PLATFORM.GITHUB
    );
  } catch (error) {
    captureException(error, { tags: { source: 'batch_review_decision_get_integration' } });
    return;
  }

  if (!integration?.platform_installation_id) {
    logExceptInTest('batch review decision: no GitHub integration, abandoning claimed rows', {
      userId: owner.userId,
      organizationId: owner.organizationId,
      claimedCount: claimed.length,
    });
    try {
      await abandonClaimedRows(abandonRowsFromClaimed(claimed));
    } catch (error) {
      captureException(error, { tags: { source: 'batch_review_decision_abandon_no_integration' } });
    }
    return;
  }

  const installationId = integration.platform_installation_id;
  const appType = (integration.github_app_type as 'standard' | 'lite' | null) ?? 'standard';

  type BatchEntry = {
    alias: string;
    owner: string;
    repo: string;
    number: number;
    row: ClaimedRow;
  };

  const batchEntries: BatchEntry[] = [];
  const unactionableRows: ClaimedRow[] = [];
  for (let i = 0; i < claimed.length; i++) {
    const row = claimed[i];
    const parsed = row.git_url ? parseGitHubOwnerRepo(row.git_url) : null;
    if (!row.pr_number || !parsed) {
      // Sentinel rows (no pr_number) and rows with unparseable git URLs can't
      // be batched — clear their pending flag so the client stops polling.
      unactionableRows.push(row);
      continue;
    }
    batchEntries.push({
      alias: `pr${i}`,
      owner: parsed.owner,
      repo: parsed.repo,
      number: row.pr_number,
      row,
    });
  }

  if (unactionableRows.length > 0) {
    try {
      await abandonClaimedRows(abandonRowsFromClaimed(unactionableRows));
    } catch (error) {
      captureException(error, { tags: { source: 'batch_review_decision_abandon_unactionable' } });
    }
  }

  if (batchEntries.length === 0) return;

  let decisions: Map<string, string | null>;
  try {
    decisions = await fetchBatchedReviewDecisions({
      installationId,
      prs: batchEntries.map(({ alias, owner, repo, number }) => ({
        alias,
        owner,
        repo,
        number,
      })),
      appType,
    });
  } catch (error) {
    captureException(error, { tags: { source: 'batch_review_decision_graphql' } });
    return;
  }

  const toFlush: FlushedRow[] = [];
  for (const { alias, row } of batchEntries) {
    // claimPendingReviewRows always sets review_decision_fetching_at to now();
    // skip the row if a concurrent writer somehow cleared it.
    if (!row.review_decision_fetching_at) continue;
    toFlush.push({
      git_url: row.git_url,
      git_branch: row.git_branch,
      owned_by_organization_id: row.owned_by_organization_id,
      owned_by_user_id: row.owned_by_user_id,
      fetching_at: row.review_decision_fetching_at,
      decision: decisions.get(alias) ?? null,
    });
  }

  try {
    await flushBatchResults(toFlush);
  } catch (error) {
    captureException(error, { tags: { source: 'batch_review_decision_flush' } });
  }
}

export function triggerBatchReviewDecisionFetchIfNeeded(
  hasPendingRows: boolean,
  owner: TenantOwner
): void {
  if (!hasPendingRows) return;
  executeBatchReviewDecisionFetch(owner).catch(captureException);
}
