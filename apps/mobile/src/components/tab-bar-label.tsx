import { Text } from '@/components/ui/text';
import { TAB_LABEL_MINIMUM_FONT_SCALE, tabLabelNumberOfLines } from '@/lib/tab-bar-layout';

/**
 * One bottom-tab label, on the lines the bar reserves for it. One line shrinks
 * and tail-truncates when the copy is wider than its tab, so the label is never
 * dropped to make room. Two lines are reserved only for copy that breaks
 * between words or carries its own break; a single word is never split
 * mid-word. The tab button, not this text, carries the accessibility name, so
 * `accessible={false}` keeps the announced name intact.
 */
export function TabBarLabel({
  label,
  focused,
  lines,
}: Readonly<{ label: string; focused: boolean; lines?: 1 | 2 }>) {
  // Copy that carries its own break always takes its two lines; every other
  // label uses the count the bar reserved for it.
  const resolvedLines = lines ?? tabLabelNumberOfLines(label);
  const singleLine = resolvedLines === 1;
  return (
    <Text
      accessible={false}
      className={
        focused
          ? 'w-full text-center font-mono-medium text-[11px] leading-4 uppercase tracking-[0.2px] text-foreground'
          : 'w-full text-center font-mono-medium text-[11px] leading-4 uppercase tracking-[0.2px] text-muted-foreground'
      }
      numberOfLines={resolvedLines}
      adjustsFontSizeToFit={singleLine}
      minimumFontScale={singleLine ? TAB_LABEL_MINIMUM_FONT_SCALE : undefined}
      ellipsizeMode={singleLine ? 'tail' : 'clip'}
    >
      {label}
    </Text>
  );
}
