import { useCallback, useEffect, useRef } from 'react';

import { clearDraft, type DraftShapeValidator, saveDraft } from '@/lib/persist/drafts';
import { useDraftFlushOnBackground } from '@/lib/persist/use-draft-flush';
import { useFencedDraftLoad } from '@/lib/persist/use-draft-load';

/**
 * A write a form issued before its stored draft answered, replayed once it
 * does. A later save replaces an earlier held save; a clear discards a held
 * save, because a clear means the person threw the draft away.
 */
type PendingWrite<T> = { readonly kind: 'save'; readonly value: T } | { readonly kind: 'clear' };

/** What a durable form draft reports to its form. */
export type FormDraftState<T> =
  | {
      /**
       * The stored draft has not loaded yet. A form mounts its fields only in
       * this state's absence: the fields are uncontrolled and read
       * `defaultValue` once, so seeding them before the load settles would
       * drop the restored text. `save` and `clear` are still offered here: an
       * edit form is on screen before the load settles, and a write it takes
       * then must reach the store rather than be dropped, so the hook holds it
       * and replays it once the draft answers.
       */
      readonly kind: 'loading';
      readonly save: (value: T) => void;
      readonly clear: () => void;
    }
  | {
      readonly kind: 'ready';
      /** The stored draft, or `null` when the key holds none. */
      readonly value: T | null;
      /** Schedule the debounced write of `value` for this form's key. */
      readonly save: (value: T) => void;
      /** Cancel the pending write and remove the entry (save landed, or Discard). */
      readonly clear: () => void;
    };

/**
 * One form's durable draft: the text a person typed into a form that a
 * language-direction change would otherwise discard.
 *
 * A device language change that flips the text direction reloads the JS bundle
 * (`apply-language.ts`), which kills the React tree without running its
 * cleanup. A form that keeps its draft only in refs and state comes back empty,
 * so an organization form keeps it here instead — the same encrypted,
 * account-scoped store the composers and the new-session form use.
 *
 * The key names the form's own record (`org-mode-form:<org>:<id|new>`), so two
 * records of one screen never share a draft. A form with no identity yet stays
 * `loading`, which also covers the sign-in transition: a draft typed under one
 * account can never seed the next one.
 *
 * The pending write is flushed when the app leaves `active` and when the form
 * unmounts, and `flushAllDrafts` writes it before the reload; `clear` drops it
 * once the draft became the saved record or the person discarded it.
 */
export function useFormDraft<T>(input: {
  userId: string | undefined;
  isIdentityLoading: boolean;
  entityKey: string;
  /** The stored shape guard; a value another build wrote stays stored instead. */
  validate: DraftShapeValidator<T>;
}): FormDraftState<T> {
  const { userId, isIdentityLoading, entityKey, validate } = input;
  const draft = useFencedDraftLoad<T>({ userId, isIdentityLoading, entityKey, validate });
  useDraftFlushOnBackground(userId, entityKey, true);
  // The key the clear names, read when it runs: a form that stayed mounted
  // across a key change (a save that replaced a create route with an edit
  // route) must clear the key the save wrote, not the one it opened with.
  const keyRef = useRef({ userId, entityKey });
  keyRef.current = { userId, entityKey };

  // A form can be typed into before its stored draft answers (an edit form
  // paints the server row at once). The write goes straight to `saveDraft`, the
  // store's own layer, as soon as the identity gives it a key: that is what the
  // pre-reload flush and the unmount flush read, so a reload inside the load
  // window still keeps the keystroke. Only an identity that has not resolved
  // yet has nowhere to write, and that write is held until it does.
  const pendingRef = useRef<PendingWrite<T> | null>(null);
  const write = useCallback((entry: PendingWrite<T>) => {
    const { userId: currentUserId, entityKey: currentKey } = keyRef.current;
    if (currentUserId === undefined) {
      return false;
    }
    if (entry.kind === 'save') {
      saveDraft(currentUserId, currentKey, entry.value);
    } else {
      void clearDraft(currentUserId, currentKey);
    }
    return true;
  }, []);

  const save = useCallback(
    (value: T) => {
      if (!write({ kind: 'save', value })) {
        pendingRef.current = { kind: 'save', value };
      }
    },
    [write]
  );

  const clear = useCallback(() => {
    if (!write({ kind: 'clear' })) {
      pendingRef.current = { kind: 'clear' };
    }
  }, [write]);

  const ready = userId !== undefined && draft.settled;
  // The identity resolving is the one event that can release a held write.
  const identity = userId ?? '';
  useEffect(() => {
    const pending = pendingRef.current;
    if (pending === null) {
      return;
    }
    if (write(pending)) {
      pendingRef.current = null;
    }
  }, [identity, write]);

  const state: FormDraftState<T> = ready
    ? { kind: 'ready', value: draft.value, save, clear }
    : { kind: 'loading', save, clear };
  return state;
}
