import { useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

// Thin stub for the file-navigator sheet. S6c implements the list and the
// scroll-to-file bridge producer. S4b only needs the route to mount and
// pin the param contract.
type Params = {
  owner: string;
  repo: string;
  number: string;
};

export function PrReviewFileNavigatorScreen() {
  const colors = useThemeColors();
  const params = useLocalSearchParams<Params>();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Files"
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
          File navigator lands in S6c.
        </Text>
      </ScrollView>
    </View>
  );
}
