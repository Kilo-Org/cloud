// In a development build, the PR review copy fixture mounts the real overview
// against isolated fake reads, so the Review section, the reviewers block and
// the provider error states can be read in the app's selected language without
// a forge connection. Every read is answered below over the usual tRPC
// boundary; writes are rejected before any mutation function runs.

import {
  type ProviderPrChecksResult,
  type ProviderPrSummary,
} from '@kilocode/app-shared/provider-review';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient, httpLink } from '@trpc/client';
import { useState } from 'react';
import { View } from 'react-native';

import { PrReviewOverview } from '@/components/pr-review/pr-review-overview';
import {
  type ProviderPrScope,
  ProviderPrScopeProvider,
  providerPrWebUrl,
  ProviderPrWebUrlProvider,
} from '@/lib/pr-review/provider-pr-ref';
import { TRPCProvider } from '@/lib/trpc';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

export type PrReviewOverviewFixtureSurface =
  | 'overview'
  | 'overview-no-checks'
  | 'overview-multi-group'
  | 'overview-blocked'
  | 'overview-merged'
  | 'overview-auto-merge'
  | 'merge-request'
  | 'merge-request-missing'
  | 'merge-request-error';

/**
 * What each overview surface reads. The GitHub surfaces differ only in the
 * shape of the checks answer — one run, no runs, and one run per status group —
 * because the Review button and the merge section below that card must keep one
 * position after the first settled frame in all three. `overview-auto-merge`
 * keeps the single-run checks and turns auto-merge on, which is the only shape
 * that draws the merge section's auto-merge banner.
 */
const SURFACE_READS = {
  overview: { scope: 'github', checks: 'one-run', autoMerge: false },
  'overview-no-checks': { scope: 'github', checks: 'no-runs', autoMerge: false },
  'overview-multi-group': { scope: 'github', checks: 'multi-group', autoMerge: false },
  'overview-blocked': { scope: 'github', checks: 'one-run', autoMerge: false },
  'overview-merged': { scope: 'github', checks: 'one-run', autoMerge: false },
  'overview-auto-merge': { scope: 'github', checks: 'one-run', autoMerge: true },
  'merge-request': { scope: 'gitlab', checks: 'one-run', autoMerge: false },
  'merge-request-missing': { scope: 'gitlab', checks: 'one-run', autoMerge: false },
  'merge-request-error': { scope: 'gitlab', checks: 'one-run', autoMerge: false },
} as const satisfies Record<
  PrReviewOverviewFixtureSurface,
  {
    readonly scope: 'github' | 'gitlab';
    readonly checks: 'one-run' | 'no-runs' | 'multi-group';
    readonly autoMerge: boolean;
  }
>;

const headSha = '0123456789abcdef0123456789abcdef01234567';
const triple = { owner: 'sample', repo: 'review-copy', number: 1 } as const;
const gitlabScope: ProviderPrScope = {
  ref: { platform: 'gitlab', projectPath: 'sample/review-copy', mrIid: 1 },
  organizationId: null,
};

export const reviewOverviewFixture = {
  number: 1,
  title: 'Review copy',
  bodyMarkdown: 'Sample merge request.',
  author: { login: 'ada', avatarUrl: null },
  state: 'open',
  draft: false,
  baseRef: 'main',
  headRef: 'review-copy',
  isCrossRepo: false,
  headRepoFullName: 'sample/review-copy',
  headSha,
  prNodeId: 'fixture-overview',
  counts: { commits: 2, changedFiles: 2, additions: 3, deletions: 1 },
  mergeable: true,
  mergeableState: 'clean',
  autoMerge: null,
  reviewDecision: 'REVIEW_REQUIRED',
  labels: [{ name: 'copy', color: '0e8a16' }],
  assignees: [],
  reviewers: [
    { login: 'ada', avatarUrl: null, state: 'APPROVED' },
    { login: 'grace', avatarUrl: null, state: 'PENDING' },
  ],
  linkedIssues: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  closedAt: null,
  mergedAt: null,
  mergedBy: null,
  commentCount: 0,
  repo: {
    allowMergeCommit: true,
    allowSquashMerge: true,
    allowRebaseMerge: false,
    allowAutoMerge: true,
    deleteBranchOnMerge: false,
    allowUpdateBranch: true,
    viewerCanPush: true,
    viewerCanAdmin: true,
    viewerLogin: 'ada',
  },
} satisfies RouterOutputs['githubPrReview']['getPullRequest'];

