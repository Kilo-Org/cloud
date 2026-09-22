import { type ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';

import { formatExactTokens } from './context-usage-display';

/**
 * Field row shared by the agents detail sheets: a small uppercase label above
 * the value the caller renders.
 */
export function Row({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <View className="gap-1">
      <Text className="text-xs uppercase tracking-wide text-muted-foreground">{label}</Text>
      {children}
    </View>
  );
}

/**
 * Token count row shared by the agents detail sheets: label on the left, the
 * exact formatted token count on the right.
 */
export function TokenRow({ label, value }: Readonly<{ label: string; value: number }>) {
  return (
    <View className="flex-row items-center justify-between">
      <Text className="text-sm text-muted-foreground">{label}</Text>
      <Text className="text-sm font-medium text-foreground tabular-nums">
        {formatExactTokens(value)}
      </Text>
    </View>
  );
}
