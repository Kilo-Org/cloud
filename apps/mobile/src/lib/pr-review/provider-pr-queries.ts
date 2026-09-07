/* eslint-disable max-lines -- the seam owns the one provider→GitHub read-model mapping and every query builder; splitting it would scatter the seam across callers. */
// The ONE data seam of the provider-aware PR review surface.
//
// Every read the review screens make goes through a builder here. Given a
// `ProviderPrRef` the builder picks the tRPC namespace — `githubPrReview`
// for GitHub (the exact procedures, inputs and DTOs the tree already used,
// so that surface cannot regress) and `providerReview` for GitLab and
// Bitbucket — and normalizes the provider answer into the same read models
// the screens already render. Nothing downstream of this module knows which
// provider it is showing except through `capabilities`.
//
// The scope (ref + organization) travels in React context rather than as a
// prop through every child: the diff list, the file navigator and the
// discussion list live outside this slice, and they already pass the
// GitHub-shaped `owner`/`repo`/`number` triple to the hooks below. Reading
// the real ref from context keeps those components untouched while their
// queries move to the right provider.

import {
  type ProviderPrChecksResult,
  type ProviderPrSummary,
  type ProviderPrThread,
  type ProviderReviewCapabilities,
} from '@kilocode/app-shared/provider-review';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useMemo } from 'react';

import {
  isProviderScopeReady,
  providerPrCapabilities,
  type ProviderPrPlatform,
  providerPrRefKey,
  providerPrRepoPath,
  type ProviderPrScope,
  providerPrTriple,
  type ProviderPrTriple,
  useProviderPrScope,
} from '@/lib/pr-review/provider-pr-ref';
import { useTRPC } from '@/lib/trpc';

type Trpc = ReturnType<typeof useTRPC>;
type RouterOutputs = inferRouterOutputs<MobileRouter>;

/** The read models the screens render. GitHub's DTOs are the shared shape. */
type GitHubOverviewDto = RouterOutputs['githubPrReview']['getPullRequest'];

/**
 * GitHub's overview DTO with the commit count widened to `number | null`.
 * No provider read layer reports a commit count, and a chip reading
 * "0 commits" states a wrong fact rather than an absent one, so the count is
 * omitted on those providers and the chip is not drawn.
 */
type PrOverviewCounts = Omit<GitHubOverviewDto['counts'], 'commits'> & { commits: number | null };
export type PrOverviewModel = Omit<GitHubOverviewDto, 'counts'> & { counts: PrOverviewCounts };
export type PrChecksModel = RouterOutputs['githubPrReview']['listChecks'];
export type PrThreadsPageModel = RouterOutputs['githubPrReview']['listReviewThreads'];

/** The provider-discriminated identity every `providerReview` input carries. */
function providerIdentity(scope: ProviderPrScope) {
  const { ref, organizationId } = scope;
  if (ref.platform === 'gitlab') {
    return {
      platform: 'gitlab' as const,
      projectPath: ref.projectPath,
      mrIid: ref.mrIid,
      ...(ref.instanceHint ? { instanceHint: ref.instanceHint } : {}),
      ...(organizationId ? { organizationId } : {}),
    };
  }
  return {
    platform: 'bitbucket' as const,
    workspace: ref.platform === 'bitbucket' ? ref.workspace : '',
    repoSlug: ref.platform === 'bitbucket' ? ref.repoSlug : '',
    prId: ref.platform === 'bitbucket' ? ref.prId : 0,
    organizationId: organizationId ?? '',
  };
}

// ── normalizers ────────────────────────────────────────────────────────
// Pure, so the provider→screen contract is tested without a network or a
// mount. Fields no provider reports degrade to the empty value the screens
// already render for a GitHub PR whose GraphQL leg failed.

// GitHub's check vocabulary, which the checks section classifies against:
// GitLab reports `failed` and Bitbucket `canceled`; every other verdict the
// two report already spells the same as GitHub's, or is provider-specific and
// counts only towards the total.
function normalizeConclusion(conclusion: string | null): string | null {
  if (conclusion === 'failed') {
    return 'failure';
  }
  return conclusion === 'canceled' ? 'cancelled' : conclusion;
}

