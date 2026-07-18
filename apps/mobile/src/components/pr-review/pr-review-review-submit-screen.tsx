import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { PrReviewSubmit } from '@/components/pr-review/pr-review-submit';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { parseParam } from '@/lib/route-params';
import { useTRPC } from '@/lib/trpc';

type Params = {
  owner: string;
  repo: string;
  number: string;
};

export function PrReviewReviewSubmitScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const params = useLocalSearchParams<Params>();
  const owner = parseParam(params.owner) ?? '';
  const repo = parseParam(params.repo) ?? '';
  const rawNumber = parseParam(params.number) ?? '';
  const number = Number.parseInt(rawNumber, 10);

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
          title="Couldn't load review submission"
          onRetry={() => {
            void pr.refetch();
          }}
          isRetrying={pr.isFetching}
        />
      </View>
    );
  } else {
    content = (
      <PrReviewSubmit
        owner={owner}
        repo={repo}
        number={number}
        headSha={pr.data.headSha}
        onDismiss={() => {
          router.back();
        }}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Submit review"
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
