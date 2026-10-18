import { Text } from '@/components/ui/text';
import { tabLabelNumberOfLines } from '@/lib/tab-bar-layout';

/**
 * The tab button owns the accessibility name; its label stays hidden from
 * assistive technology to avoid announcing the same name twice.
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
