import { useCallback } from 'react';

import { clearFormDraft, useFormDraftRef, useFormDraftState } from '@/lib/form-draft';

/** The add/edit form a profile screen has open, the row it edits, and its own notes. */
export type ProfileFormDraft<T, TNotes> = Readonly<{
  /** Whether a form is open at all: the add form, or an edit of a row that exists. */
  isOpen: boolean;
  /** The row the open form edits, or `null` for the add form. */
  editing: T | null;
  /**
   * Whatever the screen renders inside the open form beside its fields, such as
   * the refusal of the last save. It belongs to this draft on purpose: opening
   * or closing the form resets it with everything else the previous form held.
   */
  notes: TNotes;
  setNotes: (next: TNotes) => void;
  /** Every open and close bumps this, so a save that settles late can tell it is stale. */
  generation: () => number;
  /**
   * Whether the form that started a save is still the one on screen. A save
   * reads the generation when it starts and writes nothing (no note, no close)
   * once a later open or close has replaced or dismissed that form.
   */
  isCurrent: (generation: number) => boolean;
  startAdd: () => void;
  startEdit: (item: T) => void;
  close: () => void;
}>;

type OpenForm<TNotes> = { readonly id: string | null; readonly notes: TNotes };

/**
 * The add/edit form a profile screen owns, kept as a draft (`lib/form-draft`).
 * A remount reopens the same form on the fields and notes it had, instead of
 * dropping what the reader typed; closing or saving clears the draft, so the
 * next open starts from the server's copy. An edit whose row is gone, e.g.
 * deleted elsewhere while the screen was away, reads as closed rather than
 * opening the add form on another row's text.
 */
export function useProfileFormDraft<T extends { id: string }, TNotes>(
  scope: string,
  items: readonly T[],
  initialNotes: TNotes
): ProfileFormDraft<T, TNotes> {
  // One entry holds the whole form, so its open state, the row it edits and its
  // notes cannot disagree: every transition writes all three and clearing the
  // draft drops all three.
  const [draft, setDraft] = useFormDraftState<OpenForm<TNotes> | null>(scope, 'form', null);
  const generationRef = useFormDraftRef(`${scope}:generation`, 'value', 0);

  const begin = useCallback(
    (id: string | null) => {
      generationRef.current += 1;
      clearFormDraft(scope);
      setDraft({ id, notes: initialNotes });
    },
    [generationRef, initialNotes, scope, setDraft]
  );

  const startAdd = useCallback(() => {
    begin(null);
  }, [begin]);

  const startEdit = useCallback(
    (item: T) => {
      begin(item.id);
    },
    [begin]
  );

  const close = useCallback(() => {
    generationRef.current += 1;
    clearFormDraft(scope);
    setDraft(null);
  }, [generationRef, scope, setDraft]);

  const setNotes = useCallback(
    (next: TNotes) => {
      setDraft(current => (current === null ? null : { ...current, notes: next }));
    },
    [setDraft]
  );

  const editingId = draft?.id ?? null;
  const editing = editingId === null ? null : (items.find(item => item.id === editingId) ?? null);

  return {
    isOpen: draft !== null && (editingId === null || editing !== null),
    editing,
    notes: draft?.notes ?? initialNotes,
    setNotes,
    generation: () => generationRef.current,
    isCurrent: (generation: number) => generationRef.current === generation,
    startAdd,
    startEdit,
    close,
  };
}
