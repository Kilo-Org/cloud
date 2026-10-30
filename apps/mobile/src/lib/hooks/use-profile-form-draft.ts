import { useCallback } from 'react';

import { clearFormDraft, useFormDraftRef, useFormDraftState } from '@/lib/form-draft';

/** The add/edit form a profile screen has open, and the row it edits. */
export type ProfileFormDraft<T> = Readonly<{
  /** Whether a form is open at all: the add form, or an edit of a row that exists. */
  isOpen: boolean;
  /** The row the open form edits, or `null` for the add form. */
  editing: T | null;
  /** Every open and close bumps this, so a save that settles late can tell it is stale. */
  generation: () => number;
  startAdd: () => void;
  startEdit: (item: T) => void;
  close: () => void;
}>;

/**
 * The add/edit form a profile screen owns, kept as a draft (`lib/form-draft`).
 * A remount reopens the same form on the fields it had, instead of dropping
 * what the reader typed; closing or saving clears the draft, so the next open
 * starts from the server's copy. An edit whose row is gone, e.g. deleted
 * elsewhere while the screen was away, reads as closed rather than opening the
 * add form on another row's text.
 */
export function useProfileFormDraft<T extends { id: string }>(
  scope: string,
  items: readonly T[]
): ProfileFormDraft<T> {
  const [open, setOpen] = useFormDraftState<{ id: string | null } | null>(scope, 'open', null);
  const generationRef = useFormDraftRef(`${scope}:generation`, 'value', 0);

  const startAdd = useCallback(() => {
    generationRef.current += 1;
    clearFormDraft(scope);
    setOpen({ id: null });
  }, [generationRef, scope, setOpen]);

  const startEdit = useCallback(
    (item: T) => {
      generationRef.current += 1;
      clearFormDraft(scope);
      setOpen({ id: item.id });
    },
    [generationRef, scope, setOpen]
  );

  const close = useCallback(() => {
    generationRef.current += 1;
    setOpen(null);
    clearFormDraft(scope);
  }, [generationRef, scope, setOpen]);

  const editingId = open?.id ?? null;
  const editing = editingId === null ? null : (items.find(item => item.id === editingId) ?? null);

  return {
    isOpen: editingId === null ? open !== null : editing !== null,
    editing,
    generation: () => generationRef.current,
    startAdd,
    startEdit,
    close,
  };
}