// Which rollup counter a completed run lands in; anything else (a neutral
// or provider-specific verdict) counts only towards the total.
const ROLLUP_BUCKETS = new Map<string, 'success' | 'failure' | 'skipped'>([
  ['success', 'success'],
  ['failure', 'failure'],
  ['error', 'failure'],
  ['cancelled', 'skipped'],
  ['skipped', 'skipped'],
]);

export function normalizeProviderChecks(result: ProviderPrChecksResult): PrChecksModel {
  const checkRuns = result.checks.map(check => ({
    name: check.name,
    // A provider reports its own run states; the rollup and the row icons
    // read GitHub's, where `conclusion` is set only once a run completed.
    status: check.conclusion === null ? 'in_progress' : 'completed',
    conclusion: normalizeConclusion(check.conclusion),
    detailsUrl: check.detailsUrl,
    appName: null,
  }));
  const rollup = { total: checkRuns.length, success: 0, failure: 0, pending: 0, skipped: 0 };
  for (const run of checkRuns) {
    const bucket = run.conclusion === null ? 'pending' : ROLLUP_BUCKETS.get(run.conclusion);
    if (bucket) {
      rollup[bucket] += 1;
    }
  }
  return { checkRuns, rollup };
}

/**
 * The screens key comments by a numeric id (GitHub's). Provider ids are
 * strings, so a numeric one is used as-is and anything else folds to a
 * stable positive integer; the provider's own id is kept verbatim in
 * `nodeId`, which is what a write call needs.
 */
function commentNumericId(commentId: string): number {
  const parsed = Number(commentId);
  if (/^\d+$/.test(commentId) && Number.isSafeInteger(parsed) && parsed > 0) {
    return parsed;
  }
  let hash = 0;
  for (const character of commentId) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return hash === 0 ? 1 : hash;
}

function normalizeProviderThread(thread: ProviderPrThread): PrThreadsPageModel['threads'][number] {
  return {
    threadId: thread.threadId,
    isResolved: thread.resolved,
    isOutdated: false,
    subjectType: thread.line === null ? 'FILE' : 'LINE',
    path: thread.path,
    line: thread.line,
    startLine: null,
    originalLine: null,
    originalStartLine: null,
    diffSide: thread.side,
    diffHunk: null,
    comments: thread.comments.map(comment => ({
      commentId: commentNumericId(comment.commentId),
      nodeId: comment.commentId,
      author: comment.author,
      bodyMarkdown: comment.body,
      createdAt: comment.createdAt,
      // Neither provider read layer returns reactions; Bitbucket has none at
      // all (see BITBUCKET_REVIEW_CAPABILITIES.reactions).
      reactions: [],
    })),
  };
}

/** One discussion page as a provider read layer returns it. */
type ProviderThreadsPage = { threads: ProviderPrThread[]; nextCursor: string | null };

export function normalizeProviderThreadsPage(page: ProviderThreadsPage): PrThreadsPageModel {
  return {
    threads: page.threads.map(normalizeProviderThread),
    // Providers have no separate conversation leg: an unanchored discussion
    // is already a thread with `path: null`.
    conversation: [],
    nextCursor: page.nextCursor,
  };
}

/**
 * The loaded discussion pages as the tab renders them. GitHub pages are
 * already the model; a provider page is mapped thread by thread. The query
 * options are typed as GitHub's (see the casts below), so the provider arm
 * is re-read at its true runtime shape here.
 */
export function normalizePrThreadsPages(
  platform: ProviderPrPlatform,
  pages: readonly PrThreadsPageModel[] | undefined
): PrThreadsPageModel[] {
  const loaded = pages ?? [];
  if (platform === 'github') {
    return [...loaded];
  }
  return asGithubOptions<ProviderThreadsPage[]>(loaded).map(page =>
    normalizeProviderThreadsPage(page)
  );
}

