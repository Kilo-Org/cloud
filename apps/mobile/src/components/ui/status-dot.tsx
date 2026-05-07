import { View } from 'react-native';

import { cn } from '@/lib/utils';

export type StatusDotTone = 'good' | 'warn' | 'danger' | 'muted';

type StatusDotProps = {
  tone?: StatusDotTone;
  className?: string;
  glow?: boolean;
};

// Solid inner-dot and outer-halo classes per tone.
// The halo uses a fixed Tailwind color at 15% alpha because `/opacity`
// does not work with our CSS-variable theme tokens.
const TONE: Record<StatusDotTone, { dot: string; halo: string }> = {
  good: { dot: 'bg-good', halo: 'bg-emerald-500/20' },
  warn: { dot: 'bg-warn', halo: 'bg-amber-500/20' },
  danger: { dot: 'bg-destructive', halo: 'bg-red-500/20' },
  muted: { dot: 'bg-muted-soft', halo: 'bg-neutral-500/20' },
};

/**
 * Status indicator dot with an optional halo (replaces CSS box-shadow).
 * 7px inner dot centered inside a 13px halo.
 */
export function StatusDot({ tone = 'good', glow = true, className }: Readonly<StatusDotProps>) {
  const styles = TONE[tone];
  if (!glow) {
    return <View className={cn('h-[7px] w-[7px] rounded-full', styles.dot, className)} />;
  }
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
