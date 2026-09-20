import { encryptedDatabase } from '@/lib/persist/encrypted-kv';
import { forgetKiloMcp, forgetMcpEnabled } from './kilo-mcp';
import { releaseEveryChat } from './registry';
import { forgetChatPlaces } from './scope';
import { wipeChats } from './store';

/**
 * Takes the account's chats off the device.
 *
 * The running sessions end first, so nothing writes a turn into a conversation
 * that is being deleted. Then the rows go, the account's own and no others —
 * unless the sign-out could not name the account, which takes the lot.
 *
 * The Kilo MCP connection goes with them: the cached tools and the identity
 * they were discovered under belong to the account that is leaving, and the
 * settings of the chats being deleted belong to chats that no longer exist.
 */
export async function clearChatsForSignOut(userId: string | null): Promise<void> {
  await releaseEveryChat();
  forgetChatPlaces();
  forgetKiloMcp();
  await forgetMcpEnabled(wipeChats(await encryptedDatabase(), userId));
}

/**
 * Ends the running chats when another account signs in without signing out.
 *
 * The rows stay: they are scoped to the account that made them, the way the
 * read cache on disk is, and the next account never lists them. What must not
 * stay is a live session belonging to the account that left — it would go on
 * writing under whoever is signed in now — nor the places remembered for its
 * scope, nor the Kilo MCP tools discovered with its token.
 */
export async function releaseChatsForAccountSwitch(): Promise<void> {
  await releaseEveryChat();
  forgetChatPlaces();
  forgetKiloMcp();
}
