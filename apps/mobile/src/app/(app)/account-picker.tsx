import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AccountPickerSheet } from '@/components/account-picker-sheet';
import { PickerSheet } from '@/components/picker-sheet';
import { accountPickerSlot, UNFENCED_ROUTE_KEY, useRouteRegistry } from '@/lib/route-registry';

/**
 * The account picker, presented as the standard native formSheet. The opener
 * seeds the bridge with its rows and the account its screen shows; a pick
 * reports the chosen account and this route closes.
 *
 * The sheet is a route, not an in-tree native sheet, so Back belongs to the
 * navigator: a press during the presentation closes this route and keeps the
 * screen under it, the way every other picker sheet behaves.
 */
export default function AccountPickerScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  useRouteRegistry(UNFENCED_ROUTE_KEY);
  // Lazy init reads the slot synchronously on first render — no effect, no
  // "Options expired" flash before a later effect populates state.
  const [bridge] = useState(() => accountPickerSlot.get(UNFENCED_ROUTE_KEY));

  function close() {
    router.back();
  }

  if (!bridge) {
    return (
      <PickerSheet
        title={t('profile.selectAccount')}
        onDone={close}
        scrollable={false}
        topInset="never"
        expired
      />
    );
  }

  return (
    <AccountPickerSheet
      title={t('profile.selectAccount')}
      rows={bridge.rows}
      shownOrganizationId={bridge.shownOrganizationId}
      onClose={close}
      onSelect={organizationId => {
        // The route dismisses first: a caller whose pick changes the screen
        // (the new-session composer replaces itself with the new account's
        // form) then acts on the screen under the sheet, not on the sheet.
        accountPickerSlot.clear(UNFENCED_ROUTE_KEY);
        router.back();
        bridge.onSelect(organizationId);
      }}
    />
  );
}