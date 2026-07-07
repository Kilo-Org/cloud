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

import { GitHubConnectCard } from '@/components/code-reviewer/github-connect-card';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  useCanEditReviewer,
  useGitHubStatus,
  useReviewConfig,
  useSaveReviewConfig,
  useToggleReviewer,
} from '@/lib/hooks/use-code-reviewer';

export function ScopeOverviewScreen({ scope }: Readonly<{ scope: string }>) {
  const router = useRouter();
  const status = useGitHubStatus(scope);
  const config = useReviewConfig(scope);
  const toggle = useToggleReviewer(scope);
  const save = useSaveReviewConfig(scope);
  const canEdit = useCanEditReviewer(scope);

  const isLoading = status.isLoading || config.isLoading;
  const connected = status.data?.connected === true;

  const pushField = (field: string) => {
    router.push(`/(app)/(tabs)/(3_profile)/code-reviewer/${scope}/github/${field}` as Href);
  };

  const rows =
    config.data == null
      ? null
      : ([
          {
            field: 'style',
            icon: MessageSquareText,
            title: 'Review Style',
            subtitle: config.data.reviewStyle,
          },
          {
            field: 'focus-areas',
            icon: ShieldCheck,
            title: 'Focus Areas',
            subtitle:
              config.data.focusAreas.length > 0 ? config.data.focusAreas.join(', ') : 'All areas',
          },
          {
            field: 'instructions',
            icon: ScrollText,
            title: 'Custom Instructions',
            subtitle: config.data.customInstructions ? 'Set' : 'None',
          },
          { field: 'model', icon: FileSliders, title: 'Model', subtitle: config.data.modelSlug },
          {
            field: 'gate',
            icon: Gauge,
            title: 'Merge Gate',
            subtitle: config.data.gateThreshold,
          },
          {
            field: 'repos',
            icon: FolderGit2,
            title: 'Repositories',
            subtitle:
              config.data.repositorySelectionMode === 'all'
                ? 'All repositories'
                : `${config.data.selectedRepositoryIds.length} selected`,
          },
        ] as const);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="GitHub" eyebrow="Code Reviewer" />
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
              <GitHubConnectCard
                scope={scope}
                // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
                onConnected={() => status.refetch()}
              />
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
                    onPress={
                      canEdit
                        ? () => {
                            pushField(row.field);
                          }
                        : undefined
                    }
                  />
                ))}
              </View>

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
