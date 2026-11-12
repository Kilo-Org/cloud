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
 * The name a save will store, when it differs from what was typed; `null` when
 * the typed name saves unchanged or the field is blank. The sheet renders this
 * under the name field, so a normalization is never silent.
 */
export function instructionNamePreview(typed: string): string | null {
  const trimmed = typed.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const saved = cleanInstructionName(trimmed);
  return saved === trimmed || saved.length === 0 ? null : saved;
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
