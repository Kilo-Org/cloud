import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';

export function SheetHeader({ title, onDone }: { title: string; onDone: () => void }) {
  return (
    <View className="border-b border-border bg-background px-4 pb-3 pt-4">
      <View className="h-11 flex-row items-center justify-center">
        <Text className="text-lg font-semibold text-foreground" accessibilityRole="header">
          {title}
        </Text>
        <Pressable
          onPress={onDone}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Done"
          className="absolute right-0 rounded-full bg-secondary px-4 py-2 active:opacity-70 will-change-pressable"
        >
          <Text className="text-base font-medium text-foreground">Done</Text>
        </Pressable>
      </View>
    </View>
  );
}
