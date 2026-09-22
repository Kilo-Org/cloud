import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { KeyRound, Pencil, Trash2 } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { formatDate } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { parseTimestamp } from '@/lib/utils';

/** The passkey list as `user.getPasskeys` returns it; the types are derived, never copied. */
export type PasskeysResult = inferRouterOutputs<MobileRouter>['user']['getPasskeys'];
export type PasskeyRow = PasskeysResult['passkeys'][number];

/** One passkey: its name (or the default when the server stored none), the date
 * it was added, and the rename/remove controls for it. */
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

  return (
    <View className="flex-row items-center gap-3 rounded-lg bg-secondary p-3">
      <KeyRound size={18} color={colors.secondaryForeground} />
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium" numberOfLines={1}>
          {name && name.length > 0 ? name : t('profile.passkeyDefaultName')}
        </Text>
        <Text variant="muted" className="mt-0.5 text-xs">
          {t('profile.passkeyAddedOn', {
            date: formatDate(parseTimestamp(passkey.created_at), i18n.language),
          })}
        </Text>
      </View>
      <Pressable
        onPress={() => {
          onRename(passkey);
        }}
        disabled={disabled}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('common.rename')}
        className="min-h-[44px] min-w-[44px] shrink-0 items-center justify-center active:opacity-70"
      >
        <Pencil size={16} color={colors.mutedForeground} />
      </Pressable>
      <Pressable
        onPress={() => {
          onRemove(passkey);
        }}
        disabled={disabled}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('common.remove')}
        className="min-h-[44px] min-w-[44px] shrink-0 items-center justify-center active:opacity-70"
      >
        <Trash2 size={16} color={colors.destructive} />
      </Pressable>
    </View>
  );
}
