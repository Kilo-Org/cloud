import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

// Thin stub for the comment composer sheet. S7a fills in the body — the
// line/side context, the text input, the diff snippet preview, the
// submit/cancel actions. S4b only needs the route to render something
// inside a ScrollView (iOS formSheet gotcha) and pin the param contract.
type Params = {
  owner: string;
  repo: string;
  number: string;
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: string;
  startLine?: string;
};

export function PrReviewCommentComposerScreen() {
  const colors = useThemeColors();
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const startLine = params.startLine ? Number.parseInt(params.startLine, 10) : undefined;
  const lineNumber = Number.parseInt(params.line, 10);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Add comment"
        eyebrow={`${params.owner}/${params.repo}#${params.number}`}
        modal
        onBack={() => {
          router.back();
        }}
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-6 pb-8 pt-2"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <Text variant="muted">
          {params.path} {params.side} L{Number.isFinite(lineNumber) ? lineNumber : '?'}
          {startLine && Number.isFinite(startLine) ? `–L${startLine}` : ''}
        </Text>
        <Text className="text-sm" style={{ color: colors.mutedForeground }}>
          Comment composer lands in S7a.
        </Text>
      </ScrollView>
    </View>
  );
}
