import { MoreVertical, Shuffle } from '@/components/ui/icons';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ScreenHeader } from '@/components/screen-header';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type Props = {
  title?: string;
  subtitle?: string;
  canSwitchInstance?: boolean;
  onSwitchInstance?: () => void;
  onOpenOptions?: () => void;
};

export function ConversationHeader({
  title,
  subtitle,
  canSwitchInstance,
  onSwitchInstance,
  onOpenOptions,
}: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <ScreenHeader
      title={title}
      eyebrow={subtitle}
      headerRight={
        <View className="flex-row items-center gap-1">
          {canSwitchInstance ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('chat.instancePicker.switchInstance')}
              className="h-10 w-10 items-center justify-center rounded-full active:bg-muted"
              onPress={onSwitchInstance}
            >
              <Shuffle size={18} color={colors.foreground} />
            </Pressable>
          ) : null}
          {onOpenOptions ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('chat.conversation.options')}
              className="h-10 w-10 items-center justify-center rounded-full active:bg-muted"
              onPress={onOpenOptions}
            >
              <MoreVertical size={20} color={colors.foreground} />
            </Pressable>
          ) : null}
        </View>
      }
    />
  );
}
