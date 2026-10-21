/**
 * Pure view-model helpers for the profile Setup commands screen.
 *
 * No React and no React Native imports. `setCommands` replaces the whole list,
 * so the screen edits an ordered `string[]` and this module is the list's only
 * entry point: it re-exports the s2 list operations (`addCommand`,
 * `replaceCommand`, `removeCommand`, `moveCommand`) and the server's list/row
 * bounds (`MAX_SETUP_COMMANDS`, `MAX_SETUP_COMMAND_LENGTH`), and adds the
 * per-row position label plus the list comparison and payload helpers.
 */

export {
  addCommand,
  MAX_SETUP_COMMAND_LENGTH,
  MAX_SETUP_COMMANDS,
  moveCommand,
  removeCommand,
  replaceCommand,
} from '@/lib/agent-profile-forms';

/** Whether two lists hold the same commands in the same order. */
export function sameCommands(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The payload `setCommands` stores. A blank row is the draft slot `add()`
 * opens, not a command, so whitespace-only entries never reach the server.
 */
export function nonBlankCommands(commands: readonly string[]): string[] {
  return commands.filter(command => command.trim().length > 0);
}

/**
 * Position label for a command row's controls, e.g. `2 / 3`. Digits only, so
 * no catalog entry is needed and the reader hears the row's place in the list.
 */
export function commandRowA11yLabel(index: number, total: number): string {
  return `${index + 1} / ${total}`;
}

/**
 * One-based position among the commands alone, or `null` for a blank draft
 * row. Blank rows are not commands, so they must not claim a command number
 * that the saved list does not hold.
 */
export function commandPosition(commands: readonly string[], index: number): number | null {
  const row = commands[index];
  if (row === undefined || row.trim().length === 0) {
    return null;
  }
  return commands.slice(0, index + 1).filter(command => command.trim().length > 0).length;
}
