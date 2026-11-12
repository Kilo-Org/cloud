import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  cli_sessions_v2,
  cloud_agent_worktrees,
  github_branch_pull_requests,
} from '@kilocode/db/schema';
import { GITHUB_ACTION } from '@/lib/integrations/core/constants';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { parseRepoReference } from '@/lib/integrations/platforms/github/pr-link-identity';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import type { PullRequestPayload } from '@/lib/integrations/platforms/github/webhook-schemas';
import type { WebhookInstallationOwner } from './upsert-cli-session-pull-requests';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';
const STACK_FETCH_TIMEOUT_MS = 8_000;
/** Bounded 409 backoff: three retries at 250/500/1000 ms. */
const CONFLICT_RETRY_DELAYS_MS = [250, 500, 1_000] as const;
/** A parent worktree can only have one layer directly above it. */
const MAX_ELIGIBLE_CHILDREN = 8;

const LINK_ACTIONS: ReadonlySet<string> = new Set([
  GITHUB_ACTION.OPENED,
  GITHUB_ACTION.REOPENED,
  GITHUB_ACTION.SYNCHRONIZE,
  GITHUB_ACTION.EDITED,
  GITHUB_ACTION.READY_FOR_REVIEW,
  GITHUB_ACTION.STACKED,
]);

