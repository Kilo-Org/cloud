import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { ActivityIndicator, Switch, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { openModelPicker } from '@/components/agents/model-selector';
import { BitbucketOverview } from '@/components/code-reviewer/bitbucket-overview';
import {
  buildOverviewRows,
  resolveRowOnPress,
} from '@/components/code-reviewer/platform-overview-rows';
import { ProviderConnectCard } from '@/components/code-reviewer/provider-connect-card';
import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { PLATFORM_CAPABILITIES, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import {
  classifyProviderState,
  PERSONAL_SCOPE,
  useGitHubStatus,
  useGitLabStatus,
  useGitLabWebhookWarning,
  useReviewConfig,
  useReviewerPermission,
  useSaveReviewConfig,
  useToggleReviewer,
} from '@/lib/hooks/use-code-reviewer';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function PlatformOverviewScreen({
  scope,
  platform,
}: Readonly<{ scope: string; platform: ReviewerPlatform }>) {
  const router = useRouter();
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
  const { models, isLoading: modelsLoading } = useAvailableModels(
    scope === PERSONAL_SCOPE ? undefined : scope
  );

  if (permission.status === 'error') {
    return (
      <PlatformErrorScreen
        title={capabilities.label}
        eyebrow="Code Reviewer"
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
      <PlatformErrorScreen
        title={capabilities.label}
        eyebrow="Code Reviewer"
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

  const isLoading =
    providerState.status === 'loading' || config.isLoading || permission.status === 'loading';
  const connected = providerState.status === 'connected';

  // A connected provider whose config fails to load (and has no stale cache
  // to fall back on) has nothing to show — surface a retry instead of a
  // header over blank space. A background refetch failure with data already
  // cached falls through to the normal content below, unaffected.
  if (!isLoading && connected && config.isError && config.data == null) {
    return (
      <PlatformErrorScreen
        title={capabilities.label}
        eyebrow="Code Reviewer"
        onRetry={() => {
          void config.refetch();
        }}
        isRetrying={config.isFetching}
      />
    );
  }

  const pushField = (field: string) => {
    router.push(`/(app)/(tabs)/(3_profile)/code-reviewer/${scope}/${platform}/${field}` as Href);
  };

  const data = config.data;
  // Repositories must actually be in scope before automatic reviews can run
  // "blind" — 'all' mode always qualifies, 'selected' mode needs at least
  // one chosen repo. Only blocks turning the toggle ON; an already-enabled
  // reviewer stays togglable off even if selection later becomes empty.
  const hasRepoSelection =
    data != null &&
    (data.repositorySelectionMode === 'all' || data.selectedRepositoryIds.length > 0);
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
      <ScreenHeader title={capabilities.label} eyebrow="Code Reviewer" />
      <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="pt-4">
        <Animated.View layout={LinearTransition}>
          {isLoading && (
            <Animated.View exiting={FadeOut.duration(150)} className="gap-3">
              <Skeleton className="h-16 w-full rounded-lg" />
              <View className="gap-2">
                {Array.from({ length: 6 }, (_, index) => (
                  <Skeleton key={index} className="h-12 w-full rounded-lg" />
                ))}
              </View>
            </Animated.View>
          )}

          {!isLoading && !connected && (
            <Animated.View entering={FadeIn.duration(200)}>
              {canEdit ? (
                <ProviderConnectCard
                  scope={scope}
                  platform={platform}
                  // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
                  onConnected={() => status.refetch()}
                />
              ) : (
                <Text className="text-center text-xs text-muted-foreground">
                  {capabilities.label} isn't connected. Only organization owners and billing
                  managers can connect it.
                </Text>
              )}
            </Animated.View>
          )}

          {!isLoading && connected && config.data != null && rows != null && (
            <Animated.View entering={FadeIn.duration(200)} className="gap-6">
              {platform === 'gitlab' && hasWebhookSyncWarning && (
                <View className="flex-row items-center justify-between rounded-lg bg-warn-tile-bg p-4">
                  <View className="flex-1 pr-3">
                    <Text className="text-sm font-medium">Webhook setup incomplete</Text>
                    <Text variant="muted" className="text-xs">
                      Some repositories may not receive automatic reviews.
                    </Text>
                  </View>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-row gap-2"
                    disabled={save.isPending}
                    onPress={() => {
                      save.mutate({});
                    }}
                  >
                    {save.isPending ? (
                      <ActivityIndicator size="small" color={colors.mutedForeground} />
                    ) : null}
                    <Text>Retry</Text>
                  </Button>
                </View>
              )}

              <View className="rounded-lg bg-secondary p-4">
                <View className="flex-row items-center justify-between">
                  <View className="flex-1 pr-3">
                    <Text className="text-sm font-medium">Automatic reviews</Text>
                    <Text variant="muted" className="text-xs">
                      {status.data?.integration?.accountLogin ?? ''}
                    </Text>
                  </View>
                  <Switch
                    value={config.data.isEnabled}
                    disabled={
                      !canEdit || toggle.isPending || (!hasRepoSelection && !config.data.isEnabled)
                    }
                    onValueChange={value => {
                      void Haptics.selectionAsync();
                      toggle.mutate({ isEnabled: value });
                    }}
                  />
                </View>
                {!hasRepoSelection && (
                  <View className="mt-3 gap-2 border-t border-hair-soft pt-3">
                    <Text variant="muted" className="text-xs">
                      Select at least one repository to enable automatic reviews.
                    </Text>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canEdit}
                      onPress={() => {
                        pushField('repos');
                      }}
                    >
                      <Text>Select repositories</Text>
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

              {capabilities.reviewMd && (
                <View className="flex-row items-center justify-between rounded-lg bg-secondary p-4">
                  <View className="flex-1 pr-3">
                    <Text className="text-sm font-medium">Follow REVIEW.md</Text>
                    <Text variant="muted" className="text-xs">
                      Honor per-repo REVIEW.md instruction files
                    </Text>
                  </View>
                  <Switch
                    value={!config.data.disableReviewMd}
                    disabled={!canEdit || save.isPending}
                    onValueChange={value => {
                      void Haptics.selectionAsync();
                      save.mutate({ disableReviewMd: !value });
                    }}
                  />
                </View>
              )}

              {!canEdit && (
                <Text className="text-center text-xs text-muted-foreground">
                  Only organization owners and billing managers can change these settings.
                </Text>
              )}
            </Animated.View>
          )}
        </Animated.View>
      </TabScreenScrollView>
    </View>
  );
}
