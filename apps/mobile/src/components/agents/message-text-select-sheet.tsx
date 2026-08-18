import { Modal, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetHeader } from '@/components/sheet-header';
import { SelectableText } from '@/components/ui/selectable-text';

type MessageTextSelectSheetProps = {
  visible: boolean;
  text: string;
  onClose: () => void;
};

/**
 * Child page-sheet that shows the copyable message body in a read-only
 * selectable field. The parent only sets `visible` when `text.length > 0`, so
 * an empty string never renders `SelectableText`.
 */
export function MessageTextSelectSheet({
  visible,
  text,
  onClose,
}: Readonly<MessageTextSelectSheetProps>) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View className="flex-1 bg-background">
        <SheetHeader title="Select text" onDone={onClose} doneLabel="Done" />

        {text.length > 0 ? (
          <ScrollView contentContainerClassName="px-6 pb-6 pt-3">
            <SelectableText className="text-base leading-6 text-foreground">{text}</SelectableText>
          </ScrollView>
        ) : null}

        <View style={{ height: insets.bottom }} className="bg-background" />
      </View>
    </Modal>
  );
}
