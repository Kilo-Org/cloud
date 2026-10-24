import { type RefObject, useRef } from 'react';

import { type BackendFormFields } from './backend-form-state';

/**
 * Report whether a backend form's fields differ from what it opened with.
 *
 * The fields are uncontrolled, so a render cannot see a change: every handler
 * writes the ref and then calls the returned reporter. Comparing against the
 * values captured at mount also clears the flag when an edit is undone, so a
 * sheet only asks before a Change or Android Back that really drops work.
 */
export function useBackendFormDirty(
  fields: RefObject<BackendFormFields>,
  onDirtyChange: ((dirty: boolean) => void) | undefined
): () => void {
  // Copy the list: a later model row add or edit must not rewrite the rows this
  // compares against.
  const opened = useRef({ ...fields.current, models: [...fields.current.models] });

  return () => {
    const current = fields.current;
    const initial = opened.current;
    onDirtyChange?.(
      current.name !== initial.name ||
        current.baseUrl !== initial.baseUrl ||
        current.apiKey !== initial.apiKey ||
        current.headers !== initial.headers ||
        current.apiKind !== initial.apiKind ||
        current.completionTokenField !== initial.completionTokenField ||
        JSON.stringify(current.models) !== JSON.stringify(initial.models)
    );
  };
}
