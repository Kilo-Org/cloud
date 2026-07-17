import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { Switch, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

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
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView, useTabBarBottomPadding } from '@/components/tab-screen';
import { PLATFORM_CAPABILITIES } from '@/lib/code-reviewer-config';
import { WEB_BASE_URL } from '@/lib/config';
import { openExternalUrl } from '@/lib/external-link';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import {
  classifyProviderState,
  useBitbucketReadiness,
  type useReviewConfig,
  useSaveReviewConfig,
  type useToggleReviewer,
} from '@/lib/hooks/use-code-reviewer';
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
  const paddingBottom = useTabBarBottomPadding();
  const readiness = useBitbucketReadiness(scope);
  const save = useSaveReviewConfig(scope, 'bitbucket');
  const { models, isLoading: modelsLoading } = useAvailableModels(scope);
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
        <ScreenHeader title={capabilities.label} eyebrow="Code Reviewer" />
        <View className="flex-1" style={{ paddingBottom }}>
          <QueryError
            onRetry={() => {
              providerState.refetch();
            }}
            isRetrying={providerState.isRetrying}
          />
        </View>
      </View>
    );
  }

  const isLoading = providerState.status === 'loading' || config.isLoading || permissionLoading;
  const connected = providerState.status === 'connected';

  // A connected workspace whose config fails to load (and has no stale
  // cache to fall back on) has nothing to show — surface a retry instead of
  // a header over blank space. A background refetch failure with data
  // already cached falls through to the normal content below, unaffected.
  if (!isLoading && connected && config.isError && config.data == null) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={capabilities.label} eyebrow="Code Reviewer" />
        <View className="flex-1" style={{ paddingBottom }}>
          <QueryError
            onRetry={() => {
              void config.refetch();
            }}
            isRetrying={config.isFetching}
          />
        </View>
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
      <ScreenHeader title={capabilities.label} eyebrow="Code Reviewer" />
      <TabScreenScrollView
        className="flex-1 px-6"
        contentContainerClassName="pt-4"
        keyboardShouldPersistTaps="handled"
      >
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
                <BitbucketConnectForm scope={scope} />
              ) : (
                <Text className="text-center text-xs text-muted-foreground">
                  Bitbucket isn't connected. Only organization owners and billing managers can
                  connect it.
                </Text>
              )}
            </Animated.View>
          )}

          {!isLoading && connected && config.data != null && rows != null && (
            <Animated.View entering={FadeIn.duration(200)} className="gap-6">
              {readiness.data?.ready === false && (
                <View className="items-center gap-2 rounded-lg bg-secondary p-4">
                  <Text className="text-center text-xs text-muted-foreground">
                    Setup incomplete — finish configuration on kilo.ai
                  </Text>
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={() => {
                      void openExternalUrl(getBitbucketIntegrationUrl(WEB_BASE_URL, scope), {
                        label: 'Bitbucket setup',
                      });
                    }}
                  >
                    <Text>Finish setup</Text>
                  </Button>
                </View>
              )}

              <View className="rounded-lg bg-secondary p-4">
                <View className="flex-row items-center justify-between">
                  <View className="flex-1 pr-3">
                    <Text className="text-sm font-medium">Automatic reviews</Text>
                    <Text variant="muted" className="text-xs">
                      {readiness.data?.workspace?.slug ?? ''}
                    </Text>
                  </View>
                  <Switch
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
