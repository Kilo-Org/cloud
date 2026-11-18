/* eslint-disable max-lines -- One reviewer overview: each read state (loading, connect, error, ready) returns its own surface, and the ready branch's row config is the picker call plus the toggle wiring. */
import { type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';

import { openModelPicker } from '@/components/agents/model-selector';
import { ActionRequiredBanner } from '@/components/code-reviewer/action-required-banner';
import { BitbucketOverview } from '@/components/code-reviewer/bitbucket-overview';
import { connectNoticeKey } from '@/components/code-reviewer/connect-notice-key';
import {
  buildOverviewRows,
  resolveRowOnPress,
} from '@/components/code-reviewer/platform-overview-rows';
import { ProviderConnectState } from '@/components/code-reviewer/provider-connect-state';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { ReviewerErrorScreen } from '@/components/code-reviewer/reviewer-error-screen';
import { PlatformOverviewSkeleton } from '@/components/code-reviewer/platform-overview-skeleton';
import { ReviewerHeader } from '@/components/code-reviewer/reviewer-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfigureRow } from '@/components/ui/configure-row';
import { PreferenceRow } from '@/components/ui/preference-row';
import { RowGroup } from '@/components/ui/row-group';
import { renderRowTrailing } from '@/components/ui/row-trailing';
import { Text } from '@/components/ui/text';
import { Bot, ScrollText } from '@/components/ui/icons';
import { TabScreenScrollView } from '@/components/tab-screen';
import { PLATFORM_CAPABILITIES, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { canConnectProvider } from '@/lib/code-reviewer-status';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { selectReducedMotionEntrance, useMotionPolicy } from '@/lib/a11y/motion';
import { useQueryBodyState } from '@/lib/hooks/use-query-body-state';
import {
  classifyProviderState,
  useGitHubStatus,
  useGitLabStatus,
  useGitLabWebhookWarning,
  useReviewConfig,
  useReviewerPermission,
  useSaveReviewConfig,
  useToggleReviewer,
} from '@/lib/hooks/use-code-reviewer';
import { useCouncilUiEnabled } from '@/lib/hooks/use-reviewer-council';
import { useReviewerModels } from '@/lib/hooks/use-reviewer-models';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function PlatformOverviewScreen({
  scope,
  platform,
}: Readonly<{ scope: string; platform: ReviewerPlatform }>) {
  const pushOnce = useSinglePushRoute();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const capabilities = PLATFORM_CAPABILITIES[platform];
  const githubStatus = useGitHubStatus(scope);
  const gitlabStatus = useGitLabStatus(scope);
  const config = useReviewConfig(scope, platform);
  const toggle = useToggleReviewer(scope, platform);
  const save = useSaveReviewConfig(scope, platform);
  const permission = useReviewerPermission(scope);
  const canEdit = permission.status === 'ready' && permission.canEdit;
  const { hasWebhookSyncWarning } = useGitLabWebhookWarning(scope, platform);
  const { models, isLoading: modelsLoading } = useReviewerModels(scope);
  const councilUiEnabled = useCouncilUiEnabled(scope);
  const { reducedMotion } = useMotionPolicy();
  // The body of the config read has exactly one surface: rows from cache, an
  // error with retry, or a loading state. Bitbucket renders its own overview,
  // which owns its restart, so this screen must not run a second one.
  const configBody = useQueryBodyState(config, { restartable: platform !== 'bitbucket' });

  if (permission.status === 'error') {
    return (
      <ReviewerErrorScreen
        title={capabilities.label}
        eyebrow={t('common.codeReviewer')}
        onRetry={() => {
          permission.refetch();
        }}
        isRetrying={permission.isRetrying}
      />
    );
  }

  if (platform === 'bitbucket') {
    return (
      <BitbucketOverview
        scope={scope}
        config={config}
        toggle={toggle}
        canEdit={canEdit}
        permissionLoading={permission.status === 'loading'}
      />
    );
  }

  const status = platform === 'gitlab' ? gitlabStatus : githubStatus;
  const providerState = classifyProviderState({
    isLoading: status.isLoading,
    isError: status.isError,
    isFetching: status.isFetching,
    connected: status.data?.connected,
    hasData: status.data !== undefined,
    refetch: () => void status.refetch(),
    errorCode: (status.error as { data?: { code?: string } } | null)?.data?.code,
  });

  if (providerState.status === 'error') {
    return (
      <ReviewerErrorScreen
        title={capabilities.label}
        eyebrow={t('common.codeReviewer')}
        variant={providerState.variant}
        // A permission/not-found error can't be fixed by retrying — hide retry.
        onRetry={
          providerState.permanent
            ? undefined
            : () => {
                providerState.refetch();
              }
        }
        isRetrying={providerState.isRetrying}
      />
    );
  }

  const isLoading = providerState.status === 'loading' || permission.status === 'loading';
  const connected = providerState.status === 'connected';
  // The account line under the Automatic reviews label is optional: a provider
  // that reports no login paints the label alone, so the row keeps one line and
  // matches the sibling Follow REVIEW.md row.
  const autoReviewsAccount = status.data?.integration?.accountLogin;

  // A connected provider whose config read failed (no cache to fall back on),
  // or whose idle read could not be restarted, has nothing to show: surface a
  // retry instead. Cached config keeps the rows through a background refetch
  // failure, and an unsettled connectivity still waits on the skeleton.
  if (!isLoading && connected && (configBody.body.status === 'error' || configBody.exhausted)) {
    return (
      <ReviewerErrorScreen
        title={capabilities.label}
        eyebrow={t('common.codeReviewer')}
        variant={configBody.body.status === 'error' ? configBody.body.variant : 'server'}
        onRetry={configBody.body.status === 'error' ? configBody.body.refetch : configBody.retry}
        isRetrying={config.isFetching}
      />
    );
  }

  const handleConnected = status.refetch;
  if (!isLoading && !connected) {
    // The connect state installs the provider's app for the scope, which is a
    // narrower capability than editing the reviewer settings (see
    // `canConnectProvider`): the state must follow the install rule, not
    // `canEdit`.
    const canConnect = canConnectProvider(platform, permission);
    return (
      <View className="flex-1 bg-background">
        <ReviewerHeader title={capabilities.label} eyebrow={t('common.codeReviewer')} />
        <ProviderConnectState
          scope={scope}
          platform={platform}
          notice={
            canConnect ? undefined : t(connectNoticeKey(platform), { platform: capabilities.label })
          }
          onConnected={handleConnected}
        />
      </View>
    );
  }

  const pushField = (field: string) => {
    pushOnce(`/(app)/code-reviewer/${scope}/${platform}/${field}` as Href);
  };

  // The classification owns the body state, so the rows are built from the
  // data it classified as present.
  const data = configBody.body.status === 'ready' ? config.data : undefined;
  // Repositories must actually be in scope before automatic reviews can run
  // "blind" — 'all' mode always qualifies, 'selected' mode needs at least
  // one chosen repo. Only blocks turning the toggle ON; an already-enabled
  // reviewer stays togglable off even if selection later becomes empty.
  const hasRepoSelection =
    data != null &&
    (data.repositorySelectionMode === 'all' || data.selectedRepositoryIds.length > 0);
  const openReviewerModelPicker = () => {
    if (data == null) {
      return;
    }
    openModelPicker(pushOnce, {
      options: models,
      value: data.modelSlug,
      variant: data.thinkingEffort ?? '',
      acceptsVariant: true,
      onSelect: (modelSlug, variant) => {
        save.mutate({ modelSlug, thinkingEffort: variant || null });
      },
    });
  };

  const rows =
    data == null
      ? null
      : buildOverviewRows({
          data,
          capabilities,
          models,
          modelsLoading,
          onOpenModelPicker: openReviewerModelPicker,
          onOpenReviewMemory:
            platform === 'github'
              ? () => {
                  pushOnce(`/(app)/code-reviewer/${scope}/review-memory` as Href);
                }
              : undefined,
          onOpenCouncil:
            capabilities.council && councilUiEnabled
              ? () => {
                  pushField('council');
                }
              : undefined,
        });

  return (
    <View className="flex-1 bg-background">
      <ReviewerHeader title={capabilities.label} eyebrow={t('common.codeReviewer')} />
      <TabScreenScrollView className="flex-1" contentContainerClassName={SCREEN_BODY_CLASS}>
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
              {platform === 'gitlab' && hasWebhookSyncWarning && (
                <View className="flex-row items-center justify-between rounded-xl bg-warn-tile-bg p-4">
                  <View className="flex-1 pe-3">
                    <Text className="text-sm font-medium">{t('codeReviewer.webhookSetup')}</Text>
                    <Text variant="muted" className="text-xs">
                      {t('codeReviewer.webhookSetupDescription')}
                    </Text>
                  </View>
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(STATE_ACTION_CLASS, 'flex-row gap-2')}
                    disabled={!canEdit || save.isPending}
                    onPress={() => {
                      // The PATCH routers re-sync project hooks only for a
                      // patch that carries the repository selection, so the
                      // retry re-sends the current one. An empty patch neither
                      // syncs nor proves the hooks healthy.
                      save.mutate({ selectedRepositoryIds: data.selectedRepositoryIds });
                    }}
                  >
                    {save.isPending ? (
                      <ActivityIndicator size="small" color={colors.mutedForeground} />
                    ) : null}
                    <Text>{t('common.retry')}</Text>
                  </Button>
                </View>
              )}

              {data.actionRequired != null && (
                <ActionRequiredBanner
                  scope={scope}
                  reason={data.actionRequired.reason}
                  canEdit={canEdit}
                  onRefreshConfig={() => void config.refetch()}
                  onOpenModelPicker={openReviewerModelPicker}
                />
              )}

              <Card>
                <View className="flex-row items-center justify-between">
                  <View className="flex-1 pe-3">
                    <Text className="text-sm font-medium">{t('codeReviewer.autoReviews')}</Text>
                    {autoReviewsAccount ? (
                      <Text variant="muted" className="text-xs">
                        {autoReviewsAccount}
                      </Text>
                    ) : null}
                  </View>
                  {renderRowTrailing({
                    kind: 'switch',
                    accessibilityLabel: t('codeReviewer.autoReviews'),
                    value: data.isEnabled,
                    disabled:
                      !canEdit || toggle.isPending || (!hasRepoSelection && !data.isEnabled),
                    onValueChange: value => {
                      toggle.mutate({ isEnabled: value });
                    },
                  })}
                </View>
                {!hasRepoSelection && (
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

              {/* Every platform that reaches this body offers the review-md
                  setting; the bot-detection row exists on GitHub only, whose
                  webhooks carry the user type GitLab's do not. */}
              <RowGroup leadingTile>
                <PreferenceRow
                  icon={ScrollText}
                  title={t('codeReviewer.followReviewMd')}
                  subtitle={t('codeReviewer.followReviewMdSubtitle')}
                  value={!data.disableReviewMd}
                  disabled={!canEdit || save.isPending}
                  onValueChange={value => {
                    save.mutate({ disableReviewMd: !value });
                  }}
                />
                {capabilities.skipBotPullRequests && (
                  <PreferenceRow
                    icon={Bot}
                    title={t('codeReviewer.skipBotPullRequests.title')}
                    subtitle={t('codeReviewer.skipBotPullRequests.subtitle')}
                    value={data.skipBotPullRequests}
                    disabled={!canEdit || save.isPending}
                    onValueChange={value => {
                      save.mutate({ skipBotPullRequests: value });
                    }}
                  />
                )}
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
