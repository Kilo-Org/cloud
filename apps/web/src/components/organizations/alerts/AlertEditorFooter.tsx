'use client';

import { Button } from '@/components/ui/button';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import type { OrganizationAlertLifecycleActions } from './types';

/**
 * Shared action bar for every alert editor. Disable is separated from terminal
 * Archive, and archiving confirms inline rather than in a dialog: the drawer
 * stack renders above the dialog layer, so a modal opened from inside a drawer
 * appears behind it and cannot be clicked.
 */
export function AlertEditorFooter({
  mode,
  isSaving,
  canExpand,
  onSave,
  onCancel,
  lifecycle,
}: {
  mode: 'create' | 'edit';
  isSaving: boolean;
  /**
   * Whether the organization may still create or enable alerts. Creating and
   * enabling are expansions of the disclosure, so they follow entitlement, while
   * an existing alert can always be saved with narrowing changes, disabled, or
   * archived.
   */
  canExpand: boolean;
  onSave: () => void;
  onCancel: () => void;
  lifecycle: OrganizationAlertLifecycleActions | null;
}) {
  const isBusy = isSaving || (lifecycle?.isUpdatingEnabled ?? false);
  const cannotEnable = lifecycle !== null && !lifecycle.isEnabled && !canExpand;
  return (
    <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t bg-surface-raised px-5 py-3">
      {lifecycle && (
        <>
          <InlineDeleteConfirmation
            showAsButton
            buttonText="Archive"
            confirmText="Archive permanently"
            warningText="Archiving is permanent. This alert stops being evaluated and cannot be edited or re-enabled."
            isLoading={lifecycle.isArchiving}
            disabled={isBusy}
            onDelete={lifecycle.onArchive}
            className="mr-auto"
          />
          <Button
            variant="outline"
            disabled={isBusy || lifecycle.isArchiving || cannotEnable}
            title={
              cannotEnable ? 'Enabling an alert requires an Enterprise organization.' : undefined
            }
            onClick={() => lifecycle.onSetEnabled(!lifecycle.isEnabled)}
          >
            {lifecycle.isUpdatingEnabled ? 'Saving...' : lifecycle.isEnabled ? 'Disable' : 'Enable'}
          </Button>
        </>
      )}
      <Button variant="outline" onClick={onCancel}>
        Cancel
      </Button>
      <Button disabled={isBusy || (mode === 'create' && !canExpand)} onClick={onSave}>
        {isSaving ? 'Saving...' : mode === 'create' ? 'Create alert' : 'Save changes'}
      </Button>
    </div>
  );
}