/** The overview a review decision holds back: the merge section's blocked arm. */
const blockedOverviewFixture: RouterOutputs['githubPrReview']['getPullRequest'] = {
  ...reviewOverviewFixture,
  mergeableState: 'blocked',
  reviewDecision: 'CHANGES_REQUESTED',
};

/** The overview of an already-merged PR: the merge section's terminal arm. */
const mergedOverviewFixture: RouterOutputs['githubPrReview']['getPullRequest'] = {
  ...reviewOverviewFixture,
  state: 'merged',
  mergeableState: 'unknown',
  mergedAt: '2026-01-03T00:00:00.000Z',
  mergedBy: { login: 'ada', avatarUrl: null },
};

/**
 * The same pull request with auto-merge queued. The merge section draws the
 * auto-merge banner from `autoMerge` and nothing else, so this is the only
 * fixture shape that shows the copy which names the queued method.
 */
const autoMergeOverviewFixture: RouterOutputs['githubPrReview']['getPullRequest'] = {
  ...reviewOverviewFixture,
  autoMerge: { method: 'squash' },
};

function githubOverviewFixture(
  surface: PrReviewOverviewFixtureSurface
): RouterOutputs['githubPrReview']['getPullRequest'] {
  if (surface === 'overview-blocked') {
    return blockedOverviewFixture;
  }
  if (surface === 'overview-merged') {
    return mergedOverviewFixture;
  }
  if (surface === 'overview-auto-merge') {
    return autoMergeOverviewFixture;
  }
  return reviewOverviewFixture;
}

const reviewChecksFixture = {
  checkRuns: [
    {
      name: 'Formatting',
      status: 'completed',
      conclusion: 'success',
      detailsUrl: null,
      appName: null,
    },
  ],
  rollup: { total: 1, success: 1, failure: 0, pending: 0, skipped: 0 },
} satisfies RouterOutputs['githubPrReview']['listChecks'];

/** A head commit right after a push: the card is one copy line. */
const reviewChecksNoRunsFixture = {
  checkRuns: [],
  rollup: { total: 0, success: 0, failure: 0, pending: 0, skipped: 0 },
} satisfies RouterOutputs['githubPrReview']['listChecks'];

/** Every status group present: the card is a count header plus four rows. */
const reviewChecksMultiGroupFixture = {
  checkRuns: [
    {
      name: 'Formatting',
      status: 'completed',
      conclusion: 'success',
      detailsUrl: null,
      appName: null,
    },
    {
      name: 'Unit tests',
      status: 'completed',
      conclusion: 'failure',
      detailsUrl: null,
      appName: null,
    },
    {
      name: 'Integration',
      status: 'in_progress',
      conclusion: null,
      detailsUrl: null,
      appName: null,
    },
    {
      name: 'Lint',
      status: 'completed',
      conclusion: 'skipped',
      detailsUrl: null,
      appName: null,
    },
  ],
  rollup: { total: 4, success: 1, failure: 1, pending: 1, skipped: 1 },
} satisfies RouterOutputs['githubPrReview']['listChecks'];

/**
 * The GitLab merge request the provider surfaces read: the same review the
 * overview fixture renders, in the shape the provider read layer returns, so
 * the provider arm goes through its real normalizer.
 */
const mergeRequestSummary = {
  ref: { platform: 'gitlab', projectPath: 'sample/review-copy', mrIid: 1 },
  title: 'Review copy',
  body: 'Sample merge request.',
  author: { login: 'ada', avatarUrl: null },
  state: 'open',
  draft: false,
  headRef: 'review-copy',
  baseRef: 'main',
  headSha,
  changedFiles: 2,
  additions: 3,
  deletions: 1,
  webUrl: 'https://gitlab.example.com/sample/review-copy/-/merge_requests/1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
} satisfies ProviderPrSummary;

