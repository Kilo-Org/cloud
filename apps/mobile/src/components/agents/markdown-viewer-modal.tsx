import { X } from 'lucide-react-native';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { MarkdownText } from './markdown-text';

type MarkdownViewerModalProps = {
  visible: boolean;
  /** Absolute file path — the reader's title. */
  path: string;
  value: string;
  footer?: string;
  onClose: () => void;
};

export function MarkdownViewerModal({
  visible,
  path,
  value,
  footer,
  onClose,
}: Readonly<MarkdownViewerModalProps>) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 bg-background">
        <View
          className="flex-row items-center gap-3 border-b border-border bg-background px-4"
          // eslint-disable-next-line react-native/no-inline-styles -- safe-area top inset cannot be a Tailwind class
          style={{ paddingTop: insets.top, height: insets.top + 56 }}
        >
          <Pressable
            onPress={onClose}
            className="h-10 w-10 items-center justify-center rounded-md bg-secondary active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel={`Close ${path}`}
          >
            <X size={20} color={colors.foreground} />
          </Pressable>
          <Text
            className="flex-1 text-sm text-muted-foreground"
            numberOfLines={1}
            ellipsizeMode="head"
          >
            {path}
          </Text>
        </View>
        <ScrollView className="flex-1">
          <View className="px-4 pb-8">
            <MarkdownText value={value} />
            {footer ? <Text className="mt-4 text-xs text-muted-foreground">{footer}</Text> : null}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