export type StackLinkingParams = {
  payload: PullRequestPayload;
  owner: WebhookInstallationOwner;
  installationId: string | null;
  appType: GitHubAppType;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

type StackPullRequest = {
  number: number;
  baseRef: string | null;
};

type StackApiResult =
  | { kind: 'ok'; data: unknown }
  | { kind: 'missing' }
  | { kind: 'soft'; status: number }
  | { kind: 'error'; error: unknown };

type VerifiedSession = {
  sessionId: string;
  worktreeId: string;
  prNumber: number;
  prHeadRef: string | null;
  gitBranch: string | null;
  kiloUserId: string;
  organizationId: string | null;
};

type CacheRow = {
  prNumber: number | null;
  prState: string | null;
  gitBranch: string;
  prBaseRef: string | null;
  stackNumber: number | null;
  stackPosition: number | null;
  stackSize: number | null;
};

type WorktreeRow = {
  worktreeId: string;
  kiloUserId: string;
  organizationId: string | null;
  parentWorktreeId: string | null;
  baseBranch: string | null;
};

type PairArgs = {
  parentWorktree: WorktreeRow;
  childWorktree: WorktreeRow;
  gitUrl: string;
  repoOwner: string;
  repoName: string;
  owner: WebhookInstallationOwner;
  token: string;
  fetchImpl: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
};

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function tenantSessionPredicate(owner: WebhookInstallationOwner) {
  return owner.kind === 'organization'
    ? eq(cli_sessions_v2.organization_id, owner.organizationId)
    : and(isNull(cli_sessions_v2.organization_id), eq(cli_sessions_v2.kilo_user_id, owner.userId));
}

function tenantCachePredicate(owner: WebhookInstallationOwner) {
  return owner.kind === 'organization'
    ? eq(github_branch_pull_requests.owned_by_organization_id, owner.organizationId)
    : eq(github_branch_pull_requests.owned_by_user_id, owner.userId);
}

function openOrDraft(state: string | null): boolean {
  return state === 'open' || state === 'draft';
}

function normalizedBranch(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function branchesMatch(left: string | null, right: string | null): boolean {
  // Git refs are case-sensitive; a stack link must use the exact ref GitHub
  // reported as the child's base and the parent's head.
  return left !== null && right !== null && left === right;
}

function parseStackData(data: unknown): {
  stackNumber: number | null;
  pullRequests: StackPullRequest[];
} | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const stackNumber =
    typeof record.number === 'number' && Number.isInteger(record.number) ? record.number : null;
  // The Stacks API response names the array `pull_requests`. There is no `size`
  // field to trust: the array length is the stack size.
  const raw = record.pull_requests;
  if (!Array.isArray(raw)) return null;
  const pullRequests: StackPullRequest[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const pr = entry as Record<string, unknown>;
    if (typeof pr.number !== 'number' || !Number.isInteger(pr.number)) return null;
    const base =
      typeof pr.base === 'object' && pr.base !== null ? (pr.base as Record<string, unknown>) : null;
    const baseRef = base && typeof base.ref === 'string' ? base.ref : null;
    pullRequests.push({ number: pr.number, baseRef });
  }
  return { stackNumber, pullRequests };
}

async function callStackApi(args: {
  fetchImpl: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  token: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}): Promise<StackApiResult> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await args.fetchImpl(`${GITHUB_API_BASE}${args.path}`, {
        method: args.method,
        headers: {
          Authorization: `Bearer ${args.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          ...(args.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        signal: AbortSignal.timeout(STACK_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      return { kind: 'error', error };
    }

    if (response.ok) {
      try {
        return { kind: 'ok', data: await response.json() };
      } catch (error) {
        return { kind: 'error', error };
      }
    }
    if (args.method === 'GET' && response.status === 404) return { kind: 'missing' };
    // 422 means the stack cannot be created or extended (already linked, a
    // sibling fork, or a retarget in flight). It is an expected soft no-op.
    if (response.status === 422) return { kind: 'soft', status: 422 };
    if (response.status === 409 && attempt < CONFLICT_RETRY_DELAYS_MS.length) {
      await args.sleep(CONFLICT_RETRY_DELAYS_MS[attempt]);
      continue;
    }
    return { kind: 'soft', status: response.status };
  }
}

async function readCache(
  gitUrl: string,
  prNumber: number,
  owner: WebhookInstallationOwner
): Promise<CacheRow | null> {
  const [row] = await db
    .select({
      prNumber: github_branch_pull_requests.pr_number,
      prState: github_branch_pull_requests.pr_state,
      gitBranch: github_branch_pull_requests.git_branch,
      prBaseRef: github_branch_pull_requests.pr_base_ref,
      stackNumber: github_branch_pull_requests.stack_number,
      stackPosition: github_branch_pull_requests.stack_position,
      stackSize: github_branch_pull_requests.stack_size,
    })
    .from(github_branch_pull_requests)
    .where(
      and(
        eq(github_branch_pull_requests.git_url, gitUrl),
        eq(github_branch_pull_requests.pr_number, prNumber),
        tenantCachePredicate(owner)
      )
    )
    .limit(1);
  return row ?? null;
}

async function readVerifiedSessions(args: {
  worktreeId: string;
  gitUrl: string;
  owner: WebhookInstallationOwner;
}): Promise<VerifiedSession[]> {
  const rows = await db
    .select({
      sessionId: cli_sessions_v2.session_id,
      worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
      prNumber: cli_sessions_v2.pr_number,
      prHeadRef: cli_sessions_v2.pr_head_ref,
      gitBranch: cli_sessions_v2.git_branch,
      kiloUserId: cli_sessions_v2.kilo_user_id,
      organizationId: cli_sessions_v2.organization_id,
    })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.cloud_agent_worktree_id, args.worktreeId),
        eq(cli_sessions_v2.git_url, args.gitUrl),
        isNotNull(cli_sessions_v2.pr_url),
        isNotNull(cli_sessions_v2.pr_number),
        isNotNull(cli_sessions_v2.pr_link_verified_at),
        tenantSessionPredicate(args.owner)
      )
    )
    .orderBy(desc(cli_sessions_v2.updated_at))
    .limit(8);
  return rows.flatMap(row =>
    row.worktreeId !== null && row.prNumber !== null
      ? [
          {
            sessionId: row.sessionId,
            worktreeId: row.worktreeId,
            prNumber: row.prNumber,
            prHeadRef: row.prHeadRef,
            gitBranch: row.gitBranch,
            kiloUserId: row.kiloUserId,
            organizationId: row.organizationId,
          },
        ]
      : []
  );
}

async function readWorktree(
  worktreeId: string,
  owner: WebhookInstallationOwner
): Promise<WorktreeRow | null> {
  const [row] = await db
    .select({
      worktreeId: cloud_agent_worktrees.worktree_id,
      kiloUserId: cloud_agent_worktrees.kilo_user_id,
      organizationId: cloud_agent_worktrees.organization_id,
      parentWorktreeId: cloud_agent_worktrees.parent_worktree_id,
      baseBranch: cloud_agent_worktrees.base_branch,
    })
    .from(cloud_agent_worktrees)
    .where(
      and(
        eq(cloud_agent_worktrees.worktree_id, worktreeId),
        owner.kind === 'organization'
          ? eq(cloud_agent_worktrees.organization_id, owner.organizationId)
          : and(
              isNull(cloud_agent_worktrees.organization_id),
              eq(cloud_agent_worktrees.kilo_user_id, owner.userId)
            ),
        isNull(cloud_agent_worktrees.deletion_started_at),
        isNull(cloud_agent_worktrees.deletion_completed_at)
      )
    )
    .limit(1);
  return row ?? null;
}

async function eligibleChildren(
  parentWorktree: WorktreeRow,
  owner: WebhookInstallationOwner
): Promise<WorktreeRow[]> {
  return db
    .select({
      worktreeId: cloud_agent_worktrees.worktree_id,
      kiloUserId: cloud_agent_worktrees.kilo_user_id,
      organizationId: cloud_agent_worktrees.organization_id,
      parentWorktreeId: cloud_agent_worktrees.parent_worktree_id,
      baseBranch: cloud_agent_worktrees.base_branch,
    })
    .from(cloud_agent_worktrees)
    .where(
      and(
        eq(cloud_agent_worktrees.parent_worktree_id, parentWorktree.worktreeId),
        owner.kind === 'organization'
          ? eq(cloud_agent_worktrees.organization_id, owner.organizationId)
          : and(
              isNull(cloud_agent_worktrees.organization_id),
              eq(cloud_agent_worktrees.kilo_user_id, parentWorktree.kiloUserId)
            ),
        isNull(cloud_agent_worktrees.deletion_started_at),
        isNull(cloud_agent_worktrees.deletion_completed_at)
      )
    )
    .limit(MAX_ELIGIBLE_CHILDREN);
}

async function persistStackMembership(args: {
  gitUrl: string;
  owner: WebhookInstallationOwner;
  stackNumber: number | null;
  fallbackStackNumber: number | null;
  pullRequests: StackPullRequest[];
}): Promise<void> {
  const stackNumber = args.stackNumber ?? args.fallbackStackNumber;
  if (stackNumber === null) return;
  // The array is bottom-to-top and its length is the stack size. Do not read a
  // `size` field from the response.
  const size = args.pullRequests.length;
  for (const [index, pullRequest] of args.pullRequests.entries()) {
    await db
      .update(github_branch_pull_requests)
      .set({
        stack_number: stackNumber,
        stack_position: index + 1,
        stack_size: size,
        ...(pullRequest.baseRef === null ? {} : { pr_base_ref: pullRequest.baseRef }),
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(github_branch_pull_requests.git_url, args.gitUrl),
          eq(github_branch_pull_requests.pr_number, pullRequest.number),
          tenantCachePredicate(args.owner)
        )
      );
  }
}

type PairOutcome = 'linked' | 'skipped' | 'soft';

async function attemptPair(args: PairArgs): Promise<PairOutcome> {
  const childSessions = await readVerifiedSessions({
    worktreeId: args.childWorktree.worktreeId,
    gitUrl: args.gitUrl,
    owner: args.owner,
  });
  if (childSessions.length === 0) return 'skipped';

  const childSession = childSessions[0];
  const childCache = await readCache(args.gitUrl, childSession.prNumber, args.owner);
  if (childCache === null) return 'skipped';
  // Already linked: skip regardless of what the parent cache says. A linked
  // child must never be linked twice.
  if (childCache.stackNumber !== null) return 'skipped';
  if (!openOrDraft(childCache.prState)) return 'skipped';

  const childBaseRef = normalizedBranch(childCache.prBaseRef ?? args.childWorktree.baseBranch);
  if (childBaseRef === null) return 'skipped';

  const parentSessions = await readVerifiedSessions({
    worktreeId: args.parentWorktree.worktreeId,
    gitUrl: args.gitUrl,
    owner: args.owner,
  });
  let parent: { session: VerifiedSession; cache: CacheRow } | null = null;
  for (const session of parentSessions) {
    const cache = await readCache(args.gitUrl, session.prNumber, args.owner);
    if (cache === null || !openOrDraft(cache.prState)) continue;
    // The PR refresh writes the cache branch from the session, so the PR head ref is more exact.
    const parentHeadRef =
      normalizedBranch(session.prHeadRef) ??
      normalizedBranch(cache.gitBranch) ??
      normalizedBranch(session.gitBranch);
    if (branchesMatch(childBaseRef, parentHeadRef)) {
      parent = { session, cache };
      break;
    }
  }
  if (parent === null) return 'skipped';

  const parentPr = parent.cache.prNumber ?? parent.session.prNumber;
  const childPr = childCache.prNumber ?? childSession.prNumber;

  let createStack = false;
  let parentStackNumber = parent.cache.stackNumber;

  if (parentStackNumber !== null) {
    // Cached positions are enough to reject a parent that already has a layer
    // above it (for example a sibling fork). Do not spend a request that would
    // answer 422 on every event.
    if (
      parent.cache.stackPosition !== null &&
      parent.cache.stackSize !== null &&
      parent.cache.stackPosition !== parent.cache.stackSize
    ) {
      return 'skipped';
    }
    const current = await callStackApi({
      fetchImpl: args.fetchImpl,
      sleep: args.sleep,
      token: args.token,
      method: 'GET',
      path: `/repos/${encodeURIComponent(args.repoOwner)}/${encodeURIComponent(
        args.repoName
      )}/stacks/${parentStackNumber}`,
    });
    if (current.kind === 'ok') {
      const parsed = parseStackData(current.data);
      if (parsed === null) return 'soft';
      const index = parsed.pullRequests.findIndex(pr => pr.number === parentPr);
      if (index < 0) return 'skipped';
      // Only the current top of the stack can be extended. A parent that has a
      // layer above it (including a sibling fork's layer) would answer 422 on
      // every event, so do not call the API at all.
      if (index !== parsed.pullRequests.length - 1) return 'skipped';
      parentStackNumber = parsed.stackNumber ?? parentStackNumber;
    } else if (current.kind === 'missing') {
      // The stack was dissolved or the cache is stale: create a fresh one.
      createStack = true;
    } else {
      return 'soft';
    }
  } else {
    createStack = true;
  }

  const path = createStack
    ? `/repos/${encodeURIComponent(args.repoOwner)}/${encodeURIComponent(args.repoName)}/stacks`
    : `/repos/${encodeURIComponent(args.repoOwner)}/${encodeURIComponent(
        args.repoName
      )}/stacks/${parentStackNumber}/add`;
  const pullRequests = createStack ? [parentPr, childPr] : [childPr];

  const result = await callStackApi({
    fetchImpl: args.fetchImpl,
    sleep: args.sleep,
    token: args.token,
    method: 'POST',
    path,
    body: { pull_requests: pullRequests },
  });
  if (result.kind !== 'ok') {
    if (result.kind === 'error') {
      logExceptInTest('stack link: request failed', {
        repo: args.gitUrl,
        parent_pr: parentPr,
        child_pr: childPr,
        operation: createStack ? 'create' : 'add',
        error: result.error instanceof Error ? result.error.message : String(result.error),
      });
      captureException(result.error, {
        tags: { source: 'stack_linking' },
        extra: { repo: args.gitUrl, parentPr, childPr, operation: createStack ? 'create' : 'add' },
      });
    }
    return 'soft';
  }

  const parsed = parseStackData(result.data);
  if (parsed === null) {
    logExceptInTest('stack link: response carried no pull_requests array', {
      repo: args.gitUrl,
      parent_pr: parentPr,
      child_pr: childPr,
      operation: createStack ? 'create' : 'add',
    });
    return 'soft';
  }

  await persistStackMembership({
    gitUrl: args.gitUrl,
    owner: args.owner,
    stackNumber: parsed.stackNumber,
    fallbackStackNumber: parentStackNumber,
    pullRequests: parsed.pullRequests,
  });
  logExceptInTest('stack link: linked', {
    repo: args.gitUrl,
    parent_pr: parentPr,
    child_pr: childPr,
    operation: createStack ? 'create' : 'add',
    stack_number: parsed.stackNumber ?? parentStackNumber,
    stack_size: parsed.pullRequests.length,
  });
  return 'linked';
}

/**
 * Best-effort GitHub stack linking after the PR cache upsert. The cache is the
 * source of truth: only sessions whose link is verified, and worktrees with a
 * recorded `parent_worktree_id`, participate. A failure never fails the
 * webhook; the UI still groups a stack by `parent_worktree_id`.
 */
export async function linkStackedPullRequestsFromWebhook(
  params: StackLinkingParams
): Promise<void> {
  const { payload, owner, installationId, appType } = params;

  if (appType === 'lite') {
    logExceptInTest('stack link: KiloConnect-Lite is read-only, skipping');
    return;
  }
  if (!LINK_ACTIONS.has(payload.action)) return;
  if (installationId === null) return;

  const repo = parseRepoReference(payload.repository.full_name);
  if (repo === null) return;

  try {
    const webhookPr = payload.pull_request.number;
    const [sessionRow] = await db
      .select({
        worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
        prNumber: cli_sessions_v2.pr_number,
      })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.git_url, repo.url),
          eq(cli_sessions_v2.pr_number, webhookPr),
          isNotNull(cli_sessions_v2.pr_url),
          isNotNull(cli_sessions_v2.cloud_agent_worktree_id),
          isNotNull(cli_sessions_v2.pr_link_verified_at),
          tenantSessionPredicate(owner)
        )
      )
      .orderBy(desc(cli_sessions_v2.updated_at))
      .limit(1);
    if (!sessionRow?.worktreeId) return;

    const currentWorktree = await readWorktree(sessionRow.worktreeId, owner);
    if (currentWorktree === null) return;

    const tokenData = await generateGitHubInstallationToken(installationId, appType);
    const fetchImpl = params.fetchImpl ?? fetch;
    const sleep = params.sleep ?? defaultSleep;
    const pairBase = {
      gitUrl: repo.url,
      repoOwner: repo.owner,
      repoName: repo.repo,
      owner,
      token: tokenData.token,
      fetchImpl,
      sleep,
    };

    if (currentWorktree.parentWorktreeId !== null) {
      const parentWorktree = await readWorktree(currentWorktree.parentWorktreeId, owner);
      if (parentWorktree !== null) {
        await attemptPair({
          ...pairBase,
          parentWorktree,
          childWorktree: currentWorktree,
        });
      }
    }

    // A parent PR can become verified after its child's PR already exists. The
    // child then has no event of its own to retry, so check the layers directly
    // above this worktree. Bounded by MAX_ELIGIBLE_CHILDREN, and stop after a
    // successful link because the parent is no longer the stack top.
    const children = await eligibleChildren(currentWorktree, owner);
    for (const childWorktree of children) {
      const outcome = await attemptPair({
        ...pairBase,
        parentWorktree: currentWorktree,
        childWorktree,
      });
      if (outcome === 'linked') break;
    }
  } catch (error) {
    logExceptInTest('stack link: failed', {
      repo: repo.url,
      pr_number: payload.pull_request.number,
      error: error instanceof Error ? error.message : String(error),
    });
    captureException(error, {
      tags: { source: 'stack_linking' },
      extra: {
        repo: repo.url,
        prNumber: payload.pull_request.number,
        ownerKind: owner.kind,
      },
    });
  }
}
