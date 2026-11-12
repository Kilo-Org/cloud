import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useContextPicker } from '@/components/context-control';
import { useTRPC } from '@/lib/trpc';

/**
 * The Home header's account picker, opened. The picker is imperative: the
 * header button is its only entry, and a design-gate run cannot press it from a
 * link, so this route opens the same picker over the same membership list. It
 * reads `organizations.list` exactly as the header does and hands the result to
 * the shared `useContextPicker`, so the sheet a run measures is the sheet the
 * header renders, with whatever memberships the account actually holds.
 *
 * The picker is a route of its own, so opening it presents
 * `(app)/context-picker` over this fixture. A pick switches the account's
 * active organization; the gate only reads, and the account that runs it is a
 * development account.
 */
export function AccountPickerSheetFixture() {
  const trpc = useTRPC();
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

  return null;
}