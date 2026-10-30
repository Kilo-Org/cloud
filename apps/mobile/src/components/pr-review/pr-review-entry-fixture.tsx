import { useQuery } from '@tanstack/react-query';
import { Redirect, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { PrReviewEntryScreen } from '@/components/pr-review/pr-review-entry-screen';
import { QueryError } from '@/components/query-error';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { API_BASE_URL } from '@/lib/config';
import { clearRecentPrs, type RecentPr, upsertRecentPr } from '@/lib/pr-review/recent-prs';
import { useTRPC } from '@/lib/trpc';

// Open kiloapp:///dev/pr-review-entry-fixture on a loopback backend with an
// owned @example.com account. Add ?state=empty to check the empty history.
// Seeds the real local history; the screen, picker, and confirmation stay real.
const RECENTS = [
  {
    owner: 'sample',
    repo: 'api',
    number: 7,
    title: '',
    platform: 'bitbucket',
  },
  {
    owner: 'sample/platform/engineering',
    repo: 'a-repository-with-a-long-name',
    number: 18,
    title: 'Keep repository details readable on smaller screens',
    platform: 'gitlab',
    instanceHint: 'https://gitlab.example.com',
    lastResult: 'failed',
  },
  {
    owner: 'sample',
    repo: 'mobile',
    number: 42,
    title: 'Improve pull request navigation and keep the selected organization visible',
    platform: 'github',
  },
] satisfies Omit<RecentPr, 'lastOpenedAt'>[];

export function PrReviewEntryFixture() {
  const { state } = useLocalSearchParams<{ state?: string }>();
  const trpc = useTRPC();
  const local =
    __DEV__ && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(API_BASE_URL).hostname);
  const user = useQuery({ ...trpc.user.getMe.queryOptions(), enabled: local });
  const allowed = local && user.data?.success === true && user.data.email.endsWith('@example.com');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const prepare = useCallback(async () => {
    setStatus('loading');
    try {
      await (state === 'empty'
        ? clearRecentPrs()
        : Promise.all(
            RECENTS.map((entry, index) =>
              upsertRecentPr({ ...entry, lastOpenedAt: Date.now() + index })
            )
          ));
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, [state]);

  useFocusEffect(
    useCallback(() => {
      if (allowed) {
        void prepare();
      }
    }, [allowed, prepare])
  );

  if (!local || (user.isSuccess && !allowed)) {
    return <Redirect href="/(auth)/login" />;
  }
  if (user.isError || status === 'error') {
    return (
      <QueryError
        onRetry={() => {
          if (allowed) {
            void prepare();
          } else {
            void user.refetch();
          }
        }}
      />
    );
  }
  if (!allowed || status !== 'ready') {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }
  return <PrReviewEntryScreen />;
}
