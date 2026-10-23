// In a development build, the PR review copy fixture mounts the real overview
// against isolated fake reads, so the Review section, the reviewers block and
// the provider error states can be read in the app's selected language without
// a forge connection. Every read is answered below over the usual tRPC
// boundary; writes are rejected before any mutation function runs.

import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient, httpLink } from '@trpc/client';
import { useState } from 'react';
import { View } from 'react-native';

import { PrReviewOverview } from '@/components/pr-review/pr-review-overview';
import { type ProviderPrScope, ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';
import { TRPCProvider } from '@/lib/trpc';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

export type PrReviewOverviewFixtureSurface =
  | 'overview'
  | 'merge-request-missing'
  | 'merge-request-error';

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

export const reviewChecksFixture = {
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
            return fixtureResponse(reviewOverviewFixture);
          }
          if (url.includes('/githubPrReview.listChecks')) {
            return fixtureResponse(reviewChecksFixture);
          }
          if (url.includes('/providerReview.getPullRequest')) {
            return surface === 'merge-request-missing'
              ? providerErrorResponse('NOT_FOUND', 404)
              : providerErrorResponse('INTERNAL_SERVER_ERROR', 500);
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
  const body = (
    <View className="flex-1 bg-background">
      <PrReviewOverview {...triple} isActive />
    </View>
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={client} queryClient={queryClient}>
        {surface === 'overview' ? (
          body
        ) : (
          <ProviderPrScopeProvider value={gitlabScope}>{body}</ProviderPrScopeProvider>
        )}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
