import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode, useEffect, useRef } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';

import { PrReviewCommentComposer } from '@/components/pr-review/pr-review-comment-composer';
import { QueryError } from '@/components/query-error';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { ScreenHeader } from '@/components/screen-header';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { parseComposerParams } from '@/lib/pr-review/comment-composer-params';
import { usePendingReview } from '@/lib/pr-review/pending-review-provider';
import { useTRPC } from '@/lib/trpc';

type Params = {
  owner: string;
  repo: string;
  number: string;
  path: string;
  side?: string;
  line: string;
  startLine?: string;
  pendingId?: string;
};

export function PrReviewCommentComposerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const params = useLocalSearchParams<Params>();
  const parsed = parseComposerParams(params);
  const pending = usePendingReview();

  const pendingId = parsed?.pendingId;
  const isEdit = pendingId !== undefined;
  const pendingItem = isEdit ? pending.items.find(item => item.id === pendingId) : undefined;

  // Edit mode is local-only: do not fire getPullRequest and do not gate on it.
  const trpc = useTRPC();
  const pr = useQuery(
    trpc.githubPrReview.getPullRequest.queryOptions(
      { owner: parsed?.owner ?? '', repo: parsed?.repo ?? '', number: parsed?.number ?? 0 },
      { enabled: parsed !== null && !isEdit }
    )
  );

  // Missing pending item: alert above the formSheet and back out once.
  const missingAlertedRef = useRef(false);
  useEffect(() => {
    if (!parsed || !isEdit || pendingItem || missingAlertedRef.current) {
      return;
    }
    missingAlertedRef.current = true;
    Alert.alert('Comment unavailable', 'This pending comment was already deleted or submitted.', [
      {
        text: 'OK',
        onPress: () => {
          router.back();
        },
      },
    ]);
  }, [parsed, isEdit, pendingItem, router]);

  const dismiss = () => {
    router.back();
  };

  let content: ReactNode = null;
  if (!parsed) {
    content = <InvalidRouteState backTo="/(app)/pr-review" />;
  } else if (isEdit) {
    content = pendingItem ? (
      <PrReviewCommentComposer
        key={`edit:${pendingItem.id}`}
        owner={parsed.owner}
        repo={parsed.repo}
        number={parsed.number}
        mode={{ kind: 'edit', pendingItemId: pendingItem.id }}
        path={parsed.path}
        side={parsed.side}
        line={parsed.line}
        startLine={parsed.startLine}
        initialBody={pendingItem.body}
        onDismiss={dismiss}
      />
    ) : null;
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
    const createKey = [parsed.path, parsed.line, parsed.side, parsed.startLine ?? ''].join(':');
    content = (
      <PrReviewCommentComposer
        key={`create:${createKey}`}
        owner={parsed.owner}
        repo={parsed.repo}
        number={parsed.number}
        mode={{ kind: 'create', headSha: pr.data.headSha }}
        path={parsed.path}
        side={parsed.side}
        line={parsed.line}
        startLine={parsed.startLine}
        onDismiss={dismiss}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={isEdit ? 'Edit comment' : 'Add comment'}
        eyebrow={parsed ? `${parsed.owner}/${parsed.repo}#${parsed.number}` : ''}
        modal
        onBack={dismiss}
      />
      {content}
    </View>
  );
}
