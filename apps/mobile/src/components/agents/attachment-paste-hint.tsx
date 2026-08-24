import { ClipboardPaste } from '@/components/ui/icons';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type Props = {
  onPress: () => void;
};

/**
 * Presentational row that reads "Image detected, tap to paste".
 * No internal state, no clipboard access. The caller decides whether
 * to render it.
 */
export function AttachmentPasteHint({ onPress }: Props) {
  const colors = useThemeColors();
  const { t } = useTranslation();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('agentChat.attachmentPasteHint.accessibility')}
      className="flex-row items-center gap-1.5 px-3 py-1.5 active:opacity-70"
    >
      <ClipboardPaste size={14} color={colors.mutedForeground} />
      <Text className="text-xs text-muted-foreground">
        {t('agentChat.attachmentPasteHint.label')}
      </Text>
    </Pressable>
  );
}
