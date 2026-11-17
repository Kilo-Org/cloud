import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { KeyRound, Pencil, Trash2 } from '@/components/ui/icons';
import { ConfigureRow } from '@/components/ui/configure-row';
import { IconButton } from '@/components/ui/icon-button';
import { formatDate, formatList } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type PasskeyRow } from '@/lib/passkeys/passkey-types';
import { parseTimestamp } from '@/lib/utils';

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
  const name = passkey.name?.trim();
  const added = t('profile.passkeyAddedOn', {
    date: formatDate(parseTimestamp(passkey.created_at), i18n.language),
  });
  // The row primitive carries one secondary line, so a recorded last use joins
  // the added date rather than dropping either fact.
  const lastUsed =
    passkey.last_used_at === null
      ? null
      : t('profile.passkeyLastUsedOn', {
          date: formatDate(parseTimestamp(passkey.last_used_at), i18n.language),
        });

  return (
    <ConfigureRow
      icon={KeyRound}
      title={name && name.length > 0 ? name : t('profile.passkeyDefaultName')}
      subtitle={lastUsed === null ? added : formatList([added, lastUsed], i18n.language)}
      variant="action"
      trailing={
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
      }
    />
  );
}
