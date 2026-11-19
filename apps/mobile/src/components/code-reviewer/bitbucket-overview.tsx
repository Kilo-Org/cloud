import { type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';

import { EmptyState, StateAction } from '@/components/empty-state';
import { openModelPicker } from '@/components/agents/model-selector';
import { BitbucketSetupRecovery } from '@/components/code-reviewer/bitbucket-setup-recovery';
import {
  buildOverviewRows,
  resolveRowOnPress,
} from '@/components/code-reviewer/platform-overview-rows';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { QueryError } from '@/components/query-error';
import { ReviewerHeader } from '@/components/code-reviewer/reviewer-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfigureRow } from '@/components/ui/configure-row';
import { GitMerge } from '@/components/ui/icons';
import { RowGroup } from '@/components/ui/row-group';
import { renderRowTrailing } from '@/components/ui/row-trailing';
import { Text } from '@/components/ui/text';
import { PlatformOverviewSkeleton } from '@/components/code-reviewer/platform-overview-skeleton';
import { TabScreenScrollView } from '@/components/tab-screen';
import { bitbucketRepair, classifyBitbucketConnection } from '@/lib/code-reviewer-bitbucket';
import { bitbucketConnectHref } from '@/lib/bitbucket-connect-navigation';
import { useBitbucketIntegrationStatus } from '@/lib/hooks/use-bitbucket';
import { PLATFORM_CAPABILITIES } from '@/lib/code-reviewer-config';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { selectReducedMotionEntrance, useMotionPolicy } from '@/lib/a11y/motion';
import { useQueryBodyState } from '@/lib/hooks/use-query-body-state';
import {
  useBitbucketReadiness,
  type useReviewConfig,
  useSaveReviewConfig,
  type useToggleReviewer,
} from '@/lib/hooks/use-code-reviewer';
import { useReviewerModels } from '@/lib/hooks/use-reviewer-models';

const capabilities = PLATFORM_CAPABILITIES.bitbucket;

export function BitbucketOverview({
  scope,
  config,
  toggle,
  canEdit,
  permissionLoading,
}: Readonly<{
  scope: string;
  config: ReturnType<typeof useReviewConfig>;
  toggle: ReturnType<typeof useToggleReviewer>;
  canEdit: boolean;
  permissionLoading: boolean;
}>) {
  const pushOnce = useSinglePushRoute();
  const { t } = useTranslation();
  const readiness = useBitbucketReadiness(scope);
  // The readiness read describes workspace access tokens only, so the
  // integration status beside it is what tells a Bitbucket OAuth connection
  // apart from a workspace with none.
  const integrationStatus = useBitbucketIntegrationStatus(scope);
  const save = useSaveReviewConfig(scope, 'bitbucket');
  const { models, isLoading: modelsLoading } = useReviewerModels(scope);
  const { reducedMotion } = useMotionPolicy();
  // The body of the config read has exactly one surface: rows from cache, an
  // error with retry, or a loading state -- never the header over an empty
  // scroll area.
  const configBody = useQueryBodyState(config);
  const connection = classifyBitbucketConnection({ readiness, status: integrationStatus });

  if (connection.kind === 'error') {
    return (
      <View className="flex-1 bg-background">
        <ReviewerHeader title={capabilities.label} eyebrow={t('common.codeReviewer')} />
        <QueryError
          variant={connection.variant}
          onRetry={
            connection.permanent
              ? undefined
              : () => {
                  connection.refetch();
                }
          }
          isRetrying={connection.isRetrying}
        />
      </View>
    );
  }

  // An organization connected through Bitbucket OAuth reads as one with no
  // token integration: the connection lives on the web page that ran its
  // consent, so this surface renders read-only — no connect action, no toggle,
  // no config rows, and no repositories button.
  if (connection.kind === 'oauth-connected' || connection.kind === 'oauth-attention') {
    const workspaceName = connection.kind === 'oauth-connected' ? connection.workspace : null;
    return (
      <View className="flex-1 bg-background">
        <ReviewerHeader title={capabilities.label} eyebrow={t('common.codeReviewer')} />
        <TabScreenScrollView className="flex-1" contentContainerClassName="px-6 pt-4">
          <View className="gap-3 rounded-lg bg-secondary p-4">
            <Text className="text-sm font-medium">{capabilities.label}</Text>
            {workspaceName?.displayName ? (
              <Text variant="muted" className="text-xs">
                {workspaceName.displayName}
              </Text>
            ) : null}
            <Text variant="muted" className="text-sm">
              {t('codeReviewer.bitbucketConnect.managedOnWeb')}
            </Text>
          </View>
        </TabScreenScrollView>
      </View>
    );
  }

  const isLoading = connection.kind === 'loading' || permissionLoading;
  const connected = connection.kind === 'token-connected';

  // A connected workspace whose config read failed (no cache to fall back on),
  // or whose idle read could not be restarted, has nothing to show: surface a
  // retry instead. Cached config keeps the rows through a background refetch
  // failure, and an unsettled connectivity still waits on the skeleton.
  if (!isLoading && connected && (configBody.body.status === 'error' || configBody.exhausted)) {
    return (
      <View className="flex-1 bg-background">
        <ReviewerHeader title={capabilities.label} eyebrow={t('common.codeReviewer')} />
        <QueryError
          variant={configBody.body.status === 'error' ? configBody.body.variant : 'server'}
          onRetry={configBody.body.status === 'error' ? configBody.body.refetch : configBody.retry}
          isRetrying={config.isFetching}
        />
      </View>
    );
  }

  if (!isLoading && !connected) {
    const readinessData = readiness.data;
    // The state is the screen's whole surface, so its action carries the repair
    // the readiness read names: a first connection or a replaced token. A reader
    // the role rule refuses gets the sentence naming who can connect instead of
    // a press it cannot finish.
    const repair = readinessData === undefined ? null : bitbucketRepair(readinessData);
    return (
      <View className="flex-1 bg-background">
        <ReviewerHeader title={capabilities.label} eyebrow={t('common.codeReviewer')} />
        <EmptyState
          icon={GitMerge}
          iconSize={28}
          title={t('prReview.connect.bitbucketNotConnectedTitle')}
          description={
            canEdit && readinessData
              ? t('codeReviewer.bitbucketConnect.description')
              : t('codeReviewer.bitbucket.notConnectedReadOnly')
          }
          action={
            canEdit && repair !== null ? (
              <StateAction
                label={
                  repair.kind === 'replace-token'
                    ? t('prReview.connect.reconnectTitleBitbucket')
                    : t('common.connectBitbucket')
                }
                icon={GitMerge}
                onPress={() => {
                  pushOnce(bitbucketConnectHref(scope));
                }}
              />
            ) : undefined
          }
        />
      </View>
    );
  }

  const pushField = (field: string) => {
    pushOnce(`/(app)/code-reviewer/${scope}/bitbucket/${field}` as Href);
  };

  const data = config.data;
  // Same gating as GitHub/GitLab (T5.5): a workspace that isn't fully ready,
  // or has no repositories in scope, must not be flipped on blind. Only
  // blocks turning the toggle ON.
  const hasRepoSelection =
    data != null &&
    (data.repositorySelectionMode === 'all' || data.selectedRepositoryIds.length > 0);
  const isReady = readiness.data?.ready !== false;
  const canEnableAutoReview = hasRepoSelection && isReady;
  // The workspace line under the Automatic reviews label is optional: a
  // readiness read without a workspace slug paints the label alone, so the row
  // keeps one line and matches the sibling Follow REVIEW.md row.
  const autoReviewsWorkspace = readiness.data?.workspace?.slug;
  const rows =
    data == null
      ? null
      : buildOverviewRows({
          data,
          capabilities,
          models,
          modelsLoading,
          onOpenModelPicker: () => {
            openModelPicker(pushOnce, {
              options: models,
              value: data.modelSlug,
              variant: data.thinkingEffort ?? '',
              acceptsVariant: true,
              onSelect: (modelSlug, variant) => {
                save.mutate({ modelSlug, thinkingEffort: variant || null });
              },
            });
          },
        });

  return (
    <View className="flex-1 bg-background">
      <ReviewerHeader title={capabilities.label} eyebrow={t('common.codeReviewer')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        keyboardShouldPersistTaps="handled"
      >
        <Animated.View layout={LinearTransition}>
          {/* Every read state paints something: while connectivity is unsettled a
             paused read keeps the skeleton, and a pending read that nothing is
             fetching also keeps it until its restart runs. */}
          {(isLoading || configBody.body.status === 'loading') && <PlatformOverviewSkeleton />}

          {!isLoading && data != null && rows != null && (
            <Animated.View
              entering={selectReducedMotionEntrance(reducedMotion, FadeIn.duration(200))}
              className="gap-6"
            >
              {readiness.data?.ready === false && (
                <BitbucketSetupRecovery
                  scope={scope}
                  readiness={readiness.data}
                  message={t('common.couldNotLoadRepositories')}
                />
              )}

              <Card>
                <View className="flex-row items-center justify-between">
                  <View className="flex-1 pe-3">
                    <Text className="text-sm font-medium">{t('codeReviewer.autoReviews')}</Text>
                    {autoReviewsWorkspace ? (
                      <Text variant="muted" className="text-xs">
                        {autoReviewsWorkspace}
                      </Text>
                    ) : null}
                  </View>
                  {renderRowTrailing({
                    kind: 'switch',
                    accessibilityLabel: t('codeReviewer.autoReviews'),
                    value: config.data.isEnabled,
                    disabled:
                      !canEdit ||
                      toggle.isPending ||
                      (!canEnableAutoReview && !config.data.isEnabled),
                    onValueChange: value => {
                      toggle.mutate({ isEnabled: value });
                    },
                  })}
                </View>
                {isReady && !hasRepoSelection && (
                  <View className="gap-2 border-t-[0.5px] border-hair-soft pt-3">
                    <Text variant="muted" className="text-xs">
                      {t('codeReviewer.selectRepository')}
                    </Text>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canEdit}
                      onPress={() => {
                        pushField('repos');
                      }}
                    >
                      <Text>{t('common.selectRepositories')}</Text>
                    </Button>
                  </View>
                )}
              </Card>

              <RowGroup leadingTile>
                {rows.map(row => (
                  <ConfigureRow
                    key={row.field}
                    icon={row.icon}
                    title={row.title}
                    subtitle={row.subtitle}
                    onPress={resolveRowOnPress(row, canEdit, pushField)}
                  />
                ))}
              </RowGroup>

              {!canEdit && (
                <Text className="text-center text-xs text-muted-foreground">
                  {t('securityAgent.sla.permissionNote')}
                </Text>
              )}
            </Animated.View>
          )}
        </Animated.View>
      </TabScreenScrollView>
    </View>
  );
}
