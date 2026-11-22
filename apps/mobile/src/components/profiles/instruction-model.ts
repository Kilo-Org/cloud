/**
 * Pure view-model helpers for the profile Instructions screen.
 *
 * No React and no React Native imports: the sheet renders these directly and
 * they are unit-tested on their own. The name rules themselves stay in
 * `@/lib/agent-profile-forms`, the one place the server's bounds are mirrored.
 */

import { cleanInstructionName, type InstructionInputError } from '@/lib/agent-profile-forms';

/** The `profiles.*` copy key for each `validateInstructionInput` error code. */
const INSTRUCTION_ERROR_KEYS = {
  empty: 'profiles.instructionNameRequired',
  'too-long': 'profiles.instructionNameTooLong',
  'bad-name': 'profiles.instructionNameInvalid',
  reserved: 'profiles.instructionNameReserved',
  'no-content': 'profiles.instructionContentRequired',
  'content-too-long': 'profiles.tooLong',
} satisfies Record<InstructionInputError, string>;

/** The copy key the sheet shows for a refused instruction input. */
export function instructionErrorKey(error: InstructionInputError): string {
  return INSTRUCTION_ERROR_KEYS[error];
}

/**
 * What the sheet states under the name field, as one state per outcome:
 *
 * - `none`: nothing to say, because the field is blank or the name saves as typed.
 * - `preview`: a save will store `slug`, so a normalization is never silent.
 * - `rule`: the fold leaves no ASCII name at all, so a save would refuse this
 *   input as `bad-name`. The rule is stated before Save, not only after it.
 */
export type InstructionNameHint =
  | { readonly kind: 'none' }
  | { readonly kind: 'rule' }
  | { readonly kind: 'preview'; readonly slug: string };

/** The hint the sheet shows for the name as typed. */
export function instructionNameHint(typed: string): InstructionNameHint {
  const trimmed = typed.trim();
  if (trimmed.length === 0) {
    return { kind: 'none' };
  }
  const saved = cleanInstructionName(trimmed);
  if (saved.length === 0) {
    return { kind: 'rule' };
  }
  return saved === trimmed ? { kind: 'none' } : { kind: 'preview', slug: saved };
}

/**
 * One value per hint, so a keystroke that leaves the hint the same keeps the
 * previous object. The sheet stores the hint to render it, and a fresh object
 * on every character would re-render the whole form on typing that changes
 * nothing, which `lib/form-draft` forbids.
 */
export function instructionNameHintKey(hint: InstructionNameHint): string {
  return hint.kind === 'preview' ? `preview:${hint.slug}` : hint.kind;
}

/**
 * The copy key for an error that belongs under the content field, or `null`
 * for every error the name field owns. The two content errors differ in the
 * bound they name, so the sheet passes the content bound when it renders it.
 */
export function instructionContentErrorKey(error: InstructionInputError | null): string | null {
  if (error === 'no-content') {
    return 'profiles.instructionContentRequired';
  }
  if (error === 'content-too-long') {
    return 'profiles.tooLong';
  }
  return null;
}

/** The name field's error, or `null` for every error that belongs to the content. */
export function instructionNameErrorShown(error: InstructionInputError): boolean {
  return error === 'empty' || error === 'too-long' || error === 'bad-name' || error === 'reserved';
}
