import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient, httpLink } from '@trpc/client';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { z } from 'zod';

import { PrReviewFileList } from '@/components/pr-review/diff/pr-diff-file-list';
import { PrDiffFileNavigator } from '@/components/pr-review/diff/pr-diff-file-navigator';
import { PrMergeSheet, providerPrNounKey } from '@/components/pr-review/merge/pr-merge-sheet';
import { PrReviewChecksSection } from '@/components/pr-review/pr-review-checks-section';
import { ScreenHeader } from '@/components/screen-header';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';
import {
  pendingReviewDraftKey,
  PendingReviewProvider,
} from '@/lib/pr-review/pending-review-provider';
import { type ProviderPrScope, ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';
import { TRPCProvider } from '@/lib/trpc';

// In a development build, open dev/pr-review-copy-fixture/{checks,navigator,files,merge}
// through the app's native link scheme.
// Uses the app's selected language without changing its preference.
// Real review consumers read owned fake DTOs across an asynchronous tRPC boundary.
// Reads never invoke global fetch. The mutation cache rejects before any mutation
// function runs, including production hooks that use the singleton tRPC client.
// The navigator starts with 100 of 101 files, exercising listed-file progress;
// searching fetches the final page through the usual pagination hook.
const triple = { owner: 'sample', repo: 'review-copy', number: 1 };
const headSha = '0123456789abcdef0123456789abcdef01234567';
const scope: ProviderPrScope = {
  ref: { platform: 'gitlab', projectPath: 'sample/review-copy', mrIid: 1 },
  organizationId: null,
};
const files = [
  {
    path: 'src/greeting.ts',
    previousPath: null,
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch: '@@ -1 +1 @@\n-export const greeting = "Hi";\n+export const greeting = "Hello";',
    patchMissing: false,
  },
  {
    path: 'src/greeting.test.ts',
    previousPath: null,
    status: 'added',
    additions: 1,
    deletions: 0,
    patch: '@@ -0,0 +1 @@\n+expect(greeting).toBe("Hello");',
    patchMissing: false,
  },
  ...Array.from({ length: 99 }, (_, index) => ({
    path: `src/example-${String(index + 1).padStart(3, '0')}.ts`,
    previousPath: null,
    status: 'added',
    additions: 1,
    deletions: 0,
    patch: '@@ -0,0 +1 @@\n+export const example = true;',
    patchMissing: false,
  })),
] satisfies PrReviewFile[];
const checks = {
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
  ],
  rollup: { total: 2, success: 1, failure: 1, pending: 0, skipped: 0 },
} satisfies inferRouterOutputs<MobileRouter>['githubPrReview']['listChecks'];

type RouterOutputs = inferRouterOutputs<MobileRouter>;
type FixtureReadData =
  | RouterOutputs['githubPrReview']['listChecks']
  | RouterOutputs['githubPrReview']['listFiles']
  | RouterOutputs['user']['getMe'];

function fixtureResponse(data: FixtureReadData): Response {
  // eslint-disable-next-line unicorn/prefer-response-static-json -- React Native's fetch polyfill has no static Response.json.
  return new Response(JSON.stringify({ result: { data } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const FilePageInput = z.object({ cursor: z.literal(100).nullish() });

function createFixtureClient() {
  return createTRPCClient<MobileRouter>({
    links: [
      httpLink({
        url: 'http://pr-review-fixture.invalid/api/trpc',
        fetch: async (input, init) => {
          await Promise.resolve();
          const url = input instanceof Request ? input.url : input.toString();
          if (init?.method !== 'GET') {
            throw new Error('Review copy fixture does not allow writes');
          }
          if (url.includes('/githubPrReview.listChecks')) {
            return fixtureResponse(checks);
          }
          if (url.includes('/githubPrReview.listFiles')) {
            const pageInput = FilePageInput.parse(
              JSON.parse(new URL(url).searchParams.get('input') ?? '{}')
            );
            const offset = pageInput.cursor === 100 ? 100 : 0;
            return fixtureResponse({
              files: files.slice(offset, offset + 100),
              nextCursor: offset === 0 ? 100 : null,
            } satisfies RouterOutputs['githubPrReview']['listFiles']);
          }
          if (url.includes('/user.getMe')) {
            return fixtureResponse({
              success: true,
              id: 'review-copy-fixture',
              email: 'review-copy@example.com',
              isAdmin: false,
            } satisfies RouterOutputs['user']['getMe']);
          }
          throw new Error('Read not provided by review copy fixture');
        },
      }),
    ],
  });
}

export function PrReviewCopyFixture() {
  const { surface } = useLocalSearchParams<{ surface?: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
        mutationCache: new MutationCache({
          onMutate: () => {
            throw new Error('Review copy fixture does not allow writes');
          },
        }),
      })
  );
  const [client] = useState(createFixtureClient);
  const header = (
    <ScreenHeader title={t('prReview.fileNavigator.title')} eyebrow="sample/review-copy#1" />
  );
  let content: ReactNode = null;
  if (surface === 'merge') {
    content = (
      <ProviderPrScopeProvider value={scope}>
        <PrMergeSheet
          owner={triple.owner}
          repoName={triple.repo}
          number={triple.number}
          headSha={headSha}
          headRef="greeting"
          baseRef="main"
          isCrossRepo={false}
          prNodeId="fixture-pr"
          title={t('prReview.fileNavigator.title')}
          bodyMarkdown={null}
          repo={{
            allowMergeCommit: true,
            allowSquashMerge: true,
            allowRebaseMerge: false,
            allowAutoMerge: true,
            deleteBranchOnMerge: false,
            allowUpdateBranch: true,
            viewerCanPush: true,
            viewerCanAdmin: true,
          }}
          initialMethod="merge"
          mode="merge"
          prRef={scope.ref}
          mergeState={{
            canMerge: true,
            approvalsRequired: 0,
            pipelineMustSucceed: false,
            conflicts: false,
            blockedReasons: [],
          }}
          sheetTitle={t('prReview.merge.mergeTermTitle', { term: t(providerPrNounKey('gitlab')) })}
          eyebrow="sample/review-copy!1"
          onRefetch={async () => {
            await queryClient.invalidateQueries();
          }}
          onDismiss={() => {
            router.back();
          }}
        />
      </ProviderPrScopeProvider>
    );
  } else if (surface === 'navigator') {
    content = (
      <PrDiffFileNavigator
        {...triple}
        headSha={headSha}
        changedFiles={files.length}
        header={header}
      />
    );
  } else if (surface === 'files') {
    content = (
      <PendingReviewProvider
        userId="review-copy-fixture"
        draftEntityKey={pendingReviewDraftKey(triple.owner, triple.repo, triple.number)}
      >
        {header}
        <PrReviewFileList {...triple} headSha={headSha} changedFiles={files.length} />
      </PendingReviewProvider>
    );
  } else {
    content = (
      <ScrollView contentContainerClassName="gap-4 p-6">
        <PrReviewChecksSection {...triple} headSha={headSha} />
      </ScrollView>
    );
  }
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={client} queryClient={queryClient}>
        <View className="flex-1 bg-background">
          <SafeAreaView edges={['top']} />
          <View className="flex-1">{content}</View>
          <SafeAreaView edges={['bottom']} />
        </View>
      </TRPCProvider>
    </QueryClientProvider>
  );
}
