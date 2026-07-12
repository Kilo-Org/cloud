import { View } from 'react-native';

import { cn } from '@/lib/utils';

export type StatusDotTone = 'good' | 'warn' | 'danger' | 'muted';

type StatusDotProps = {
  tone?: StatusDotTone;
  className?: string;
};

// Solid inner-dot and outer-halo classes per tone. The halo uses the
// pre-tinted Focus tile tokens because `/opacity` does not work with our
// CSS-variable theme tokens.
const TONE: Record<StatusDotTone, { dot: string; halo: string }> = {
  good: { dot: 'bg-good', halo: 'bg-good-tile-bg' },
  warn: { dot: 'bg-warn', halo: 'bg-warn-tile-bg' },
  danger: { dot: 'bg-destructive', halo: 'bg-danger-tile-bg' },
  muted: { dot: 'bg-muted-soft', halo: 'bg-neutral-500/20' },
};

/**
 * Status indicator dot with a halo (replaces CSS box-shadow).
 * 7px inner dot centered inside a 13px halo.
 */
export function StatusDot({ tone = 'good', className }: Readonly<StatusDotProps>) {
  const styles = TONE[tone];
  return (
    <View
      className={cn(
        'h-[13px] w-[13px] items-center justify-center rounded-full',
        styles.halo,
        className
      )}
    >
      <View className={cn('h-[7px] w-[7px] rounded-full', styles.dot)} />
    </View>
  );
}
