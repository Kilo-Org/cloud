import * as Haptics from 'expo-haptics';
import { useLocalSearchParams } from 'expo-router';
import { Check } from 'lucide-react-native';
import { Pressable, ScrollView, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { asReviewerPlatform } from '@/lib/code-reviewer-config';
import {
  PERSONAL_SCOPE,
  useReviewConfig,
  useSaveReviewConfig,
} from '@/lib/hooks/use-code-reviewer';
import { thinkingEffortLabel, useAvailableModels } from '@/lib/hooks/use-available-models';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export default function ModelRoute() {
  const { scope, platform: rawPlatform } = useLocalSearchParams<{
    scope: string;
    platform: string;
  }>();
  const platform = asReviewerPlatform(rawPlatform);
  const colors = useThemeColors();
  const { data } = useReviewConfig(scope, platform);
  const save = useSaveReviewConfig(scope, platform);
  const { models, isLoading } = useAvailableModels(scope === PERSONAL_SCOPE ? undefined : scope);

  const selectedModel = models.find(model => model.id === data?.modelSlug);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Model" />
      <ScrollView className="flex-1 px-6" contentContainerClassName="pt-4 pb-8">
        {isLoading && (
          <View className="gap-3">
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
          </View>
        )}
        {(selectedModel?.variants.length ?? 0) > 0 && (
          <View className="mb-6">
            <Text variant="small" className="mb-1 uppercase tracking-wide text-muted-foreground">
              Thinking Effort
            </Text>
            {selectedModel?.variants.map(variant => (
              <Pressable
                key={variant}
                className="flex-row items-center justify-between border-b-[0.5px] border-hair-soft py-3 active:opacity-70"
                onPress={() => {
                  void Haptics.selectionAsync();
                  save.mutate({ thinkingEffort: variant });
                }}
              >
                <Text className="text-sm font-medium">{thinkingEffortLabel(variant)}</Text>
                {data?.thinkingEffort === variant ? (
                  <Check size={18} color={colors.foreground} />
                ) : null}
              </Pressable>
            ))}
          </View>
        )}
        {models.length > 0 && (
          <Text variant="small" className="mb-1 uppercase tracking-wide text-muted-foreground">
            Model
          </Text>
        )}
        {models.map(model => (
          <Pressable
            key={model.id}
            className="flex-row items-center justify-between border-b-[0.5px] border-hair-soft py-3 active:opacity-70"
            onPress={() => {
              void Haptics.selectionAsync();
              save.mutate({ modelSlug: model.id, thinkingEffort: null });
            }}
          >
            <View className="flex-1 pr-3">
              <Text className="text-sm font-medium">{model.name}</Text>
              <Text variant="muted" className="text-xs">
                {model.id}
              </Text>
            </View>
            {data?.modelSlug === model.id ? <Check size={18} color={colors.foreground} /> : null}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
