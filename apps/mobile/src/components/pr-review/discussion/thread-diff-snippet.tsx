// Quoted diff snippet rendered above comments in an expanded LINE-anchored
// discussion thread. Reuses DiffLine (no onTap — static quote only).
// When truncated, hidden lines are at the TOP (cap keeps the tail).

import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { DiffLine } from '@/components/pr-review/diff/diff-line';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { type ThreadDiffSnippet as ThreadDiffSnippetData } from '@/lib/pr-review/discussion/thread-diff-snippet';

type ThreadDiffSnippetProps = {
  readonly snippet: ThreadDiffSnippetData;
};

export function ThreadDiffSnippet({ snippet }: Readonly<ThreadDiffSnippetProps>) {
  const { t } = useTranslation();
  const truncatedCount = snippet.totalLineCount - snippet.lines.length;
  return (
    <View
      accessibilityLabel={t('prReview.discussion.quotedDiffSnippet')}
      className="overflow-hidden rounded-lg border border-border"
    >
      {truncatedCount > 0 ? (
        <View className="border-b border-hair-soft px-3 py-1">
          <Text className="text-xs text-muted-foreground">
            {t('prReview.discussion.moreLinesAbove', {
              count: truncatedCount,
              displayCount: formatNumber(truncatedCount, i18n.language),
            })}
          </Text>
        </View>
      ) : null}
      {snippet.lines.map((line, index) => (
        <DiffLine
          key={`snip-${index}`}
          line={line}
          language={snippet.language}
          keyId={`snip-${index}`}
        />
      ))}
    </View>
  );
}
