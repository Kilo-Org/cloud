import { type ToolDefinition } from '@kilocode/harness-sdk';
import { useMemo, useSyncExternalStore } from 'react';

import { kiloMcpState, watchKiloMcp } from './kilo-mcp';
import { remoteMcpState, subscribeRemoteMcp } from './remote-mcp';
import { listRemoteMcpServers, subscribeRemoteMcpServers } from './remote-mcp-store';
import { isSettingsToolsEnabled, subscribeSettingsToolsEnabled } from './settings-tools-switch';
import { chatToolsWithMcp } from './tools';

/**
 * The tool definitions the app offers right now, for a screen that says what a
 * model can run.
 *
 * This is the app-wide enabled set, not one chat's set: the settings group
 * switch, the Kilo server's discovery and the enabled remote servers decide it,
 * and each is subscribed to here rather than read once. A remote server's tools
 * arrive through its own discovery snapshot, not through the stored list, so
 * both are followed: the list says which servers are enabled and the snapshot
 * says what each has discovered.
 *
 * `chatTools()` holds web search and the Kilo server off, so a chat that turned
 * web search on is not reflected here, and the Kilo tools are always unioned in
 * whatever that chat's own switch says. Neither is a gap to close: the row this
 * feeds is also drawn with no chat at all — the provider sheet opens from the
 * chats list — so it describes the tools this app can offer, which is the only
 * meaning it can carry in both places. A per-chat set would make the same row
 * mean two different things.
 */
export function useOfferedTools(organizationId?: string): readonly ToolDefinition[] {
  const settingsEnabled = useSyncExternalStore(
    subscribeSettingsToolsEnabled,
    isSettingsToolsEnabled
  );
  const kilo = useSyncExternalStore(watchKiloMcp, kiloMcpState);
  const servers = useSyncExternalStore(subscribeRemoteMcpServers, listRemoteMcpServers);
  const remoteTools = useSyncExternalStore(subscribeRemoteMcp, remoteMcpState);
  return useMemo(
    () => chatToolsWithMcp(organizationId).map(tool => tool.definition),
    // Every source below is read by `chatToolsWithMcp`; the values are what make
    // the memo recompute, so an unused binding is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the stores are the dependency
    [organizationId, settingsEnabled, kilo, servers, remoteTools]
  );
}
