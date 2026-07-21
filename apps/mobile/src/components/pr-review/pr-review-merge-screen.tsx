import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { PrMergeSheet } from '@/components/pr-review/merge/pr-merge-sheet';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type PrMergeMethod } from '@/lib/pr-review/merge/merge-blocked-reasons';
import { parseParam } from '@/lib/route-params';
import { useTRPC } from '@/lib/trpc';

type Params = {
  owner: string;
  repo: string;
  number: string;
  mode?: string;
  method?: string;
};

const MERGE_METHODS = new Set<PrMergeMethod>(['merge', 'squash', 'rebase']);

/**
 * Merge formSheet route. Reads the PR + mode/method from params, fetches the
 * overview so the sheet has the repo settings + head SHA fence, and mounts the
 * S8 merge sheet. Rendered inside the `[number]` layout's formSheet stack.
 */
export function PrReviewMergeScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const params = useLocalSearchParams<Params>();
  const owner = parseParam(params.owner) ?? '';
  const repo = parseParam(params.repo) ?? '';
  const rawNumber = parseParam(params.number) ?? '';
  const number = Number.parseInt(rawNumber, 10);
  const mode = params.mode === 'enable-auto-merge' ? 'enable-auto-merge' : 'merge';
  const method: PrMergeMethod = MERGE_METHODS.has(params.method as PrMergeMethod)
    ? (params.method as PrMergeMethod)
    : 'merge';

  const trpc = useTRPC();
  const pr = useQuery(
    trpc.githubPrReview.getPullRequest.queryOptions(
      { owner, repo, number },
      { enabled: Boolean(owner) && Boolean(repo) && Number.isInteger(number) && number > 0 }
    )
  );

  let content: ReactNode = null;
  if (pr.isLoading) {
    content = (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator size="small" color={colors.mutedForeground} />
      </View>
    );
  } else if (pr.isError || !pr.data) {
    content = (
      <View className="flex-1">
        <QueryError
          variant="server"
          title="Couldn't load merge options"
          onRetry={() => {
            void pr.refetch();
          }}
          isRetrying={pr.isFetching}
        />
      </View>
    );
  } else {
    content = (
      <PrMergeSheet
        owner={owner}
        repoName={repo}
        number={number}
        headSha={pr.data.headSha}
        headRef={pr.data.headRef}
        isCrossRepo={pr.data.isCrossRepo}
        prNodeId={pr.data.prNodeId}
        title={pr.data.title}
        bodyMarkdown={pr.data.bodyMarkdown}
        baseRef={pr.data.baseRef}
        repo={pr.data.repo}
        initialMethod={method}
        mode={mode}
        onRefetch={async () => {
          await pr.refetch();
        }}
        onDismiss={() => {
          router.back();
        }}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={mode === 'enable-auto-merge' ? 'Enable auto-merge' : 'Merge pull request'}
        eyebrow={`${owner}/${repo}#${rawNumber}`}
        modal
        onBack={() => {
          router.back();
        }}
      />
      {content}
    </View>
  );
}
