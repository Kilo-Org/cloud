import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import {
  FileSliders,
  FolderGit2,
  Gauge,
  MessageSquareText,
  ScrollText,
  ShieldCheck,
} from 'lucide-react-native';
import { ScrollView, Switch, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { openModelPicker } from '@/components/agents/model-selector';
import { BitbucketOverview } from '@/components/code-reviewer/bitbucket-overview';
import { ProviderConnectCard } from '@/components/code-reviewer/provider-connect-card';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { PLATFORM_CAPABILITIES, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import {
  PERSONAL_SCOPE,
  useCanEditReviewer,
  useGitHubStatus,
  useGitLabStatus,
  useReviewConfig,
  useSaveReviewConfig,
  useToggleReviewer,
} from '@/lib/hooks/use-code-reviewer';

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export function PlatformOverviewScreen({
  scope,
  platform,
}: Readonly<{ scope: string; platform: ReviewerPlatform }>) {
  const router = useRouter();
  const githubStatus = useGitHubStatus(scope);
  const gitlabStatus = useGitLabStatus(scope);
  const config = useReviewConfig(scope, platform);
  const toggle = useToggleReviewer(scope, platform);
  const save = useSaveReviewConfig(scope, platform);
  const canEdit = useCanEditReviewer(scope);
  const { models, isLoading: modelsLoading } = useAvailableModels(
    scope === PERSONAL_SCOPE ? undefined : scope
  );

  if (platform === 'bitbucket' && scope === PERSONAL_SCOPE) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Bitbucket" eyebrow="Code Reviewer" />
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-sm text-muted-foreground">
            Bitbucket is available for organizations only.
          </Text>
        </View>
      </View>
    );
  }

  if (platform === 'bitbucket') {
    return <BitbucketOverview scope={scope} config={config} toggle={toggle} canEdit={canEdit} />;
  }

  const capabilities = PLATFORM_CAPABILITIES[platform];
  const status = platform === 'gitlab' ? gitlabStatus : githubStatus;
  const isLoading = status.isLoading || config.isLoading;
  const connected = status.data?.connected === true;

  const pushField = (field: string) => {
    router.push(`/(app)/(tabs)/(3_profile)/code-reviewer/${scope}/${platform}/${field}` as Href);
  };

  const data = config.data;
  const rows =
    data == null
      ? null
      : [
          {
            field: 'style',
            icon: MessageSquareText,
            title: 'Review Style',
            subtitle: capitalize(data.reviewStyle),
          },
          {
            field: 'focus-areas',
            icon: ShieldCheck,
            title: 'Focus Areas',
            subtitle:
              data.focusAreas.length > 0 ? data.focusAreas.map(capitalize).join(', ') : 'All areas',
          },
          {
            field: 'instructions',
            icon: ScrollText,
            title: 'Custom Instructions',
            subtitle: data.customInstructions ? 'Set' : 'None',
          },
          {
            field: 'model',
            icon: FileSliders,
            title: 'Model',
            subtitle: models.find(model => model.id === data.modelSlug)?.name ?? data.modelSlug,
            onPress:
              modelsLoading || models.length === 0
                ? undefined
                : () => {
                    openModelPicker(router, {
                      options: models,
                      value: data.modelSlug,
                      variant: data.thinkingEffort ?? '',
                      onSelect: (modelSlug, variant) => {
                        save.mutate({ modelSlug, thinkingEffort: variant || null });
                      },
                    });
                  },
          },
          ...(capabilities.gateRow
            ? [
                {
                  field: 'gate',
                  icon: Gauge,
                  title: 'Merge Gate',
                  subtitle: capitalize(data.gateThreshold),
                },
              ]
            : []),
          {
            field: 'repos',
            icon: FolderGit2,
            title: 'Repositories',
            subtitle:
              capabilities.selectionModePicker && data.repositorySelectionMode === 'all'
                ? 'All repositories'
                : `${data.selectedRepositoryIds.length} selected`,
          },
        ];

  const resolveRowOnPress = (row: NonNullable<typeof rows>[number]) => {
    if (!canEdit) {
      return undefined;
    }
    if ('onPress' in row) {
      return row.onPress;
    }
    return () => {
      pushField(row.field);
    };
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={capabilities.label} eyebrow="Code Reviewer" />
      <ScrollView className="flex-1 px-6" contentContainerClassName="pt-4 pb-8">
        <Animated.View layout={LinearTransition}>
          {isLoading && (
            <Animated.View exiting={FadeOut.duration(150)} className="gap-3">
              <Skeleton className="h-32 w-full rounded-lg" />
              <Skeleton className="h-12 w-full rounded-lg" />
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
              <View className="flex-row items-center justify-between rounded-lg bg-secondary p-4">
                <View className="flex-1 pr-3">
                  <Text className="text-sm font-medium">Automatic reviews</Text>
                  <Text variant="muted" className="text-xs">
                    {status.data?.integration?.accountLogin ?? ''}
                  </Text>
                </View>
                <Switch
                  value={config.data.isEnabled}
                  disabled={!canEdit || toggle.isPending}
                  onValueChange={value => {
                    void Haptics.selectionAsync();
                    toggle.mutate({ isEnabled: value });
                  }}
                />
              </View>

              <View>
                {rows.map((row, index) => (
                  <ConfigureRow
                    key={row.field}
                    icon={row.icon}
                    title={row.title}
                    subtitle={row.subtitle}
                    last={index === rows.length - 1}
                    onPress={resolveRowOnPress(row)}
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
      </ScrollView>
    </View>
  );
}
