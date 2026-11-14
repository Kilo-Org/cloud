/**
 * The selection one blocking question holds, as a value per question mode.
 *
 * A single-choice question answers with one preset or the custom field, never
 * both, so `SingleAnswer` has no member that holds several presets beside a
 * custom answer. A multi-choice question may answer with any set of presets,
 * the custom field, or both. The typed text itself is not part of the answer:
 * the card keeps it in a ref and reads it here only when the answer says the
 * custom field is in use, so text the card would not submit cannot appear as a
 * selection.
 */

/** A single-choice answer: one preset, or the custom field, never both. */
export type SingleAnswer =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly choice: number }
  | { readonly kind: 'custom' };

/** A multi-choice answer: any set of presets, optionally with the custom field. */
export type MultiAnswer =
  | { readonly kind: 'none' }
  | { readonly kind: 'presets'; readonly chosen: ReadonlySet<number> }
  | { readonly kind: 'custom' }
  | { readonly kind: 'presets-and-custom'; readonly chosen: ReadonlySet<number> };

export const SINGLE_NONE: SingleAnswer = { kind: 'none' };
export const MULTI_NONE: MultiAnswer = { kind: 'none' };

/** Choose one preset on a single-choice question; it replaces the previous answer. */
export function pressSingleChoice(answer: SingleAnswer, choice: number): SingleAnswer {
  return answer.kind === 'one' && answer.choice === choice ? answer : { kind: 'one', choice };
}

/**
 * Choose the custom field on a single-choice question. A radio re-press keeps
 * the answer — and its typed text — as it is.
 */
export function pressSingleCustom(answer: SingleAnswer): SingleAnswer {
  return answer.kind === 'custom' ? answer : { kind: 'custom' };
}

/** Select the custom field for a single-choice question while it holds text; empty text clears it. */
export function typeSingleCustom(answer: SingleAnswer, hasText: boolean): SingleAnswer {
  if (!hasText) {
    return SINGLE_NONE;
  }
  return answer.kind === 'custom' ? answer : { kind: 'custom' };
}

/** Add or remove one preset, keeping the custom field when it is already in use. */
export function toggleMultiChoice(answer: MultiAnswer, choice: number): MultiAnswer {
  if (answer.kind !== 'presets' && answer.kind !== 'presets-and-custom') {
    const withChoice: ReadonlySet<number> = new Set([choice]);
    return answer.kind === 'custom'
      ? { kind: 'presets-and-custom', chosen: withChoice }
      : { kind: 'presets', chosen: withChoice };
  }
  const chosen = new Set(answer.chosen);
  if (chosen.has(choice)) {
    chosen.delete(choice);
  } else {
    chosen.add(choice);
  }
  if (answer.kind === 'presets-and-custom') {
    return chosen.size > 0 ? { kind: 'presets-and-custom', chosen } : { kind: 'custom' };
  }
  return chosen.size > 0 ? { kind: 'presets', chosen } : MULTI_NONE;
}

/** Add or remove the custom field, keeping any chosen presets. */
export function toggleMultiCustom(answer: MultiAnswer): MultiAnswer {
  if (answer.kind === 'presets') {
    return { kind: 'presets-and-custom', chosen: answer.chosen };
  }
  if (answer.kind === 'presets-and-custom') {
    return answer.chosen.size > 0 ? { kind: 'presets', chosen: answer.chosen } : MULTI_NONE;
  }
  return answer.kind === 'custom' ? MULTI_NONE : { kind: 'custom' };
}

/** Select the custom field while it holds text; empty text removes it and keeps the presets. */
export function typeMultiCustom(answer: MultiAnswer, hasText: boolean): MultiAnswer {
  if (answer.kind === 'presets' || answer.kind === 'presets-and-custom') {
    if (!hasText) {
      return answer.chosen.size > 0 ? { kind: 'presets', chosen: answer.chosen } : MULTI_NONE;
    }
    return { kind: 'presets-and-custom', chosen: answer.chosen };
  }
  if (answer.kind === 'none') {
    return hasText ? { kind: 'custom' } : answer;
  }
  return hasText ? answer : MULTI_NONE;
}

/** True while the custom field is part of the answer the card would submit. */
export function isCustomSelected(answer: SingleAnswer | MultiAnswer): boolean {
  return answer.kind === 'custom' || answer.kind === 'presets-and-custom';
}

/** The submitted labels of one question: chosen presets in press order, then the custom text. */
export function answerLabels(
  answer: SingleAnswer | MultiAnswer,
  customText: string,
  options: readonly { readonly label: string }[]
): string[] {
  const custom = customText.trim();
  if (answer.kind === 'one') {
    return [options[answer.choice]?.label ?? ''];
  }
  if (answer.kind === 'custom') {
    return custom ? [custom] : [];
  }
  if (answer.kind === 'none') {
    return [];
  }
  const labels = [...answer.chosen].map(index => options[index]?.label ?? '');
  return answer.kind === 'presets-and-custom' && custom ? [...labels, custom] : labels;
}

/** True when the question has an answer the card can submit. */
export function isAnswered(answer: SingleAnswer | MultiAnswer, customText: string): boolean {
  if (answer.kind === 'none') {
    return false;
  }
  return answer.kind !== 'custom' || customText.trim().length > 0;
}
