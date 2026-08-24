import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, ScrollView, View } from 'react-native';

import { PrFormSheetHeader } from '@/components/pr-review/pr-form-sheet-chrome';
import { PrReviewCommentComposer } from '@/components/pr-review/pr-review-comment-composer';
import { QueryError } from '@/components/query-error';
import { InvalidRouteState } from '@/components/invalid-route-state';
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
  const { t } = useTranslation();
  const params = useLocalSearchParams<Params>();
  const parsed = parseComposerParams(params);
  const pending = usePendingReview();

  const pendingId = parsed?.pendingId;
  const isEdit = pendingId !== undefined;
  const pendingItem = isEdit ? pending.items.find(item => item.id === pendingId) : undefined;
  const title = isEdit ? t('prReview.composer.editTitle') : t('prReview.composer.addTitle');
  const eyebrow = parsed ? `${parsed.owner}/${parsed.repo}#${parsed.number}` : '';

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
    Alert.alert(
      t('prReview.composer.unavailableTitle'),
      t('prReview.composer.unavailableMessage'),
      [
        {
          text: t('prReview.composer.ok'),
          onPress: () => {
            router.back();
          },
        },
      ]
    );
  }, [parsed, isEdit, pendingItem, router, t]);

  const dismiss = () => {
    router.back();
  };

  // Happy path: content ScrollView owns the in-scroll header.
  if (parsed && isEdit && pendingItem) {
    return (
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
        title={title}
        eyebrow={eyebrow}
        onDismiss={dismiss}
      />
    );
  }

  if (parsed && !isEdit && pr.data) {
    const createKey = [parsed.path, parsed.line, parsed.side, parsed.startLine ?? ''].join(':');
    return (
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
        title={title}
        eyebrow={eyebrow}
        onDismiss={dismiss}
      />
    );
  }

  let body: ReactNode = null;
  if (!parsed) {
    body = <InvalidRouteState backTo="/(app)/pr-review" />;
  } else if (isEdit) {
    body = null;
  } else if (pr.isLoading) {
    body = (
      <View className="flex-1 items-center justify-center py-16">
        <ActivityIndicator size="small" color={colors.mutedForeground} />
      </View>
    );
  } else {
    body = (
      <QueryError
        variant="server"
        title={t('prReview.composer.loadFailedTitle')}
        onRetry={() => {
          void pr.refetch();
        }}
        isRetrying={pr.isFetching}
      />
    );
  }

  return (
    <>
      <PrFormSheetHeader title={title} eyebrow={eyebrow} onBack={dismiss} />
      <ScrollView className="flex-1 bg-background" contentContainerClassName="grow">
        {body}
      </ScrollView>
    </>
  );
}
