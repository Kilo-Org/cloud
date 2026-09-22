import { Text } from '@/components/ui/text';
import { tabLabelNumberOfLines } from '@/lib/tab-bar-layout';

/**
 * One bottom-tab label. The label never wraps: it stays on one line and
 * truncates at the tail, except for the copy that carries its own break
 * (`tabs.kiloclawWrapped`). A mid-word wrap of a single word wider than its tab
 * leaves the bar unreadable. The tab button, not this text, carries the
 * accessibility name, so `accessible={false}` keeps the announced name intact.
 */
export function TabBarLabel({ label, focused }: Readonly<{ label: string; focused: boolean }>) {
  return (
    <Text
      accessible={false}
      className={
        focused
          ? 'w-full text-center font-mono-medium text-[11px] leading-4 uppercase tracking-[0.2px] text-foreground'
          : 'w-full text-center font-mono-medium text-[11px] leading-4 uppercase tracking-[0.2px] text-muted-foreground'
      }
      ellipsizeMode="tail"
      numberOfLines={tabLabelNumberOfLines(label)}
    >
      {label}
    </Text>
  );
}
