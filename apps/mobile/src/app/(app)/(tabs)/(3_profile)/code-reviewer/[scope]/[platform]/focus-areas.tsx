import * as Haptics from 'expo-haptics';
import { useLocalSearchParams } from 'expo-router';
import { Check } from 'lucide-react-native';
import { Pressable, ScrollView, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { asReviewerPlatform, FOCUS_AREAS } from '@/lib/code-reviewer-config';
import {
  useReviewConfig,
  useReviewConfigCacheReader,
  useSaveReviewConfig,
} from '@/lib/hooks/use-code-reviewer';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export default function FocusAreasRoute() {
  const { scope, platform: rawPlatform } = useLocalSearchParams<{
    scope: string;
    platform: string;
  }>();
  const platform = asReviewerPlatform(rawPlatform);
  const colors = useThemeColors();
  const { data } = useReviewConfig(scope, platform);
  const save = useSaveReviewConfig(scope, platform);
  const readConfig = useReviewConfigCacheReader(scope, platform);
  const selected = data?.focusAreas ?? [];

  const toggleArea = (area: string) => {
    void Haptics.selectionAsync();
    // Read the cache at call time, not the render-time snapshot above, so
    // two rapid taps each build the next array from the latest committed
    // selection instead of dropping one another.
    const current = readConfig()?.focusAreas ?? [];
    const next = current.includes(area)
      ? current.filter(item => item !== area)
      : [...current, area];
    save.mutate({ focusAreas: next });
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Focus Areas" />
      <ScrollView className="flex-1 px-6" contentContainerClassName="pt-4 pb-8">
        <Text variant="muted" className="mb-2 text-xs">
          Leave all unselected to review everything.
        </Text>
        {FOCUS_AREAS.map(area => (
          <Pressable
            key={area}
            className="flex-row items-center justify-between border-b-[0.5px] border-hair-soft py-3 active:opacity-70"
            onPress={() => {
              toggleArea(area);
            }}
          >
            <Text className="text-sm font-medium capitalize">{area}</Text>
            {selected.includes(area) ? <Check size={18} color={colors.foreground} /> : null}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
