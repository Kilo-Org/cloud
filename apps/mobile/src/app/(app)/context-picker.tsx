import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ContextPickerSheet } from '@/components/context-picker-sheet';
import { enterContextPicker } from '@/lib/picker-presentation';
import { contextPickerSlot, UNFENCED_ROUTE_KEY, useRouteRegistry } from '@/lib/route-registry';

/**
 * The account picker, presented as the standard native formSheet over whichever
 * screen opens it. Every surface that shows an account comes here through
 * `useContextPicker`, so the picker has one presentation and one Back rule
 * everywhere instead of each caller owning a native sheet.
 */
export default function ContextPickerScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  useRouteRegistry(UNFENCED_ROUTE_KEY);
  // The presented route is the only truth for "the sheet is open": openers
  // refuse while it is marked, so a second open cannot stack another copy. The
  // mark lasts the route's lifetime, so Done, a pick and Android Back all
  // release it through the same unmount.
  useEffect(() => enterContextPicker(), []);
  // Lazy init reads the slot synchronously on first render — no effect, no
  // "Options expired" flash before a later effect populates state.
  const [bridge] = useState(() => contextPickerSlot.get(UNFENCED_ROUTE_KEY));

  function close() {
    contextPickerSlot.clear(UNFENCED_ROUTE_KEY);
    router.back();
  }

  return (
    <ContextPickerSheet
      title={t('profile.selectAccount')}
      options={bridge?.options ?? []}
      currentIndex={bridge?.currentIndex ?? -1}
      onSelect={index => {
        bridge?.onSelect(index);
        close();
      }}
      onDone={close}
      expired={bridge === undefined}
    />
  );
}
