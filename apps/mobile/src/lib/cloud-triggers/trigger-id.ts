/**
 * The trigger-name rules the server enforces on `webhookTriggers.create` and
 * `webhookTriggers.get`.
 *
 * The rule set lives in `apps/web/src/lib/webhook-trigger-validation.ts`, which
 * the app cannot import (an `apps/web` path is not part of the mobile module
 * graph). The name is the last segment of the webhook URL, so the same three
 * constraints are restated here and the form shows them inline instead of
 * sending a request the server is certain to reject.
 *
 * No React and no React Native imports: the rules are unit-tested directly.
 */

/** Reserved names the server refuses, because a route under the trigger's path uses them. */
const RESERVED_TRIGGER_IDS: readonly string[] = [
  'new',
  'edit',
  'delete',
  'requests',
  'settings',
  'api',
  'admin',
];

/** A new trigger's name is part of a public URL, so it may not be trivially guessable. */
export const MIN_CREATE_TRIGGER_NAME_LENGTH = 8;

export const MAX_TRIGGER_NAME_LENGTH = 64;

/**
 * Why a trigger name is refused, or `null` when it is accepted.
 *
 * A name kept from an existing trigger is validated with `edit`: the server
 * accepts any stored name that matches its current pattern, even one shorter
 * than the creation minimum.
 */
export type TriggerNameProblem =
  | 'required'
  | 'tooLong'
  | 'characters'
  | 'reserved'
  | 'tooShort';

export function triggerNameProblem(
  name: string,
  mode: 'create' | 'edit'
): TriggerNameProblem | null {
  if (name.length === 0) {
    return 'required';
  }
  if (name.length > MAX_TRIGGER_NAME_LENGTH) {
    return 'tooLong';
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    return 'characters';
  }
  if (RESERVED_TRIGGER_IDS.includes(name)) {
    return 'reserved';
  }
  if (mode === 'create' && name.length < MIN_CREATE_TRIGGER_NAME_LENGTH) {
    return 'tooShort';
  }
  return null;
}
