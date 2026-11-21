import { encryptedDatabase } from '@/lib/persist/encrypted-kv';
import { clearChatBackends } from './backend-store';
import { forgetKiloMcp, forgetMcpEnabled } from './kilo-mcp';
import { forgetQuestions } from './pending';
import { releaseEveryChat } from './registry';
import { forgetRemoteMcp } from './remote-mcp';
import { clearRemoteMcpServers } from './remote-mcp-store';
import { forgetChatPlaces } from './scope';
import { clearSettingsToolsEnabled } from './settings-tools-switch';
import { wipeChats } from './store';
import { forgetWebSearchEnabled } from './web-search-setting';

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
  clearChatBackends();
}

/** The failure a refused wipe names, which never carries the account or a chat. */
const wipeFailure = (error: unknown): string =>
  error instanceof Error ? error.message : 'the chats could not be wiped';

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
 *
 * A wipe the store refuses is reported and then passed on. The wipe is one
 * transaction, so a refusal leaves the account whole and the next sign-out
 * retries it, and the report is the only record that the departing account's
 * rows are still on the device. The per-chat preferences are not cleared with
 * a refusal, because they belong to the chats that survived.
 */
export async function clearChatsForSignOut(userId: string | null): Promise<void> {
  await releaseEveryChat();
  forgetChatPlaces();
  forgetMcpState();
  let sessionIds: readonly string[] = [];
  try {
    sessionIds = await wipeChats(await encryptedDatabase(), userId);
  } catch (error) {
    // eslint-disable-next-line no-console -- sign-out runs with no screen left to report a refused wipe on
    console.warn(`[chats] the account's chats could not be wiped: ${wipeFailure(error)}`);
    throw error;
  }
  await Promise.all([
    forgetMcpEnabled(sessionIds),
    forgetWebSearchEnabled(sessionIds),
    ...sessionIds.map(async id => {
      await forgetQuestions(id);
    }),
  ]);
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
