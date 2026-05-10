import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useManager } from '@/components/cloud-agent-next/CloudAgentProvider';
import type { SlashCommandInfo } from '@/lib/cloud-agent-sdk';
import type { SlashCommand } from '@/lib/cloud-agent/slash-commands';

/**
 * Source of slash commands for the chat composer.
 *
 * The list comes from the cloud-agent session manager's `availableCommands`
 * Jotai atom, which is hydrated by `commands.available` events sent by the
 * cloud-agent worker on every /stream connect (and any time the wrapper
 * re-pushes the catalog). Empty list means the wrapper hasn't pushed yet —
 * UIs should render nothing rather than fall back to a hardcoded set.
 *
 * `expansion` is vestigial — kept for type compatibility with the existing
 * `SlashCommand` UI shape, but unused now that ChatInput invokes the
 * structured `manager.send({ payload: { type: 'command', ... } })` path.
 */
export function useSlashCommandSets() {
  const manager = useManager();
  const commands = useAtomValue(manager.atoms.availableCommands);

  const availableCommands: SlashCommand[] = useMemo(() => commands.map(toSlashCommand), [commands]);

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
