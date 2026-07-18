import { MessageSquare } from 'lucide-react-native';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export type PrReviewDiscussionTabProps = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
};

/**
 * Placeholder body for the Discussion tab. S5 renders a centered
 * "Discussion coming soon" so the tab shell can be exercised end-to-end;
 * S7b replaces the body with the review-thread list and pending-comment
 * summary.
 */
export function PrReviewDiscussionTab({ owner, repo, number }: PrReviewDiscussionTabProps) {
  const colors = useThemeColors();
  return (
    <View
      accessibilityLabel="Discussion tab"
      className="flex-1 items-center justify-center gap-2 px-6 py-12"
    >
      <MessageSquare size={28} color={colors.mutedForeground} />
      <Text variant="muted" className="text-center">
        Discussion for {owner}/{repo}#{number} coming soon.
      </Text>
    </View>
  );
}
