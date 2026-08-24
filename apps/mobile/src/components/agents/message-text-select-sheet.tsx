import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { SheetHeader } from '@/components/sheet-header';
import { SelectableText } from '@/components/ui/selectable-text';

type MessageTextSelectSheetProps = {
  text: string;
  onClose: () => void;
};

/**
 * Content-only view for the details sheet's Select text mode. The parent
 * renders this inside the single details Modal when `selectVisible` is true.
 * An empty string never renders `SelectableText`.
 */
export function MessageTextSelectSheet({ text, onClose }: Readonly<MessageTextSelectSheetProps>) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <SheetHeader
        title={t('agentChat.messageDetails.selectText')}
        onDone={onClose}
        doneLabel={t('common.done')}
      />

      {text.length > 0 ? (
        <ScrollView contentContainerClassName="px-6 pb-6 pt-3">
          <SelectableText className="text-base leading-6 text-foreground">{text}</SelectableText>
        </ScrollView>
      ) : null}

      <View style={{ height: insets.bottom }} className="bg-background" />
    </View>
  );
}
