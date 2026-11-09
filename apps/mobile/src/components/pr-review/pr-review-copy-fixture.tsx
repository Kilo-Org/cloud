import { MutationCache, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { initialWindowMetrics } from 'react-native-safe-area-context';

import { PrReviewFileList } from '@/components/pr-review/diff/pr-diff-file-list';
import { PrDiffFileNavigator } from '@/components/pr-review/diff/pr-diff-file-navigator';
import { PrMergeSheet } from '@/components/pr-review/merge/pr-merge-sheet';
import { providerPrMergeTitles } from '@/components/pr-review/merge/pr-merge-titles';
import { PrReviewChecksSection } from '@/components/pr-review/pr-review-checks-section';
import { PrReviewCommentComposer } from '@/components/pr-review/pr-review-comment-composer';
import {
  createFixtureClient,
  fileCount,
  headSha,
  triple,
} from '@/components/pr-review/pr-review-copy-fixture-client';
import {
  isGateSurface,
  PrReviewGateCopyFixture,
} from '@/components/pr-review/pr-review-copy-fixture-gates';
import {
  PrReviewOverviewCopyFixture,
  type PrReviewOverviewFixtureSurface,
} from '@/components/pr-review/pr-review-overview-copy-fixture';
import { PrReviewReviewSubmitScreen } from '@/components/pr-review/pr-review-review-submit-screen';
import {
  type PrReviewTabId,
  PrReviewTabSelector,
} from '@/components/pr-review/pr-review-tab-selector';
import { ScreenHeader } from '@/components/screen-header';
import { FeedbackPromptProvider } from '@/components/use-feedback-prompt';
import {
  pendingReviewDraftKey,
  PendingReviewProvider,
} from '@/lib/pr-review/pending-review-provider';
import { type ProviderPrScope, ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';
import { useProviderPrQueries } from '@/lib/pr-review/provider-pr-queries';
import { TRPCProvider } from '@/lib/trpc';

// In a development build, open dev/pr-review-copy-fixture/{checks,navigator,files,merge,tabs}
// through the app's native link scheme; the overview surfaces are
// dev/pr-review-copy-fixture/{overview,overview-blocked,overview-merged,merge-request,
// merge-request-missing,merge-request-error}.
// The checks-not-available surface answers the checks read as not found, the
// terminal that renders the section's unavailable message; the composer surface
// mounts the comment composer on a line; the gate surfaces are
// dev/pr-review-copy-fixture/gate-*.
// Uses the app's selected language without changing its preference.
// Real review consumers read owned fake DTOs across an asynchronous tRPC boundary.
// Reads never invoke global fetch. The mutation cache rejects before any mutation
// function runs, including production hooks that use the singleton tRPC client.
// The navigator starts with 100 of 101 files, exercising listed-file progress;
// searching fetches the final page through the usual pagination hook.
const OVERVIEW_SURFACES = [
  'overview',
  'overview-blocked',
  'overview-merged',
  'merge-request',
  'overview-no-checks',
  'overview-multi-group',
  'overview-auto-merge',
  'merge-request-missing',
  'merge-request-error',
] as const;

function isOverviewSurface(surface: string | undefined): surface is PrReviewOverviewFixtureSurface {
  return OVERVIEW_SURFACES.some(candidate => candidate === surface);
}

const scope: ProviderPrScope = {
  ref: { platform: 'gitlab', projectPath: 'sample/review-copy', mrIid: 1 },
  organizationId: null,
};

/**
 * The standalone CHECKS surface: the section renders from a read its screen
 * owns, so this surface owns one the way the overview does, and the card paints
 * only once that read has answered — the only shape it has in the app.
 */
function ChecksSectionSurface() {
  const queries = useProviderPrQueries(triple);
  const read = useQuery(queries.checksOptions(headSha, true));
  if (read.isLoading) {
    return null;
  }
  return (
    <ScrollView contentContainerClassName="gap-4 p-6">
      <PrReviewChecksSection {...triple} checks={read} />
    </ScrollView>
  );
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
  const [client] = useState(() => createFixtureClient(surface));
  const [tab, setTab] = useState<PrReviewTabId>('files');
  const header = (
    <ScreenHeader title={t('prReview.fileNavigator.title')} eyebrow="sample/review-copy#1" />
  );
  let content: ReactNode = null;
  if (surface === 'tabs') {
    content = (
      <View className="px-4 pb-2 pt-3">
        <PrReviewTabSelector activeTab={tab} onChange={setTab} discussionCount={3} />
      </View>
    );
  } else if (surface === 'merge') {
    content = (
      <ProviderPrScopeProvider value={scope}>
        <PrMergeSheet
          owner={triple.owner}
          repoName={triple.repo}
          number={triple.number}
          headSha={headSha}
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
          sheetTitle={providerPrMergeTitles(t, scope.ref.platform).action}
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
      <PrDiffFileNavigator {...triple} headSha={headSha} changedFiles={fileCount} header={header} />
    );
  } else if (surface === 'files') {
    content = (
      <PendingReviewProvider
        userId="review-copy-fixture"
        draftEntityKey={pendingReviewDraftKey(triple.owner, triple.repo, triple.number)}
      >
        {header}
        <PrReviewFileList {...triple} headSha={headSha} changedFiles={fileCount} />
      </PendingReviewProvider>
    );
  } else if (isOverviewSurface(surface)) {
    // Keyed by surface: each surface answers the same query keys, so a second
    // surface opened on this route would otherwise read the first one's cached
    // reads (staleTime: Infinity) and appear not to change the screen.
    content = <PrReviewOverviewCopyFixture key={surface} surface={surface} />;
  } else if (surface === 'submit') {
    content = (
      <FeedbackPromptProvider>
        <PendingReviewProvider
          userId="review-copy-fixture"
          draftEntityKey={pendingReviewDraftKey(triple.owner, triple.repo, triple.number)}
        >
          <PrReviewReviewSubmitScreen />
        </PendingReviewProvider>
      </FeedbackPromptProvider>
    );
  } else if (isGateSurface(surface)) {
    content = <PrReviewGateCopyFixture surface={surface} />;
  } else if (surface === 'composer') {
    content = (
      <PendingReviewProvider
        userId="review-copy-fixture"
        draftEntityKey={pendingReviewDraftKey(triple.owner, triple.repo, triple.number)}
      >
        <PrReviewCommentComposer
          owner={triple.owner}
          repo={triple.repo}
          number={triple.number}
          mode={{ kind: 'create', headSha }}
          path="src/greeting.ts"
          side="RIGHT"
          line={2}
          title={t('prReview.composer.addTitle')}
          eyebrow="sample/review-copy#1"
          onDismiss={() => {
            router.back();
          }}
        />
      </PendingReviewProvider>
    );
  } else {
    content = <ChecksSectionSurface />;
  }
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={client} queryClient={queryClient}>
        {/* The spacers take their height from the startup window metrics, which
            are known synchronously, so the surface reserves the safe area at
            first paint instead of growing when the native insets arrive and
            pushing everything below it down. */}
        <View className="flex-1 bg-background">
          <View style={{ height: initialWindowMetrics?.insets.top ?? 0 }} />
          <View className="flex-1">{content}</View>
          <View style={{ height: initialWindowMetrics?.insets.bottom ?? 0 }} />
        </View>
      </TRPCProvider>
    </QueryClientProvider>
  );
}
