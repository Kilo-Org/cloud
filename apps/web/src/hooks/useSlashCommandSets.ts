import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useManager } from '@/components/cloud-agent-next/CloudAgentProvider';
import type { SlashCommandInfo } from '@/lib/cloud-agent-sdk';
import { commandsOrDefault } from '@cloud-agent-shared';
import type { SlashCommand } from '@/lib/cloud-agent/slash-commands';

/**
 * Source of slash commands for the chat composer.
 *
 * The list comes from the cloud-agent session manager's `availableCommands`
 * Jotai atom, which is hydrated by `commands.available` events sent by the
 * cloud-agent worker on every /stream connect (and any time the wrapper
 * re-pushes the catalog). When the live list is empty (no wrapper connection
 * yet, or wrapper reported no commands), this hook falls back to the pinned
 * default catalog so the new-session screen and empty-wrapper cases still
 * get autocomplete.
 *
 * `expansion` is vestigial — kept for type compatibility with the existing
 * `SlashCommand` UI shape, but unused now that ChatInput invokes the
 * structured `manager.send({ payload: { type: 'command', ... } })` path.
 */
export function useSlashCommandSets() {
  const manager = useManager();
  const commands = useAtomValue(manager.atoms.availableCommands);

  const availableCommands: SlashCommand[] = useMemo(
    () => commandsOrDefault(commands).map(toSlashCommand),
    [commands]
  );

  return {
    availableCommands,
    /** Single synthetic "set" so existing browse UI continues to render. */
    allSets: useMemo(
      () => [
        {
          id: 'kilo',
          name: 'Kilo',
          description: 'Project, MCP, and skill commands available in this session',
          prefix: '',
          commands: availableCommands,
        },
      ],
      [availableCommands]
    ),
  };
}

function toSlashCommand(info: SlashCommandInfo): SlashCommand {
  return {
    trigger: info.name,
    label: info.name,
    description: info.description ?? '',
    expansion: '',
  };
}
