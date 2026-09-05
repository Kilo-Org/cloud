import { encryptedDatabase } from '@/lib/persist/encrypted-kv';
import { releaseEveryChat } from './registry';
import { wipeChats } from './store';

/**
 * Takes the account's chats off the device.
 *
 * The running sessions end first, so nothing writes a turn into a conversation
 * that is being deleted. Then the rows go, the account's own and no others —
 * unless the sign-out could not name the account, which takes the lot.
 */
export async function clearChatsForSignOut(userId: string | null): Promise<void> {
  await releaseEveryChat();
  wipeChats(await encryptedDatabase(), userId);
}

/**
 * Ends the running chats when another account signs in without signing out.
 *
 * The rows stay: they are scoped to the account that made them, the way the
 * read cache on disk is, and the next account never lists them. What must not
 * stay is a live session belonging to the account that left — it would go on
 * writing under whoever is signed in now.
 */
export async function releaseChatsForAccountSwitch(): Promise<void> {
  await releaseEveryChat();
}
