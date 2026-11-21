/**
 * Which field problems a form block may show yet.
 *
 * A trigger form opens with an empty draft, so every required field has a
 * problem before the person has done anything; showing them all at once reads as
 * a stack of mistakes nobody made. A field's problem therefore appears only
 * after that field was visited: a text field on losing focus, a picker when its
 * picker opened.
 */

import { useState } from 'react';

import {
  type TriggerDraftField,
  type TriggerDraftProblems,
  type TriggerProblem,
} from './trigger-draft';

export function useTouchedProblems(problems: TriggerDraftProblems) {
  const [touched, setTouched] = useState<ReadonlySet<TriggerDraftField>>(() => new Set());
  return {
    markTouched: (field: TriggerDraftField): void => {
      setTouched(current => (current.has(field) ? current : new Set(current).add(field)));
    },
    shownProblem: (field: TriggerDraftField): TriggerProblem | undefined =>
      touched.has(field) ? problems[field] : undefined,
  };
}
