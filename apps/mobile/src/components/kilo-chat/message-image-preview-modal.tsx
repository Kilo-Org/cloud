import { Share, X } from 'lucide-react-native';
import { Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type Props = {
  visible: boolean;
  uri: string | null;
  filename: string;
  sharing?: boolean;
  /** Share failure message. Rendered inline — the toast layer sits behind this modal. */
  shareError?: string | null;
  onClose: () => void;
  onShare: () => void;
};

export function MessageImagePreviewModal({
  visible,
  uri,
  filename,
  sharing = false,
  shareError = null,
  onClose,
  onShare,
}: Props) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 bg-background">
        <View
          className="flex-row items-center justify-between border-b border-border bg-background px-4"
          style={{ paddingTop: insets.top, height: insets.top + 56 }}
        >
          <Pressable
            onPress={onClose}
            className="h-10 w-10 items-center justify-center rounded-md bg-secondary active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel={`Close ${filename}`}
          >
            <X size={20} color={colors.foreground} />
          </Pressable>
          <Pressable
            onPress={onShare}
            disabled={sharing || uri === null}
            accessibilityState={{ disabled: uri === null, busy: sharing }}
            className="h-10 w-10 items-center justify-center rounded-md bg-secondary active:opacity-70 disabled:opacity-50"
            accessibilityRole="button"
            accessibilityLabel={`Share ${filename}`}
          >
            <Share size={20} color={colors.foreground} />
          </Pressable>
        </View>
        <View className="flex-1 items-center justify-center bg-black">
          {uri ? <Image source={{ uri }} className="h-full w-full" contentFit="contain" /> : null}
        </View>
        {shareError ? (
          <View
            className="absolute inset-x-0 items-center px-6"
            style={{ bottom: insets.bottom + 16 }}
          >
            <View className="rounded-md bg-neutral-900/90 px-4 py-2 dark:bg-neutral-100/90">
              <Text className="text-center text-sm text-white dark:text-neutral-900">
                {shareError}
              </Text>
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}
