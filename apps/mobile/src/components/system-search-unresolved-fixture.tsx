/* eslint-disable no-literal-copy/no-literal-copy -- Development-only toast fixture; its labels never ship. */
import { useEffect } from 'react';
import { View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { showSystemSearchUnresolvedFeedback } from '@/lib/system-search-route';

/**
 * Raises the toast again for the fixture's retry. It stands in for the real
 * retry — which consumes the module's slot — because the fixture has no slot and
 * must not touch the app's own.
 */
function showFixtureToast(): void {
  showSystemSearchUnresolvedFeedback(showFixtureToast);
}

/**
 * The screen behind `/(app)/system-search-unresolved-fixture`, reachable only
 * through the dev fixture link in `src/app/+native-intent.tsx`.
 *
 * It raises the toast the search-tap consume shows when the phone's index could
 * not resolve the picked result, through the production function and the
 * production copy, so a design-gate cell measures the real message and its
 * retry in every matrix case. The state itself needs an index read failure on a
 * real device tap, which no link can produce.
 */
export function SystemSearchUnresolvedFixture() {
  useEffect(() => {
    // A tick after the first frame: the toast positions itself against the
    // window the screen is laid out in.
    const frame = setTimeout(showFixtureToast, 0);
    return () => {
      clearTimeout(frame);
    };
  }, []);

  return (
    <View className="flex-1 bg-background" testID="system-search-unresolved-fixture">
      <ScreenHeader title="System search toast fixture" />
      <View className="gap-2 px-4 pt-4">
        <Text className="text-sm text-muted-foreground">Toast under test</Text>
        <Text className="text-base text-foreground">Unresolved search result</Text>
      </View>
    </View>
  );
}