export function normalizeProviderOverview(summary: ProviderPrSummary): PrOverviewModel {
  const { ref } = summary;
  const capabilities = providerPrCapabilities(ref.platform);
  return {
    number: providerPrTriple(ref).number,
    title: summary.title,
    bodyMarkdown: summary.body,
    author: summary.author,
    state: summary.state,
    draft: summary.draft,
    baseRef: summary.baseRef,
    headRef: summary.headRef,
    isCrossRepo: false,
    headRepoFullName: providerPrRepoPath(ref),
    headSha: summary.headSha,
    // A stable, collision-free node identity per provider ref.
    prNodeId: providerPrRefKey(ref),
    counts: {
      // No provider read layer reports a commit count; null omits the chip.
      commits: null,
      changedFiles: summary.changedFiles,
      additions: summary.additions,
      deletions: summary.deletions,
    },
    mergeable: null,
    mergeableState: null,
    autoMerge: null,
    reviewDecision: null,
    labels: [],
    assignees: [],
    reviewers: [],
    linkedIssues: [],
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    closedAt: null,
    mergedAt: null,
    mergedBy: null,
    commentCount: 0,
    repo: {
      allowMergeCommit: capabilities.canMerge,
      allowSquashMerge: capabilities.canMerge,
      allowRebaseMerge: false,
      allowAutoMerge: capabilities.autoMerge.supported,
      deleteBranchOnMerge: false,
      allowUpdateBranch: false,
      viewerCanPush: false,
      viewerCanAdmin: false,
      viewerLogin: null,
    },
  };
}

// ── query builders ─────────────────────────────────────────────────────
// A provider arm is read back at the GitHub option type: the normalizers
// above make the DATA identical, and the only shape that differs is the
// opaque page cursor, which travels straight back into the provider input.

// eslint-disable-next-line typescript-eslint/no-unnecessary-type-parameters -- the caller names the GitHub option type this provider arm is read back at
function asGithubOptions<T>(providerOptions: unknown): T {
  return providerOptions as T;
}

/** Every provider paginates on one opaque cursor of its own. */
const nextProviderCursor = (lastPage: { nextCursor: string | null }) =>
  lastPage.nextCursor ?? undefined;

function githubOverviewOptions(trpc: Trpc, triple: ProviderPrTriple) {
  return trpc.githubPrReview.getPullRequest.queryOptions(triple);
}

export function buildPrOverviewQueryOptions(trpc: Trpc, scope: ProviderPrScope) {
  if (scope.ref.platform === 'github') {
    return githubOverviewOptions(trpc, providerPrTriple(scope.ref));
  }
  return asGithubOptions<ReturnType<typeof githubOverviewOptions>>(
    trpc.providerReview.getPullRequest.queryOptions(providerIdentity(scope), {
      enabled: isProviderScopeReady(scope),
      select: normalizeProviderOverview,
    })
  );
}

function githubChecksOptions(trpc: Trpc, input: { owner: string; repo: string; ref: string }) {
  return trpc.githubPrReview.listChecks.queryOptions(input);
}

export function buildPrChecksQueryOptions(trpc: Trpc, scope: ProviderPrScope, headSha: string) {
  const triple = providerPrTriple(scope.ref);
  if (scope.ref.platform === 'github') {
    return githubChecksOptions(trpc, { owner: triple.owner, repo: triple.repo, ref: headSha });
  }
  return asGithubOptions<ReturnType<typeof githubChecksOptions>>(
    trpc.providerReview.listChecks.queryOptions(providerIdentity(scope), {
      enabled: isProviderScopeReady(scope),
      select: normalizeProviderChecks,
    })
  );
}

function githubFilesOptions(trpc: Trpc, input: ProviderPrTriple, enabled: boolean) {
  return trpc.githubPrReview.listFiles.infiniteQueryOptions(input, {
    staleTime: 30_000,
    enabled,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  });
}

export function buildPrFilesQueryOptions(trpc: Trpc, scope: ProviderPrScope, enabled: boolean) {
  if (scope.ref.platform === 'github') {
    return githubFilesOptions(trpc, providerPrTriple(scope.ref), enabled);
  }
  return asGithubOptions<ReturnType<typeof githubFilesOptions>>(
    trpc.providerReview.listFiles.infiniteQueryOptions(providerIdentity(scope), {
      staleTime: 30_000,
      enabled: enabled && isProviderScopeReady(scope),
      getNextPageParam: nextProviderCursor,
    })
  );
}

function githubThreadsOptions(trpc: Trpc, input: ProviderPrTriple) {
  return trpc.githubPrReview.listReviewThreads.infiniteQueryOptions(input, {
    staleTime: 15_000,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  });
}

export function buildPrThreadsQueryOptions(trpc: Trpc, scope: ProviderPrScope) {
  if (scope.ref.platform === 'github') {
    return githubThreadsOptions(trpc, providerPrTriple(scope.ref));
  }
  return asGithubOptions<ReturnType<typeof githubThreadsOptions>>(
    trpc.providerReview.listDiscussions.infiniteQueryOptions(providerIdentity(scope), {
      staleTime: 15_000,
      enabled: isProviderScopeReady(scope),
      getNextPageParam: nextProviderCursor,
    })
  );
}

