import { useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

// Thin stub for the merge sheet. S8 implements the merge-method picker
// and the merge mutation. S4b only needs the route to mount and pin the
// param contract.
type Params = {
  owner: string;
  repo: string;
  number: string;
};

export function PrReviewMergeScreen() {
  const colors = useThemeColors();
  const params = useLocalSearchParams<Params>();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Merge pull request"
        eyebrow={`${params.owner}/${params.repo}#${params.number}`}
        modal
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-6 pb-8 pt-2"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <Text variant="muted" className="text-sm" style={{ color: colors.mutedForeground }}>
          Merge picker lands in S8.
        </Text>
      </ScrollView>
    </View>
  );
}