const providerChecksFixture = {
  checks: [
    {
      name: 'Pipeline',
      status: 'success',
      conclusion: 'success',
      detailsUrl: null,
    },
  ],
} satisfies ProviderPrChecksResult;

const CHECKS_BY_SHAPE = {
  'one-run': reviewChecksFixture,
  'no-runs': reviewChecksNoRunsFixture,
  'multi-group': reviewChecksMultiGroupFixture,
} satisfies Record<(typeof SURFACE_READS)[PrReviewOverviewFixtureSurface]['checks'], unknown>;

function fixtureResponse(data: unknown): Response {
  // eslint-disable-next-line unicorn/prefer-response-static-json -- React Native's fetch polyfill has no static Response.json.
  return new Response(JSON.stringify({ result: { data } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A provider read failure in the shape the tRPC http link raises as its error. */
function providerErrorResponse(code: string, httpStatus: number): Response {
  const body = JSON.stringify({
    error: {
      message: code,
      code: -32603,
      data: { code, httpStatus, path: 'providerReview.getPullRequest', stack: '' },
    },
  });
  return new Response(body, {
    status: httpStatus,
    headers: { 'content-type': 'application/json' },
  });
}

function createFixtureClient(surface: PrReviewOverviewFixtureSurface) {
  return createTRPCClient<MobileRouter>({
    links: [
      httpLink({
        url: 'http://pr-review-overview-fixture.invalid/api/trpc',
        fetch: async (input, init) => {
          await Promise.resolve();
          const url = input instanceof Request ? input.url : input.toString();
          if (init?.method !== 'GET') {
            throw new Error('Review overview fixture does not allow writes');
          }
          if (url.includes('/githubPrReview.getPullRequest')) {
            return fixtureResponse(githubOverviewFixture(surface));
          }
          if (url.includes('/githubPrReview.listChecks')) {
            return fixtureResponse(CHECKS_BY_SHAPE[SURFACE_READS[surface].checks]);
          }
          if (url.includes('/providerReview.getPullRequest')) {
            if (surface === 'merge-request') {
              return fixtureResponse(mergeRequestSummary);
            }
            return surface === 'merge-request-missing'
              ? providerErrorResponse('NOT_FOUND', 404)
              : providerErrorResponse('INTERNAL_SERVER_ERROR', 500);
          }
          if (url.includes('/providerReview.listChecks')) {
            return fixtureResponse(providerChecksFixture);
          }
          throw new Error('Read not provided by the review overview fixture');
        },
      }),
    ],
  });
}

export function PrReviewOverviewCopyFixture({
  surface,
}: Readonly<{ surface: PrReviewOverviewFixtureSurface }>) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
        mutationCache: new MutationCache({
          onMutate: () => {
            throw new Error('Review overview fixture does not allow writes');
          },
        }),
      })
  );
  const [client] = useState(() => createFixtureClient(surface));
  const isGitHub = SURFACE_READS[surface].scope === 'github';
  // The screen publishes the loaded PR/MR's own URL to the body (see
  // `pr-review-screen.tsx`), and the no-checks card renders its
  // view-on-provider button from it. A GitHub read always has one, so the
  // fixture publishes it too; a provider surface whose read failed has none.
  const webUrl = isGitHub
    ? providerPrWebUrl({
        ref: { platform: 'github', ...triple },
        serverWebUrl: null,
      })
    : null;
  const body = (
    <View className="flex-1 bg-background">
      <PrReviewOverview {...triple} isActive />
    </View>
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={client} queryClient={queryClient}>
        <ProviderPrWebUrlProvider value={webUrl}>
          {isGitHub ? (
            body
          ) : (
            <ProviderPrScopeProvider value={gitlabScope}>{body}</ProviderPrScopeProvider>
          )}
        </ProviderPrWebUrlProvider>
      </TRPCProvider>
    </QueryClientProvider>
  );
}
