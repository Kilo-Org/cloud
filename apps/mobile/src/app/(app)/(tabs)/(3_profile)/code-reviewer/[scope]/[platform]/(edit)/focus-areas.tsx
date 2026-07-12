import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { ChoiceRow } from '@/components/ui/choice-row';
import { TabScreenScrollView } from '@/components/tab-screen';
import { REVIEW_FOCUS_AREAS, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import {
  useReviewConfig,
  useReviewConfigCacheReader,
  useSaveReviewConfig,
} from '@/lib/hooks/use-code-reviewer';

export default function FocusAreasRoute() {
  const { scope, platform } = useLocalSearchParams<{ scope: string; platform: ReviewerPlatform }>();
  const { data } = useReviewConfig(scope, platform);
  const save = useSaveReviewConfig(scope, platform);
  const readConfig = useReviewConfigCacheReader(scope, platform);
  const selected = data?.focusAreas ?? [];
  const disabled = data == null;

  const toggleArea = (area: string) => {
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
      <ScreenHeader title="Focus areas" />
      <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="pt-4">
        <Text variant="muted" className="mb-2 text-xs">
          Leave all unselected to review everything.
        </Text>
        {REVIEW_FOCUS_AREAS.map(area => (
          <ChoiceRow
            key={area}
            label={area}
            multi
            selected={selected.includes(area)}
            disabled={disabled}
            className="border-b-[0.5px] border-hair-soft"
            onPress={() => {
              toggleArea(area);
            }}
          />
        ))}
      </TabScreenScrollView>
    </View>
  );
}
