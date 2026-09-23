/**
 * Pure view-model helpers for the profile Setup commands screen.
 *
 * No React and no React Native imports. `setCommands` replaces the whole list,
 * so the screen edits an ordered `string[]` and this module is the list's only
 * entry point: it re-exports the s2 list operations (`addCommand`,
 * `replaceCommand`, `removeCommand`, `moveCommand`) and adds the per-row
 * position label the row's controls carry.
 */

export { addCommand, moveCommand, removeCommand, replaceCommand } from '@/lib/agent-profile-forms';

/**
 * Position label for a command row's controls, e.g. `2 / 3`. Digits only, so
 * no catalog entry is needed and the reader hears the row's place in the list.
 */
export function commandRowA11yLabel(index: number, total: number): string {
  return `${index + 1} / ${total}`;
}
