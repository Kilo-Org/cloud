import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';

export function SheetHeader({
  title,
  onDone,
  onCancel,
  doneLabel = 'Done',
}: {
  title: string;
  onDone: () => void;
  onCancel?: () => void;
  doneLabel?: string;
}) {
  return (
    // collapsable={false}: react-native-screens lays out a formSheet's scroll
    // view by finding the header at the screen content's subview index 0 — a
    // flattened header breaks that native pass and the list paints over it.
    <View collapsable={false} className="border-b border-border bg-background px-4 pb-3 pt-4">
      <View className="h-11 flex-row items-center justify-center">
        {onCancel ? (
          <Pressable
            onPress={onCancel}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            className="absolute left-0 px-2 py-2 active:opacity-70"
          >
            <Text className="text-base font-medium text-foreground">Cancel</Text>
          </Pressable>
        ) : null}
        <Text className="text-lg font-semibold text-foreground" accessibilityRole="header">
          {title}
        </Text>
        <Pressable
          onPress={onDone}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={doneLabel}
          className="absolute right-0 rounded-full bg-secondary px-4 py-2 active:opacity-70 will-change-pressable"
        >
          <Text className="text-base font-medium text-foreground">{doneLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}
