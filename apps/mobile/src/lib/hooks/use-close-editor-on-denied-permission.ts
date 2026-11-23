import { useEffect, useRef } from 'react';

import { type OrganizationProfilePermission } from '@/lib/hooks/use-can-manage-profiles';

/**
 * Close an open profile editor once the permission reads `read-only`, so the
 * flow lasts only as long as the permission that allows it.
 *
 * The open state of these editors and the fields they hold are a draft
 * (`lib/form-draft`), so a remount reopens them, and the server refuses their
 * write without the manage role. Hiding the form keeps the screen in step with
 * the manage slot; this drops the stored draft with it, so a remount cannot
 * reopen the form, and a save that settles afterwards is stale against the
 * generation the close bumps.
 *
 * `resolving` keeps the draft. The role is not known then, which includes a
 * failed read of the membership list, so the server may still accept the save
 * and dropping the draft would throw away what the reader typed. A permission
 * that resolves back to `allowed` therefore reopens the form on its text.
 *
 * `close` may be re-created on every render; the effect reads the latest one,
 * so the draft is dropped once per transition rather than once per render.
 */
export function useCloseEditorOnDeniedPermission(
  permission: OrganizationProfilePermission,
  close: () => void
): void {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  }, [close]);
  useEffect(() => {
    if (permission === 'read-only') {
      closeRef.current();
    }
  }, [permission]);
}
