import type { SlashCommandInfo } from '@/lib/cloud-agent-sdk';
import type { ActiveSessionType } from '@/lib/cloud-agent-sdk/session-manager';
import type { SlashCommand } from '@/lib/cloud-agent/slash-commands';
import { commandsOrDefault } from '@cloud-agent-shared';

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
