// Quoted diff snippet rendered above comments in an expanded LINE-anchored
// discussion thread. Reuses DiffLine (no onTap — static quote only).
// When truncated, hidden lines are at the TOP (cap keeps the tail).

import { View } from 'react-native';

import { DiffLine } from '@/components/pr-review/diff/diff-line';
import { Text } from '@/components/ui/text';
import { type ThreadDiffSnippet as ThreadDiffSnippetData } from '@/lib/pr-review/discussion/thread-diff-snippet';

type ThreadDiffSnippetProps = {
  readonly snippet: ThreadDiffSnippetData;
};

export function ThreadDiffSnippet({ snippet }: Readonly<ThreadDiffSnippetProps>) {
  const truncatedCount = snippet.totalLineCount - snippet.lines.length;
  return (
    <View
      accessibilityLabel="Quoted diff snippet"
      className="overflow-hidden rounded-lg border border-border"
    >
      {truncatedCount > 0 ? (
        <View className="border-b border-hair-soft px-3 py-1">
          <Text className="text-xs text-muted-foreground">… {truncatedCount} more lines above</Text>
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
