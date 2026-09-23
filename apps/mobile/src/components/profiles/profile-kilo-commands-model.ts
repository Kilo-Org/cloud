/**
 * Pure view-model helpers for the profile slash (kilo) commands screen.
 *
 * No React and no React Native imports: every function here is unit-tested
 * directly in `profile-kilo-commands-model.test.ts`. The screen owns rendering
 * and the network calls; this module owns the row projection, the add/edit form
 * state, the client-side validation that runs before a create/update, the
 * create-vs-update payload difference, and the up/down reorder the screen
 * persists through `reorderKiloCommands`.
 *
 * Ported from the web editor (`KiloCommandsTab.tsx`): the same reserved command
 * names, the same name pattern, and the same "undefined on create, null on
 * update" optional-field rule.
 */

import { moveCommand } from '@/lib/agent-profile-forms';

/**
 * Built-in command names reserved by the CLI. Mirrors `BUILTIN_COMMAND_NAMES`
 * in `@kilocode/cloud-agent-profile`; the mobile app does not depend on that
 * server package, so the set is repeated here. The server refuses a create or
 * rename that collides, so the form refuses it first.
 */
const BUILTIN_COMMAND_NAMES = new Set([
  'init',
  'review',
  'local-review',
  'local-review-uncommitted',
]);

const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Server bounds, mirrored so the form can refuse an over-long value before it
 * reaches the API: `kiloCommandNameSchema` caps the name at 50,
 * `kiloCommandCreateInputSchema` caps the description at 2000 and the template
 * at 100,000 (`packages/cloud-agent-profile/src/profile-kilo-commands-service.ts`).
 * The form passes these to the fields' `maxLength`, matching web's
 * `KiloCommandsTab` maxLength inputs, so the over-long value is never typed.
 */
export const MAX_KILO_COMMAND_NAME_LENGTH = 50;
export const MAX_KILO_COMMAND_DESCRIPTION_LENGTH = 2000;
export const MAX_KILO_COMMAND_TEMPLATE_LENGTH = 100_000;

/** The fields of a kilo command the screen reads. Structural, so tests are easy. */
export type KiloCommandSource = Readonly<{
  id: string;
  name: string;
  description: string | null;
  template: string;
  agent: string | null;
  model: string | null;
  subtask: boolean;
  enabled: boolean;
  sortOrder: number;
}>;

/** One slash command row as the screen renders it. */
export type KiloCommandRow = Readonly<{
  id: string;
  name: string;
  description: string;
  template: string;
  subtask: boolean;
  agent: string;
  model: string;
  enabled: boolean;
}>;

/** Project the profile's kilo commands into the rows the list renders. */
export function kiloCommandRows(commands: readonly KiloCommandSource[]): KiloCommandRow[] {
  return commands.map(command => ({
    id: command.id,
    name: command.name,
    description: command.description ?? '',
    template: command.template,
    subtask: command.subtask,
    agent: command.agent ?? '',
    model: command.model ?? '',
    enabled: command.enabled,
  }));
}

/**
 * The ordered ids after moving the command at `index` by `delta`, clamped to
 * the list's edges. Reuses the s2 list move the setup-commands screen uses, so
 * both reorder surfaces behave identically. The screen sends the whole order to
 * `reorderKiloCommands`; order is the only state.
 */
export function kiloCommandOrderAfterMove(
  commands: readonly KiloCommandSource[],
  index: number,
  delta: number
): string[] {
  return moveCommand(
    commands.map(command => command.id),
    index,
    delta
  );
}

/** The add/edit form fields. */
export type KiloCommandFormState = Readonly<{
  name: string;
  description: string;
  template: string;
  agent: string;
  model: string;
  subtask: boolean;
}>;

/** Seed the form from the command being edited, or blank defaults for an add. */
export function initialKiloCommandFormState(command?: KiloCommandSource): KiloCommandFormState {
  if (command === undefined) {
    return { name: '', description: '', template: '', agent: '', model: '', subtask: false };
  }
  return {
    name: command.name,
    description: command.description ?? '',
    template: command.template,
    agent: command.agent ?? '',
    model: command.model ?? '',
    subtask: command.subtask,
  };
}

export type KiloCommandFormError =
  | 'name-required'
  | 'name-invalid'
  | 'name-conflict'
  | 'template-required';

/**
 * Validate the form before a save. Returns the field at fault, or `null` when
 * valid. Mirrors the server's `kiloCommandNameSchema` and template minimum: a
 * non-empty name that starts with a lowercase letter, stays in `[a-z0-9-]`,
 * does not collide with a built-in command, and a non-empty template. The
 * server's name/template/description length bounds are enforced by the form
 * fields' `maxLength` (see the `MAX_KILO_COMMAND_*` constants), so an over-long
 * value cannot be typed in the first place.
 */
export function validateKiloCommandForm(state: KiloCommandFormState): KiloCommandFormError | null {
  const name = state.name.trim();
  if (name.length === 0) {
    return 'name-required';
  }
  if (!COMMAND_NAME_PATTERN.test(name)) {
    return 'name-invalid';
  }
  if (BUILTIN_COMMAND_NAMES.has(name)) {
    return 'name-conflict';
  }
  if (state.template.trim().length === 0) {
    return 'template-required';
  }
  return null;
}

/** The create payload: optional fields are omitted so the DB default applies. */
export type KiloCommandCreatePayload = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string;
  subtask: boolean;
};

/** The update payload: optional fields are `null` so an emptied field clears. */
export type KiloCommandUpdatePayload = {
  name: string;
  description: string | null;
  template: string;
  agent: string | null;
  model: string | null;
  subtask: boolean;
};

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Build the create payload from a validated form. */
export function buildKiloCommandCreatePayload(
  state: KiloCommandFormState
): KiloCommandCreatePayload {
  const description = optional(state.description);
  const agent = optional(state.agent);
  const model = optional(state.model);
  return {
    name: state.name.trim(),
    ...(description === undefined ? {} : { description }),
    template: state.template,
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    subtask: state.subtask,
  };
}

/** Build the update payload from a validated form; empty optionals become `null`. */
export function buildKiloCommandUpdatePayload(
  state: KiloCommandFormState
): KiloCommandUpdatePayload {
  return {
    name: state.name.trim(),
    description: optional(state.description) ?? null,
    template: state.template,
    agent: optional(state.agent) ?? null,
    model: optional(state.model) ?? null,
    subtask: state.subtask,
  };
}
