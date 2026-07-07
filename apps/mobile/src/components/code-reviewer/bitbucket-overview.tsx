import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import {
  FileSliders,
  FolderGit2,
  MessageSquareText,
  ScrollText,
  ShieldCheck,
} from 'lucide-react-native';
import { ScrollView, Switch, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { BitbucketConnectForm } from '@/components/code-reviewer/bitbucket-connect-form';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { PLATFORM_CAPABILITIES } from '@/lib/code-reviewer-config';
import {
  useBitbucketReadiness,
  type useReviewConfig,
  type useToggleReviewer,
} from '@/lib/hooks/use-code-reviewer';

const capabilities = PLATFORM_CAPABILITIES.bitbucket;

export function BitbucketOverview({
  scope,
  config,
  toggle,
  canEdit,
}: Readonly<{
  scope: string;
  config: ReturnType<typeof useReviewConfig>;
  toggle: ReturnType<typeof useToggleReviewer>;
  canEdit: boolean;
}>) {
  const router = useRouter();
  const readiness = useBitbucketReadiness(scope);
  const isLoading = readiness.isLoading || config.isLoading;
  const connected = readiness.data?.connected === true;

  const pushField = (field: string) => {
    router.push(`/(app)/(tabs)/(3_profile)/code-reviewer/${scope}/bitbucket/${field}` as Href);
  };

  const rows =
    config.data == null
      ? null
      : [
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
            field: 'repos',
            icon: FolderGit2,
            title: 'Repositories',
            subtitle: `${config.data.selectedRepositoryIds.length} selected`,
          },
        ];

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={capabilities.label} eyebrow="Code Reviewer" />
      <ScrollView
        className="flex-1 px-6"
        contentContainerClassName="pt-4 pb-8"
        keyboardShouldPersistTaps="handled"
      >
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
                <Text className="text-center text-xs text-muted-foreground">
                  Setup incomplete — finish configuration on kilo.ai
                </Text>
              )}

              <View className="flex-row items-center justify-between rounded-lg bg-secondary p-4">
                <View className="flex-1 pr-3">
                  <Text className="text-sm font-medium">Automatic reviews</Text>
                  <Text variant="muted" className="text-xs">
                    {readiness.data?.workspace?.slug ?? ''}
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
