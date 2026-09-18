/**
 * Pure view-model helpers for the profile Environment variables screen.
 *
 * No React and no React Native imports: every function here is unit-tested
 * directly in `profile-variables-model.test.ts`. The screen owns rendering and
 * network calls; this module owns the masked/visible row shape, the client-side
 * validation that runs before a `setVar`, and the local list update a saved
 * edit applies.
 */

import { VARIABLE_KEY_MAX_LENGTH } from '@/lib/agent-profile-forms';

/** The fields of a variable the screen reads. Structural, so a test needs no tRPC type. */
export type ProfileVarSource = Readonly<{
  key: string;
  value: string;
  isSecret: boolean;
}>;

/** One environment-variable row as the screen renders it. */
export type VariableRow = Readonly<{
  key: string;
  /** The value the server returned. A secret arrives already masked as `***`. */
  value: string;
  isSecret: boolean;
  /** What the row shows while hidden: a dot run for a secret, the value otherwise. */
  maskedValue: string;
}>;

/** The dot run a hidden secret renders instead of its value. */
export const SECRET_MASK = '••••••••';

/**
 * Render rows from the profile's variables. A secret is masked by default: the
 * server only ever sends `***` for one, so a row the user just saved — whose
 * value is still local — is the only place a secret value can be revealed.
 */
export function variableRows(vars: readonly ProfileVarSource[]): VariableRow[] {
  return vars.map(v => ({
    key: v.key,
    value: v.value,
    isSecret: v.isSecret,
    maskedValue: v.isSecret ? SECRET_MASK : v.value,
  }));
}

export type VariableInputError = 'empty' | 'too-long';

/**
 * Validate the edited variable before a save. Matches the server's
 * `VarSchema` key bound (`z.string().min(1).max(256)`); `value` is part of the
 * form's input but unconstrained, matching the server. Returns an error code,
 * or `null` when valid.
 */
export function validateVariableInput(
  input: Readonly<{ key: string; value: string }>
): VariableInputError | null {
  const key = input.key.trim();
  if (key.length === 0) {
    return 'empty';
  }
  if (key.length > VARIABLE_KEY_MAX_LENGTH) {
    return 'too-long';
  }
  return null;
}

/** A saved environment variable, as the screen sends it to `setVar`. */
export type VariableEdit = Readonly<{ key: string; value: string; isSecret: boolean }>;

/**
 * Apply a saved edit to the local list: replace the row with the same key, or
 * append a new one, and keep the key order the `get` query returns. The screen
 * calls this after `setVar` resolves so the row shows the saved value while the
 * invalidated detail query refetches.
 */
export function applyVariableEdit(
  vars: readonly ProfileVarSource[],
  edit: VariableEdit
): ProfileVarSource[] {
  const exists = vars.some(v => v.key === edit.key);
  const next = exists
    ? vars.map(v => (v.key === edit.key ? { ...v, value: edit.value, isSecret: edit.isSecret } : v))
    : [...vars, { key: edit.key, value: edit.value, isSecret: edit.isSecret }];
  // eslint-disable-next-line unicorn/no-array-sort -- Hermes does not implement Array.prototype.toSorted; map/spread already copies so nothing shared is mutated
  return next.sort(compareVariableKeys);
}

function compareVariableKeys(a: ProfileVarSource, b: ProfileVarSource): number {
  if (a.key < b.key) {
    return -1;
  }
  if (a.key > b.key) {
    return 1;
  }
  return 0;
}
