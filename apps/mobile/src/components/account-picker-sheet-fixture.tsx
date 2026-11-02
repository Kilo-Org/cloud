import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useContextPicker } from '@/components/context-control';
import { useTRPC } from '@/lib/trpc';

/**
 * The Home header's account picker, open. The sheet is imperative: the header
 * button is its only entry, and a design-gate run cannot press it from a link,
 * so this route opens the same picker over the same membership list. It reads
 * `organizations.list` exactly as the header does and hands the result to the
 * shared `useContextPicker`, so the sheet a run measures is the sheet the header
 * renders, with whatever memberships the account actually holds.
 *
 * The picker is the real one, so a pick switches the account's active
 * organization; the gate only reads, and the account that runs it is a
 * development account.
 */
export function AccountPickerSheetFixture() {
  const trpc = useTRPC();
  const organizations = useQuery(trpc.organizations.list.queryOptions());
  const { openPicker, picker } = useContextPicker(organizations.data);

  // The header's control refuses to open while the list is still loading, so a
  // fixture that opened it on mount would measure nothing; opening once the
  // rows exist is the state the header reaches after the list settles.
  useEffect(() => {
    openPicker();
  });

  return picker;
}
