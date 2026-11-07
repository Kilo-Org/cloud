import { Text } from '@/components/ui/text';
import { isolateLtrBidiText } from '@/lib/bidi';
import { formatNumber } from '@/lib/format';

/**
 * A session diff's added and removed totals. Each count is its own run, and a
 * sign is a neutral: on a right-to-left screen the paragraph would take the
 * sign and paint `+3` as `3+`. The isolate pins each count's order, while the
 * row itself still mirrors.
 */
export function SessionDiffTotals({
  additions,
  deletions,
  language,
}: Readonly<{ additions: number; deletions: number; language: string }>) {
  return (
    <>
      <Text variant="muted" className="text-xs tabular-nums">
        {isolateLtrBidiText(`+${formatNumber(additions, language)}`)}
      </Text>
      <Text variant="muted" className="text-xs tabular-nums">
        {isolateLtrBidiText(`-${formatNumber(deletions, language)}`)}
      </Text>
    </>
  );
}
