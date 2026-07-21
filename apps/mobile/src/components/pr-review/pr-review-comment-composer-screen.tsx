import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { PrReviewCommentComposer } from '@/components/pr-review/pr-review-comment-composer';
import { QueryError } from '@/components/query-error';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { ScreenHeader } from '@/components/screen-header';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { parseComposerParams } from '@/lib/pr-review/comment-composer-params';
import { useTRPC } from '@/lib/trpc';

type Params = {
  owner: string;
  repo: string;
  number: string;
  path: string;
  side?: string;
  line: string;
  startLine?: string;
};

export function PrReviewCommentComposerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const params = useLocalSearchParams<Params>();
  const parsed = parseComposerParams(params);

  const trpc = useTRPC();
  const pr = useQuery(
    trpc.githubPrReview.getPullRequest.queryOptions(
      { owner: parsed?.owner ?? '', repo: parsed?.repo ?? '', number: parsed?.number ?? 0 },
      { enabled: parsed !== null }
    )
  );

  let content: ReactNode = null;
  if (!parsed) {
    content = <InvalidRouteState backTo="/(app)/pr-review" />;
  } else if (pr.isLoading) {
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
          title="Couldn't load the comment composer"
          onRetry={() => {
            void pr.refetch();
          }}
          isRetrying={pr.isFetching}
        />
      </View>
    );
  } else {
    content = (
      <PrReviewCommentComposer
        owner={parsed.owner}
        repo={parsed.repo}
        number={parsed.number}
        headSha={pr.data.headSha}
        path={parsed.path}
        side={parsed.side}
        line={parsed.line}
        startLine={parsed.startLine}
        onDismiss={() => {
          router.back();
        }}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Add comment"
        eyebrow={parsed ? `${parsed.owner}/${parsed.repo}#${parsed.number}` : ''}
        modal
        onBack={() => {
          router.back();
        }}
      />
      {content}
    </View>
  );
}
