import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useMemo,
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

/** Test-only: no case may see a draft an earlier case left behind. */
export function resetFormDraftsForTests(): void {
  drafts.clear();
}

/**
 * `useState` for one form field, seeded from the scope's draft when the form is
 * mounting again after a remount and mirrored back on every change.
 */
export function useFormDraftState<T>(
  scope: string,
  name: string,
  initial: T
): readonly [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    // The store holds `unknown` because it keeps every scope's shape at once.
    const stored = drafts.get(draftKey(scope, name)) as T | undefined;
    return stored ?? initial;
  });
  useEffect(() => {
    writeDraft(scope, name, value);
  }, [scope, name, value]);
  return [value, setValue] as const;
}

/**
 * `useRef` for one uncontrolled form field: `current` reads and writes the
 * scope's draft, so the text an input holds is restored by its `defaultValue`
 * after a remount and a keystroke never re-renders the form.
 */
export function useFormDraftRef<T>(scope: string, name: string, initial: T): RefObject<T> {
  return useMemo(
    () => ({
      get current(): T {
        const stored = drafts.get(draftKey(scope, name)) as T | undefined;
        return stored ?? initial;
      },
      set current(value: T) {
        writeDraft(scope, name, value);
      },
    }),
    [scope, name, initial]
  );
}
