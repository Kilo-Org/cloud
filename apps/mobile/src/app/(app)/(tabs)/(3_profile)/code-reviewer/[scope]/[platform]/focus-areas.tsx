import * as Haptics from 'expo-haptics';
import { type Href, useLocalSearchParams } from 'expo-router';
import { Check } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import {
  parseReviewerPlatform,
  REVIEW_FOCUS_AREAS,
  type ReviewerPlatform,
} from '@/lib/code-reviewer-config';
import {
  useReviewConfig,
  useReviewConfigCacheReader,
  useSaveReviewConfig,
} from '@/lib/hooks/use-code-reviewer';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { parseParam } from '@/lib/route-params';

export default function FocusAreasRoute() {
  const { scope: rawScope, platform: rawPlatform } = useLocalSearchParams<{
    scope: string;
    platform: string;
  }>();
  const scope = parseParam(rawScope);
  const platform = scope ? parseReviewerPlatform(scope, rawPlatform) : null;

  if (!scope || !platform) {
    return <InvalidRouteState backTo={'/(app)/(tabs)/(3_profile)/code-reviewer' as Href} />;
  }

  return <FocusAreasRouteContent scope={scope} platform={platform} />;
}

function FocusAreasRouteContent({
  scope,
  platform,
}: Readonly<{
  scope: string;
  platform: ReviewerPlatform;
}>) {
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
      <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="pt-4">
        <Text variant="muted" className="mb-2 text-xs">
          Leave all unselected to review everything.
        </Text>
        {REVIEW_FOCUS_AREAS.map(area => (
          <Pressable
            key={area}
            className="flex-row items-center justify-between border-b-[0.5px] border-hair-soft py-3 active:opacity-70"
            onPress={() => {
              toggleArea(area);
            }}
          >
            <Text className="text-sm font-medium capitalize">{area}</Text>
            <Check size={18} color={selected.includes(area) ? colors.foreground : 'transparent'} />
          </Pressable>
        ))}
      </TabScreenScrollView>
    </View>
  );
}
