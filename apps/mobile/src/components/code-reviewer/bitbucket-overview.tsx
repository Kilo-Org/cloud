import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Switch, View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';

import { CenteredState } from '@/components/centered-state';
import { openModelPicker } from '@/components/agents/model-selector';
import { BitbucketConnectForm } from '@/components/code-reviewer/bitbucket-connect-form';
import {
  buildOverviewRows,
  resolveRowOnPress,
} from '@/components/code-reviewer/platform-overview-rows';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Text } from '@/components/ui/text';
import { PlatformOverviewSkeleton } from '@/components/code-reviewer/platform-overview-skeleton';
import { TabScreenScrollView } from '@/components/tab-screen';
import { PLATFORM_CAPABILITIES } from '@/lib/code-reviewer-config';
import { useReviewConfigBody } from '@/lib/hooks/use-review-config-body';
import { WEB_BASE_URL } from '@/lib/config';
import { openExternalUrl } from '@/lib/external-link';
import {
  classifyProviderState,
  useBitbucketReadiness,
  type useReviewConfig,
  useSaveReviewConfig,
  type useToggleReviewer,
} from '@/lib/hooks/use-code-reviewer';
import { useReviewerModels } from '@/lib/hooks/use-reviewer-models';
import { getBitbucketIntegrationUrl } from '@/lib/integration-urls';

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
  const router = useRouter();
  const { t } = useTranslation();
  const readiness = useBitbucketReadiness(scope);
  const save = useSaveReviewConfig(scope, 'bitbucket');
  const { models, isLoading: modelsLoading } = useReviewerModels(scope);
  // The body of the config read has exactly one surface: rows from cache, an
  // error with retry, or a loading state -- never the header over an empty
  // scroll area.
  const configBody = useReviewConfigBody(config);
  const providerState = classifyProviderState({
    isLoading: readiness.isLoading,
    isError: readiness.isError,
    isFetching: readiness.isFetching,
    connected: readiness.data?.connected,
    hasData: readiness.data !== undefined,
    refetch: () => void readiness.refetch(),
  });

  if (providerState.status === 'error') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={capabilities.label} eyebrow={t('common.codeReviewer')} />
        <QueryError
          onRetry={() => {
            providerState.refetch();
          }}
          isRetrying={providerState.isRetrying}
        />
      </View>
    );
  }

  const isLoading = providerState.status === 'loading' || permissionLoading;
  const connected = providerState.status === 'connected';

  // A connected workspace whose config read failed (no cache to fall back on),
  // or whose idle read could not be restarted, has nothing to show: surface a
  // retry instead. Cached config keeps the rows through a background refetch
  // failure, and an unsettled connectivity still waits on the skeleton.
  if (!isLoading && connected && (configBody.body.status === 'error' || configBody.exhausted)) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={capabilities.label} eyebrow={t('common.codeReviewer')} />
        <QueryError
          variant={configBody.body.status === 'error' ? configBody.body.variant : 'server'}
          onRetry={configBody.body.status === 'error' ? configBody.body.refetch : configBody.retry}
          isRetrying={config.isFetching}
        />
      </View>
    );
  }

  if (!isLoading && !connected) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={capabilities.label} eyebrow={t('common.codeReviewer')} />
        <CenteredState contentContainerClassName="px-6">
          {canEdit ? (
            <BitbucketConnectForm scope={scope} />
          ) : (
            <Text className="text-center text-xs text-muted-foreground">
              {t('codeReviewer.bitbucket.notConnectedReadOnly')}
            </Text>
          )}
        </CenteredState>
      </View>
    );
  }

  const pushField = (field: string) => {
    router.push(`/(app)/(tabs)/(3_profile)/code-reviewer/${scope}/bitbucket/${field}` as Href);
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
  const rows =
    data == null
      ? null
      : buildOverviewRows({
          data,
          capabilities,
          models,
          modelsLoading,
          onOpenModelPicker: () => {
            openModelPicker(router, {
              options: models,
              value: data.modelSlug,
              variant: data.thinkingEffort ?? '',
              onSelect: (modelSlug, variant) => {
                save.mutate({ modelSlug, thinkingEffort: variant || null });
              },
            });
          },
        });

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={capabilities.label} eyebrow={t('common.codeReviewer')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="px-6 pt-4"
        keyboardShouldPersistTaps="handled"
      >
        <Animated.View layout={LinearTransition}>
          {/* Every read state paints something: while connectivity is unsettled a
             paused read keeps the skeleton, and a pending read that nothing is
             fetching also keeps it until its restart runs. */}
          {(isLoading || configBody.body.status === 'loading') && <PlatformOverviewSkeleton />}

          {!isLoading && data != null && rows != null && (
            <Animated.View entering={FadeIn.duration(200)} className="gap-6">
              {readiness.data?.ready === false && (
                <View className="items-center gap-2 rounded-lg bg-secondary p-4">
                  <Text className="text-center text-xs text-muted-foreground">
                    {t('codeReviewer.bitbucket.setupIncomplete')}
                  </Text>
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={() => {
                      void openExternalUrl(getBitbucketIntegrationUrl(WEB_BASE_URL, scope), {
                        label: t('codeReviewer.bitbucket.setup'),
                      });
                    }}
                  >
                    <Text>{t('codeReviewer.repos.finishSetup')}</Text>
                  </Button>
                </View>
              )}

              <View className="rounded-lg bg-secondary p-4">
                <View className="flex-row items-center justify-between">
                  <View className="flex-1 pr-3">
                    <Text className="text-sm font-medium">{t('codeReviewer.autoReviews')}</Text>
                    <Text variant="muted" className="text-xs">
                      {readiness.data?.workspace?.slug ?? ''}
                    </Text>
                  </View>
                  <Switch
                    accessibilityLabel={t('codeReviewer.autoReviews')}
                    value={config.data.isEnabled}
                    disabled={
                      !canEdit ||
                      toggle.isPending ||
                      (!canEnableAutoReview && !config.data.isEnabled)
                    }
                    onValueChange={value => {
                      void Haptics.selectionAsync();
                      toggle.mutate({ isEnabled: value });
                    }}
                  />
                </View>
                {isReady && !hasRepoSelection && (
                  <View className="mt-3 gap-2 border-t border-hair-soft pt-3">
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
              </View>

              <View>
                {rows.map((row, index) => (
                  <ConfigureRow
                    key={row.field}
                    icon={row.icon}
                    title={row.title}
                    subtitle={row.subtitle}
                    last={index === rows.length - 1}
                    onPress={resolveRowOnPress(row, canEdit, pushField)}
                  />
                ))}
              </View>

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
