import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';

import { PrFormSheetHeader } from '@/components/pr-review/pr-form-sheet-chrome';
import { PrReviewSubmit } from '@/components/pr-review/pr-review-submit';
import { QueryError } from '@/components/query-error';
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
  const title = 'Submit review';
  const eyebrow = `${owner}/${repo}#${rawNumber}`;
  const dismiss = () => {
    router.back();
  };

  const trpc = useTRPC();
  const pr = useQuery(
    trpc.githubPrReview.getPullRequest.queryOptions(
      { owner, repo, number },
      { enabled: Boolean(owner) && Boolean(repo) && Number.isInteger(number) && number > 0 }
    )
  );

  if (pr.data) {
    return (
      <PrReviewSubmit
        owner={owner}
        repo={repo}
        number={number}
        headSha={pr.data.headSha}
        title={title}
        eyebrow={eyebrow}
        onDismiss={dismiss}
      />
    );
  }

  const body: ReactNode = pr.isLoading ? (
    <View className="flex-1 items-center justify-center py-16">
      <ActivityIndicator size="small" color={colors.mutedForeground} />
    </View>
  ) : (
    <QueryError
      variant="server"
      title="Couldn't load review submission"
      onRetry={() => {
        void pr.refetch();
      }}
      isRetrying={pr.isFetching}
    />
  );

  return (
    <>
      <PrFormSheetHeader title={title} eyebrow={eyebrow} onBack={dismiss} />
      <ScrollView className="flex-1 bg-background" contentContainerClassName="grow">
        {body}
      </ScrollView>
    </>
  );
}
