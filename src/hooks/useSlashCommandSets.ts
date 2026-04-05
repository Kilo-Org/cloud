import { useMemo } from 'react';
import { DEFAULT_COMMAND_SETS } from '@/lib/cloud-agent/default-command-sets';

export function useSlashCommandSets() {
  // All commands from all sets are always available
  const availableCommands = useMemo(() => DEFAULT_COMMAND_SETS.flatMap(set => set.commands), []);

  return {
    availableCommands,
    allSets: DEFAULT_COMMAND_SETS,
  };
}
