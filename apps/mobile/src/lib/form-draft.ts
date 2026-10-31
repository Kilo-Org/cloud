import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * Form drafts that outlive the component tree that typed them.
 *
 * A screen's own state dies with its React tree: Android can recreate the
 * activity that hosts it, and a route that is popped and pushed mounts a new
 * tree. Text someone has typed into a form is worth more than that, so a form
 * seeds its fields from this store and writes every edit back into it.
 *
 * Nothing is written to disk, so a typed secret stays in memory, and the values
 * are read synchronously, so a form never restores in two passes. The store
 * lives as long as the app process does; a draft dies with it.
 *
 * A draft is opt-in: a caller that passes no scope gets plain per-mount state,
 * so a form that should start empty every time, such as a composer's one-off
 * config, never inherits text from the last time it was opened.
 *
 * A scope is one form of one profile. `clearFormDraft` drops a whole scope once
 * the draft is saved or cancelled, so the next open seeds from the server.
 */
const drafts = new Map<string, unknown>();

function draftKey(scope: string, name: string): string {
  return `${scope}/${name}`;
}

function writeDraft(scope: string, name: string, value: unknown): void {
  drafts.set(draftKey(scope, name), value);
}

/** Drop every field the scope wrote, so the next mount seeds fresh. */
export function clearFormDraft(scope: string): void {
  const prefix = `${scope}/`;
  for (const key of drafts.keys()) {
    if (key.startsWith(prefix)) {
      drafts.delete(key);
    }
  }
}

/**
 * Drop every draft in the app. The account boundary calls this with the other
 * session-scoped stores, so a form typed under one account cannot reopen under
 * the next one.
 */
export function clearFormDrafts(): void {
  drafts.clear();
}

/** Test-only: no case may see a draft an earlier case left behind. */
export function resetFormDraftsForTests(): void {
  clearFormDrafts();
}

/**
 * `useState` for one form field, seeded from the scope's draft when the form is
 * mounting again after a remount and mirrored back on every change.
 */
export function useFormDraftState<T>(
  scope: string | undefined,
  name: string,
  initial: T
): readonly [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (scope === undefined) {
      return initial;
    }
    // The store holds `unknown` because it keeps every scope's shape at once.
    const stored = drafts.get(draftKey(scope, name)) as T | undefined;
    return stored ?? initial;
  });
  useEffect(() => {
    if (scope !== undefined) {
      writeDraft(scope, name, value);
    }
  }, [scope, name, value]);
  return [value, setValue] as const;
}

/**
 * `useRef` for one uncontrolled form field: `current` reads and writes the
 * scope's draft, so the text an input holds is restored by its `defaultValue`
 * after a remount and a keystroke never re-renders the form.
 */
export function useFormDraftRef<T>(
  scope: string | undefined,
  name: string,
  initial: T
): RefObject<T> {
  const local = useRef<T>(initial);
  return useMemo(() => {
    if (scope === undefined) {
      return local;
    }
    return {
      get current(): T {
        const stored = drafts.get(draftKey(scope, name)) as T | undefined;
        return stored ?? initial;
      },
      set current(value: T) {
        writeDraft(scope, name, value);
      },
    };
  }, [local, scope, name, initial]);
}
