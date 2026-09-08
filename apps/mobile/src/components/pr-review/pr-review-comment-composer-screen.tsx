import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert } from 'react-native';

import { CenteredState } from '@/components/centered-state';

import { PrFormSheetHeader } from '@/components/pr-review/pr-form-sheet-chrome';
import { PrReviewCommentComposer } from '@/components/pr-review/pr-review-comment-composer';
import { QueryError } from '@/components/query-error';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { parseComposerParams } from '@/lib/pr-review/comment-composer-params';
import { usePendingReview } from '@/lib/pr-review/pending-review-provider';
import { buildPrOverviewQueryOptions } from '@/lib/pr-review/provider-pr-queries';
import {
  isProviderScopeReady,
  parseProviderPrRoute,
  providerPrRefLabel,
  providerPrTriple,
  useProviderPrScope,
} from '@/lib/pr-review/provider-pr-ref';
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
  // Provider route shape (`[platform]/[...identity]/comment-composer`).
  platform?: string;
  identity?: string[] | string;
  instance?: string;
};

/**
 * Comment-composer formSheet, mounted by BOTH routes: the GitHub
 * `[owner]/[repo]/[number]/comment-composer` route and the provider
 * `[platform]/[...identity]/comment-composer` route (s6). The route decides
 * the ref; the provider layout publishes the scope the queries run under.
 */
export function PrReviewCommentComposerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const params = useLocalSearchParams<Params>();
  const pending = usePendingReview();

  // The provider route carries the identity segments; the GitHub route the
  // plain triple. Exactly one parses — the provider layout redirects a
  // hand-built `/pr-review/github/...` link to the GitHub route.
  const providerRef = useMemo(
    () =>
      parseProviderPrRoute({
        platform: params.platform,
        identity: params.identity,
        instance: params.instance,
      }),
    [params.platform, params.identity, params.instance]
  );
  const providerTriple = providerRef ? providerPrTriple(providerRef) : null;
  const parsed = useMemo(
    () =>
      parseComposerParams(
        providerTriple
          ? {
              ...params,
              owner: providerTriple.owner,
              repo: providerTriple.repo,
              number: String(providerTriple.number),
            }
          : params
      ),
    // `providerTriple` is derived from `providerRef`; the segments it reads
    // are the same memo inputs.
    [params, providerTriple]
  );

  const pendingId = parsed?.pendingId;
  const isEdit = pendingId !== undefined;
  const pendingItem = isEdit ? pending.items.find(item => item.id === pendingId) : undefined;
  const title = isEdit ? t('prReview.composer.editTitle') : t('prReview.composer.addTitle');
  const githubEyebrow = parsed ? `${parsed.owner}/${parsed.repo}#${parsed.number}` : '';
  const eyebrow = providerRef ? providerPrRefLabel(providerRef) : githubEyebrow;

  // The scope the overview runs under: the layout publishes the provider
  // scope in context; the GitHub route falls back to the parsed triple, so
  // the GitHub query key is byte-identical to the pre-s6 one.
  const scope = useProviderPrScope(parsed ?? { owner: '', repo: '', number: 0 });

  // Edit mode is local-only: do not fire getPullRequest and do not gate on it.
  // The readiness gate rides the same predicate the provider reads use, so a
  // Bitbucket scope without its organization waits instead of querying.
  const trpc = useTRPC();
  const overviewOptions = useMemo(() => buildPrOverviewQueryOptions(trpc, scope), [trpc, scope]);
  const pr = useQuery({
    ...overviewOptions,
    enabled: parsed !== null && !isEdit && isProviderScopeReady(scope),
  });

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
        prRef={providerRef && providerRef.platform !== 'github' ? providerRef : undefined}
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
        prRef={providerRef && providerRef.platform !== 'github' ? providerRef : undefined}
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

  // A route with no valid comment target is not a broken comment flow: the
  // route failed, nothing the composer could post. The "Add comment" chrome
  // over a "Page not found" body read as a comment sheet that cannot save, so
  // the terminal invalid state renders alone — no misleading title, no lone
  // dismiss chevron — and carries its own Go back to the shared inbox.
  if (!parsed) {
    return <InvalidRouteState backTo="/(app)/pr-review" />;
  }

  let body: ReactNode = null;
  if (isEdit) {
    body = null;
  } else if (pr.isLoading) {
    body = (
      <CenteredState>
        <ActivityIndicator size="small" color={colors.mutedForeground} />
      </CenteredState>
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
      {body}
    </>
  );
}
