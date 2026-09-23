import { encryptedDatabase } from '@/lib/persist/encrypted-kv';
import { forgetKiloMcp, forgetMcpEnabled } from './kilo-mcp';
import { releaseEveryChat } from './registry';
import { forgetRemoteMcp } from './remote-mcp';
import { clearRemoteMcpServers } from './remote-mcp-store';
import { forgetChatPlaces } from './scope';
import { clearSettingsToolsEnabled } from './settings-tools-switch';
import { wipeChats } from './store';

/**
 * The account's MCP state, dropped with its chats.
 *
 * The Kilo MCP connection is cached against the token it was discovered with.
 * The remote MCP connection is cached the same way and the list behind it
 * holds bearer tokens, so both belong to the account that is leaving. The
 * settings-tools group switch is account-scoped too: the next account starts
 * from its default rather than inheriting the previous account's choice.
 */
function forgetMcpState(): void {
  forgetKiloMcp();
  forgetRemoteMcp();
  clearRemoteMcpServers();
  clearSettingsToolsEnabled();
}

/**
 * Takes the account's chats off the device.
 *
 * The running sessions end first, so nothing writes a turn into a conversation
 * that is being deleted. Then the rows go, the account's own and no others —
 * unless the sign-out could not name the account, which takes the lot.
 *
 * The MCP state goes with them: the cached tools and the identity they were
 * discovered under belong to the account that is leaving, the stored remote
 * servers hold its bearer tokens, and the settings of the chats being deleted
 * belong to chats that no longer exist.
 */
export async function clearChatsForSignOut(userId: string | null): Promise<void> {
  await releaseEveryChat();
  forgetChatPlaces();
  forgetMcpState();
  await forgetMcpEnabled(wipeChats(await encryptedDatabase(), userId));
}

/**
 * Ends the running chats when another account signs in without signing out.
 *
 * The rows stay: they are scoped to the account that made them, the way the
 * read cache on disk is, and the next account never lists them. What must not
 * stay is a live session belonging to the account that left — it would go on
 * writing under whoever is signed in now — nor the places remembered for its
 * scope, nor the MCP tools discovered with its token, nor the remote servers
 * and group switch that token owned.
 */
export async function releaseChatsForAccountSwitch(): Promise<void> {
  await releaseEveryChat();
  forgetChatPlaces();
  forgetMcpState();
}
