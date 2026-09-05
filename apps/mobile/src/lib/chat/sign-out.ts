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
