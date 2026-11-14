import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { KeyRound } from '@/components/ui/icons';
import { IconTile } from '@/components/ui/icon-tile';
import { Text } from '@/components/ui/text';
import { NEUTRAL_TINT } from '@/lib/agent-color';
import { formatDate } from '@/lib/format';
import { parseTimestamp } from '@/lib/utils';

/** The passkey list as `user.getPasskeys` returns it; the types are derived, never copied. */
type PasskeysResult = inferRouterOutputs<MobileRouter>['user']['getPasskeys'];
export type PasskeyRow = PasskeysResult['passkeys'][number];

/** One passkey, read-only: its name (or the default when the server stored
 * none), the date it was added, and the date it was last used when the server
 * recorded one. Passkeys are managed in a web browser, so the row carries no
 * controls. */
export function PasskeyListRow({ passkey }: Readonly<{ passkey: PasskeyRow }>) {
  const { t, i18n } = useTranslation();
  const name = passkey.name?.trim();

  return (
    <View className="flex-row items-center gap-3 rounded-lg bg-secondary p-3">
      <IconTile icon={KeyRound} tint={NEUTRAL_TINT} />
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium" numberOfLines={1}>
          {name && name.length > 0 ? name : t('profile.passkeyDefaultName')}
        </Text>
        <Text variant="muted" className="mt-0.5 text-xs">
          {t('profile.passkeyAddedOn', {
            date: formatDate(parseTimestamp(passkey.created_at), i18n.language),
          })}
        </Text>
        {passkey.last_used_at !== null && (
          <Text variant="muted" className="mt-0.5 text-xs">
            {t('profile.passkeyLastUsedOn', {
              date: formatDate(parseTimestamp(passkey.last_used_at), i18n.language),
            })}
          </Text>
        )}
      </View>
    </View>
  );
}
