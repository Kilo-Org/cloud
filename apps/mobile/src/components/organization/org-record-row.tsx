import { Pressable, View } from 'react-native';

import { RowChevron } from '@/components/ui/row-chevron';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

type OrgRecordRowProps = Readonly<{
  title: string;
  /** The one-line secondary fact about the record: its identifier, its size. */
  meta?: string;
  description?: string;
  /** The full accessible name when the visible text does not say what a press does. */
  accessibilityLabel?: string;
  onPress?: () => void;
}>;

/**
 * One record in the organization's modes or groups list: the name, one line of
 * metadata beside it, and the record's own description under it. The row opens
 * the record's form, which owns editing and deleting, so the list carries no
 * per-row actions. It lives in a `RowGroup`, which draws the separator between
 * records.
 */
export function OrgRecordRow({
  title,
  meta,
  description,
  accessibilityLabel,
  onPress,
}: OrgRecordRowProps) {
  return (
    <Pressable
      className={cn('flex-row items-center gap-3 px-4 py-3 active:opacity-70', ROW_TARGET_CLASS)}
      onPress={onPress}
      disabled={onPress === undefined}
      accessibilityRole={onPress === undefined ? undefined : 'button'}
      accessibilityLabel={accessibilityLabel}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text className="shrink text-sm font-medium text-foreground" numberOfLines={1}>
            {title}
          </Text>
          {meta === undefined ? null : (
            <Text variant="caption" className="shrink" numberOfLines={1}>
              {meta}
            </Text>
          )}
        </View>
        {description === undefined || description.length === 0 ? null : (
          <Text variant="caption" numberOfLines={2}>
            {description}
          </Text>
        )}
      </View>
      {onPress === undefined ? null : <RowChevron />}
    </Pressable>
  );
}
