import { type ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type AdaptiveHomeCardFrameProps = {
  live: ReactNode;
  briefing?: ReactNode;
  showBriefing: boolean;
};

export function AdaptiveHomeCardFrame({
  live,
  briefing,
  showBriefing,
}: Readonly<AdaptiveHomeCardFrameProps>) {
  return (
    <View className="flex-row items-stretch overflow-hidden rounded-2xl border border-border bg-card">
      <View
        className={cn('w-full shrink-0', showBriefing && 'opacity-0')}
        pointerEvents={showBriefing ? 'none' : 'auto'}
        accessibilityElementsHidden={showBriefing}
        importantForAccessibility={showBriefing ? 'no-hide-descendants' : 'auto'}
      >
        {live}
      </View>
      {/* Overlapping in-flow siblings let native layout reserve the larger intrinsic height. */}
      <View
        className={cn('-ms-[100%] w-full shrink-0', !showBriefing && 'opacity-0')}
        pointerEvents={showBriefing ? 'auto' : 'none'}
        accessibilityElementsHidden={!showBriefing}
        importantForAccessibility={showBriefing ? 'auto' : 'no-hide-descendants'}
      >
        {briefing}
      </View>
      <View
        className="-ms-[100%] w-full shrink-0 opacity-0"
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View className="gap-2 px-4 py-3">
          {[0, 1, 2, 3].map(row => (
            <View key={row} className="min-h-6 justify-center">
              <Text className="text-sm">{'\u200B'}</Text>
            </View>
          ))}
        </View>
        <View className="h-px bg-border" />
        <View className="min-h-[68px] justify-center px-4 py-3">
          <Text className="text-sm">{'\u200B\n\u200B'}</Text>
        </View>
      </View>
    </View>
  );
}
