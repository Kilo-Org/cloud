import type { CommandSet, SlashCommand } from '@/lib/cloud-agent/slash-commands';

/**
 * Choose which command sets the BrowseCommandsDialog should render.
 *
 * Callers that already know their exact slash-command list (e.g. NewSessionPanel
 * and ChatInput) can pass `explicitCommands` to guarantee the browse dialog
 * matches the adjacent autocomplete. Callers without explicit commands fall back
 * to the sets produced by useSlashCommandSets.
 *
 * When explicit commands are supplied, the synthetic set keeps the same
 * id/name/description/prefix as the hook-derived set so the dialog remains
 * visually consistent; only the command list is replaced exactly.
 */
export function selectBrowseCommandSets(
  allSets: CommandSet[],
  explicitCommands?: SlashCommand[]
): CommandSet[] {
  if (explicitCommands !== undefined) {
    return [
      {
        id: 'kilo',
        name: 'Kilo',
        description: 'Project and MCP commands available in this session',
        prefix: '',
        commands: explicitCommands,
      },
    ];
  }
  return allSets;
}
