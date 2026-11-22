'use client';

import { Button } from '@/components/ui/button';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';

/**
 * Shared action bar for every policy editor.
 *
 * Removal confirms inline rather than in a dialog: the drawer stack renders
 * above the dialog layer, so a modal opened from inside a drawer appears behind
 * it and cannot be clicked.
 */
export function PolicyEditorFooter({
  isSaving,
  onSave,
  onCancel,
  onDelete,
  isDeleting,
}: {
  isSaving: boolean;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => Promise<void> | void;
  isDeleting?: boolean;
}) {
  return (
    <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t bg-surface-raised px-5 py-3">
      {onDelete && (
        <InlineDeleteConfirmation
          showAsButton
          buttonText="Remove policy"
          confirmText="Remove"
          isLoading={isDeleting}
          onDelete={onDelete}
          className="mr-auto"
        />
      )}
      <Button variant="outline" onClick={onCancel}>
        Cancel
      </Button>
      <Button disabled={isSaving} onClick={onSave}>
        {isSaving ? 'Saving...' : 'Save policy'}
      </Button>
    </div>
  );
}
