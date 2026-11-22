import { type ToolDefinition } from '@kilocode/harness-sdk';
import { useMemo, useSyncExternalStore } from 'react';

import { kiloMcpState, watchKiloMcp } from './kilo-mcp';
import { listRemoteMcpServers, subscribeRemoteMcpServers } from './remote-mcp-store';
import { isSettingsToolsEnabled, subscribeSettingsToolsEnabled } from './settings-tools-switch';
import { chatToolsWithMcp } from './tools';

/**
 * The tool definitions a chat offers right now, for a screen that says what a
 * model can run.
 *
 * The set is `chatToolsWithMcp`'s, so the names a screen reads are the ones a
 * chat would send: the switches, the Kilo server's discovery and the enabled
 * remote servers all decide it, and each of them is subscribed to here rather
 * than read once. The definitions are what the converter needs; a status only
 * ever names them.
 */
export function useOfferedTools(organizationId?: string): readonly ToolDefinition[] {
  const settingsEnabled = useSyncExternalStore(
    subscribeSettingsToolsEnabled,
    isSettingsToolsEnabled
  );
  const kilo = useSyncExternalStore(watchKiloMcp, kiloMcpState);
  const servers = useSyncExternalStore(subscribeRemoteMcpServers, listRemoteMcpServers);
  return useMemo(
    () => chatToolsWithMcp(organizationId).map(tool => tool.definition),
    // Every source below is read by `chatToolsWithMcp`; the values are what make
    // the memo recompute, so an unused binding is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the stores are the dependency
    [organizationId, settingsEnabled, kilo, servers]
  );
}
