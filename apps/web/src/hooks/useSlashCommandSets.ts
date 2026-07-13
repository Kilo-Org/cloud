import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useManager } from '@/components/cloud-agent-next/CloudAgentProvider';
import type { SlashCommand } from '@/lib/cloud-agent/slash-commands';
import { selectSlashCommands } from './slash-command-selection';

/**
 * Source of slash commands for the chat composer.
 *
 * The list comes from the cloud-agent session manager's `availableCommands`
 * Jotai atom, which is hydrated by `commands.available` events sent by the
 * cloud-agent worker on every /stream connect (and any time the wrapper
 * re-pushes the catalog). Cloud Agent sessions fall back to the pinned default
 * catalog while the wrapper list is unavailable. Remote sessions use only the
 * exact CLI catalog, while read-only and unresolved sessions expose nothing.
 *
 * `expansion` is vestigial — kept for type compatibility with the existing
 * `SlashCommand` UI shape, but unused now that ChatInput invokes the
 * structured `manager.send({ payload: { type: 'command', ... } })` path.
 */
export function useSlashCommandSets() {
  const manager = useManager();
  const commands = useAtomValue(manager.atoms.availableCommands);
  const activeSessionType = useAtomValue(manager.atoms.activeSessionType);

  const availableCommands: SlashCommand[] = useMemo(
    () => selectSlashCommands(activeSessionType, commands),
    [activeSessionType, commands]
  );

  return {
    availableCommands,
    /** Single synthetic "set" so existing browse UI continues to render. */
    allSets: useMemo(
      () => [
        {
          id: 'kilo',
          name: 'Kilo',
          description: 'Project and MCP commands available in this session',
          prefix: '',
          commands: availableCommands,
        },
      ],
      [availableCommands]
    ),
  };
}
