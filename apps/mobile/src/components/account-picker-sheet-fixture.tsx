import { useQuery } from '@tanstack/react-query';
import { useNavigation, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';

import { useContextPicker } from '@/components/context-control';
import { useTRPC } from '@/lib/trpc';

/**
 * The Home header's account picker, opened. A design-gate run cannot press the
 * header button from a link, so this route opens the same picker over the same
 * membership list: it reads `organizations.list` exactly as the header does and
 * hands the result to the shared `useContextPicker`, so the sheet a run
 * measures is the sheet the header renders, with whatever memberships the
 * account actually holds.
 *
 * The picker is a route of its own, so opening it presents
 * `(app)/context-picker` over this fixture. A pick switches the account's
 * active organization; the gate only reads, and the account that runs it is a
 * development account.
 *
 * Link: `kiloapp:///dev/account-picker-sheet-fixture`, mapped in
 * `src/app/+native-intent.tsx`.
 */
export function AccountPickerSheetFixture() {
  const trpc = useTRPC();
  const router = useRouter();
  const navigation = useNavigation();
  const organizations = useQuery(trpc.organizations.list.queryOptions());
  const { openPicker } = useContextPicker(organizations.data);
  // The header's control refuses to open while the list is still loading, so
  // opening on mount would measure nothing. Open once, the first time the rows
  // exist — the state the header reaches after the list settles — and never
  // again, so dismissing the picker keeps it dismissed.
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    if (opened || organizations.data === undefined) {
      return;
    }
    setOpened(true);
    openPicker();
  }, [opened, organizations.data, openPicker]);

  // This route draws nothing of its own, so once the picker is gone (Done, a
  // pick, Back or a swipe down) it leaves too: the person returns to the
  // screen that opened the link instead of a blank page. A focus event comes
  // only from a transition, so it fires when the picker above is dismissed and
  // never for the focus this route already held when the picker was pushed.
  useEffect(
    () =>
      navigation.addListener('focus', () => {
        if (!opened) {
          return;
        }
        if (router.canGoBack()) {
          router.back();
          return;
        }
        router.replace('/');
      }),
    [navigation, opened, router]
  );

  return null;
}
