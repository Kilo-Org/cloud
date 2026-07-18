import { FileText } from 'lucide-react-native';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export type PrReviewFilesTabProps = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /** Head SHA at the time the Overview was loaded — S6b's diff uses this to keep the file list stable. */
  readonly headSha: string;
  /** File count from the Overview DTO so S6b can pre-size the list header. */
  readonly changedFiles: number;
};

/**
 * Placeholder body for the Files tab. S5 only renders a centered
 * "Files view coming soon" so the tab shell can be exercised end-to-end;
 * S6b replaces the body with the diff list + file navigator mount.
 *
 * The prop contract is deliberately fixed here so S6b only has to
 * implement the body without re-touching `pr-review-screen.tsx`.
 */
export function PrReviewFilesTab({
  owner,
  repo,
  number,
  headSha,
  changedFiles,
}: PrReviewFilesTabProps) {
  const colors = useThemeColors();
  return (
    <View
      accessibilityLabel="Files tab"
      className="flex-1 items-center justify-center gap-2 px-6 py-12"
    >
      <FileText size={28} color={colors.mutedForeground} />
      <Text variant="muted" className="text-center">
        Files view for {owner}/{repo}#{number} ({changedFiles} files) coming soon.
      </Text>
      <Text variant="muted" className="text-center text-xs">
        head {headSha.slice(0, 7)}
      </Text>
    </View>
  );
}
