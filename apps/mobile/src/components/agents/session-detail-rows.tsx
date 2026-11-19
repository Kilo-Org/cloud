import { type ReactNode } from 'react';
import { View } from 'react-native';

import { KvRow } from '@/components/ui/kv-row';
import { Text } from '@/components/ui/text';

import { formatExactTokens } from './context-usage-display';

/**
 * Field block shared by the agents detail sheets: a caption above the value the
 * caller renders. The value keeps arbitrary content (a nested unit, a status
 * line), which the label/value row primitives do not carry.
 */
export function Row({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <View className="gap-1">
      <Text variant="caption">{label}</Text>
      {children}
    </View>
  );
}

/**
 * Token count row shared by the agents detail sheets: label on the left, the
 * exact formatted token count on the right.
 */
export function TokenRow({ label, value }: Readonly<{ label: string; value: number }>) {
  return <KvRow label={label} value={formatExactTokens(value)} valueFace="numeric" />;
}
