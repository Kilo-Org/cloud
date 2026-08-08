import { View } from 'react-native';

import { SelectableText } from '@/components/ui/selectable-text';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { type ResultRow } from './tool-list-model';

type ToolResultRowsProps = {
  /** The lifted `Found N ...` summary line, rendered muted. */
  caption?: string;
  rows: readonly ResultRow[];
  truncated?: boolean;
};

/**
 * One row per result path for the grep/glob/list tool sheets. File-header
 * rows (`path:`) get medium weight; every row stays selectable through the
 * shared `SelectableText`. A truncated model shows the standard marker.
 */
export function ToolResultRows({
  caption,
  rows,
  truncated = false,
}: Readonly<ToolResultRowsProps>) {
  return (
    <View className="gap-1">
      {caption ? (
        <SelectableText className="px-2 pt-1 text-xs text-muted-foreground">
          {caption}
        </SelectableText>
      ) : null}
      {rows.map((row, index) => (
        <View key={index} className="border-b border-hair-soft px-2 py-1.5">
          <SelectableText
            className={cn(
              'font-mono text-xs leading-4 text-foreground',
              row.emphasis && 'font-medium'
            )}
          >
            {row.text}
          </SelectableText>
        </View>
      ))}
      {truncated ? (
        <Text accessibilityLabel="Content truncated" className="mt-1 text-xs text-muted-foreground">
          Truncated
        </Text>
      ) : null}
    </View>
  );
}