export type PrFileLinesInput = { ref: string; path: string; startLine: number; endLine: number };

function githubFileLinesOptions(
  trpc: Trpc,
  input: { owner: string; repo: string } & PrFileLinesInput
) {
  return trpc.githubPrReview.getFileLines.queryOptions(input, {
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });
}

/** Expanded diff context. Every provider answers `{ lines, totalLines }`. */
export function buildPrFileLinesQueryOptions(
  trpc: Trpc,
  scope: ProviderPrScope,
  input: PrFileLinesInput
) {
  const triple = providerPrTriple(scope.ref);
  if (scope.ref.platform === 'github') {
    return githubFileLinesOptions(trpc, { owner: triple.owner, repo: triple.repo, ...input });
  }
  return asGithubOptions<ReturnType<typeof githubFileLinesOptions>>(
    trpc.providerReview.getFileLines.queryOptions(
      { ...providerIdentity(scope), ...input },
      { staleTime: 5 * 60_000, gcTime: 10 * 60_000 }
    )
  );
}

/**
 * The provider merge gate. GitHub has no `getMergeState` procedure — its
 * merge surface derives the gate from the overview DTO — so its arm keeps
 * the query disabled (a placeholder input registers it, nothing fetches).
 */
export function buildPrMergeStateQueryOptions(trpc: Trpc, scope: ProviderPrScope) {
  const isProviderArm = scope.ref.platform !== 'github';
  const identity = isProviderArm ? providerIdentity(scope) : null;
  return trpc.providerReview.getMergeState.queryOptions(
    identity ?? { platform: 'gitlab', projectPath: '', mrIid: 0 },
    {
      enabled: isProviderArm && isProviderScopeReady(scope),
    }
  );
}

/** The identity `providerReview.getCapabilities` takes: no repository to pin. */
type ProviderCapabilitiesInput =
  | { platform: 'gitlab'; instanceHint?: string; organizationId?: string }
  | { platform: 'bitbucket'; organizationId: string };

/**
 * The identity the capability list is read under. The query itself stays at
 * its call site (the merge screen's auto-merge arm, the review-submit event
 * list) — the option type only resolves inline; a wrapper loses it under
 * the linter's type inference. The GitHub arm keeps its query disabled and
 * never touches `providerReview` over the network.
 */
export function providerCapabilitiesIdentity(scope: ProviderPrScope): ProviderCapabilitiesInput {
  const ref = scope.ref;
  if (ref.platform === 'bitbucket') {
    return { platform: 'bitbucket', organizationId: scope.organizationId ?? '' };
  }
  return {
    platform: 'gitlab',
    ...(ref.platform === 'gitlab' && ref.instanceHint ? { instanceHint: ref.instanceHint } : {}),
    ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
  };
}

/**
 * The capability query's option type only resolves when the `queryOptions`
 * call sits inline at its call site (a wrapper loses it under the checkers),
 * so the screens read its answer back through this typed selector instead of
 * member-accessing the raw, checker-opaque query data.
 */
export function selectProviderCapabilitiesData(
  data: unknown
): ProviderReviewCapabilities | undefined {
  return data as ProviderReviewCapabilities | undefined;
}

/**
 * The seam as one value for a screen: which provider, what it can do, and
 * the two reads a screen owns itself. The list surfaces below it call the
 * builders through their own hooks (files, threads, expanded context).
 */
export function useProviderPrQueries(fallback: { owner: string; repo: string; number: number }) {
  const trpc = useTRPC();
  const scope = useProviderPrScope(fallback);
  return useMemo(
    () => ({
      ref: scope.ref,
      platform: scope.ref.platform,
      capabilities: providerPrCapabilities(scope.ref.platform),
      isReady: isProviderScopeReady(scope),
      overviewOptions: () => buildPrOverviewQueryOptions(trpc, scope),
      checksOptions: (headSha: string) => buildPrChecksQueryOptions(trpc, scope, headSha),
      mergeStateOptions: () => buildPrMergeStateQueryOptions(trpc, scope),
    }),
    [trpc, scope]
  );
}
