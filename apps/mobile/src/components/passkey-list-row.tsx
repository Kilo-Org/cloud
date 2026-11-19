import { useTranslation } from 'react-i18next';
import { useWindowDimensions, View } from 'react-native';

import { KeyRound, Pencil, Trash2 } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/icon-button';
import { RowFrame } from '@/components/ui/row-frame';
import { formatDate } from '@/lib/format';
import { useLiveFontScale } from '@/lib/font-scale/system-font-scale-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { isNarrowLayout } from '@/lib/narrow-layout';
import { type PasskeyRow } from '@/lib/passkeys/passkey-types';
import { parseTimestamp } from '@/lib/utils';

/** Matches `ConfigureRow`'s threshold, so a passkey row stacks with every other
 * settings row at the same window width and text scale. */
const ROW_STACK_FONT_SCALE = 1.8;

/** One passkey: its name (or the default when the server stored none), the date
 * it was added, the date it was last used when the server recorded one, and the
 * rename/remove controls for it. */
export function PasskeyListRow({
  passkey,
  disabled,
  onRename,
  onRemove,
}: Readonly<{
  passkey: PasskeyRow;
  disabled: boolean;
  onRename: (passkey: PasskeyRow) => void;
  onRemove: (passkey: PasskeyRow) => void;
}>) {
  const colors = useThemeColors();
  const { t, i18n } = useTranslation();
  const { width } = useWindowDimensions();
  const fontScale = useLiveFontScale();
  // A narrow window squeezes the text block exactly as a large font scale does,
  // so both take the stacked presentation the other settings rows use.
  const stack = fontScale >= ROW_STACK_FONT_SCALE || isNarrowLayout(width);
  const name = passkey.name?.trim();
  // Each fact keeps its own line: joining them into one sentence read as a
  // comma splice, and the two dates are scanned independently.
  const added = t('profile.passkeyAddedOn', {
    date: formatDate(parseTimestamp(passkey.created_at), i18n.language),
  });
  const lastUsed =
    passkey.last_used_at === null
      ? undefined
      : t('profile.passkeyLastUsedOn', {
          date: formatDate(parseTimestamp(passkey.last_used_at), i18n.language),
        });

  return (
    <RowFrame
      icon={KeyRound}
      title={name && name.length > 0 ? name : t('profile.passkeyDefaultName')}
      subtitle={{ text: added }}
      secondSubtitle={lastUsed === undefined ? undefined : { text: lastUsed }}
      stack={stack}
      trailing={{
        kind: 'node',
        node: (
          <View className="flex-row items-center gap-1">
            <IconButton
              disabled={disabled}
              accessibilityLabel={t('common.rename')}
              onPress={() => {
                onRename(passkey);
              }}
            >
              <Pencil size={16} color={colors.mutedForeground} />
            </IconButton>
            <IconButton
              disabled={disabled}
              accessibilityLabel={t('common.remove')}
              onPress={() => {
                onRemove(passkey);
              }}
            >
              <Trash2 size={16} color={colors.destructive} />
            </IconButton>
          </View>
        ),
      }}
    />
  );
}
