import { commandsOrDefault } from '@cloud-agent-shared';
import type { SlashCommandInfo } from '@/lib/cloud-agent-sdk';
import type { ActiveSessionType } from '@/lib/cloud-agent-sdk';
import type { SlashCommand } from '@/lib/cloud-agent/slash-commands';

/**
 * Pure selector: given the manager's active session type and the most recent
 * reported command list, return the commands the chat composer should
 * surface.
 *
 * - `cloud-agent` keeps the historical pinned-default fallback: when the
 *   wrapper has not (yet) reported any commands we still want autocomplete
 *   to suggest the project and MCP defaults the wrapper would have published.
 *   The `commandsOrDefault` helper also appends local session commands
 *   (compaction) that the wrapper does not register.
 * - `remote` sessions use exactly the live CLI catalog. We never substitute
 *   the Cloud Agent defaults because those commands do not exist in a
 *   remote CLI session and suggesting them would be misleading. An empty
 *   catalog means "no commands available", not "fall back to defaults".
 * - `read-only` and `null` (unresolved) sessions expose no commands.
 *
 * `expansion` is intentionally empty: the cloud-agent worker receives a
 * structured `command` payload and performs any template substitution, so
 * the client must not invent `$ARGUMENTS`/`$1`/etc. expansions here.
 */
export function selectSlashCommands(
  sessionType: ActiveSessionType | null,
  commands: SlashCommandInfo[]
): SlashCommand[] {
  const selectedCommands =
    sessionType === 'cloud-agent'
      ? commandsOrDefault(commands)
      : sessionType === 'remote'
        ? commands
        : [];
  return selectedCommands.map(toSlashCommand);
}

function toSlashCommand(info: SlashCommandInfo): SlashCommand {
  return {
    trigger: info.name,
    label: info.name,
    description: info.description ?? '',
    expansion: '',
  };
}
