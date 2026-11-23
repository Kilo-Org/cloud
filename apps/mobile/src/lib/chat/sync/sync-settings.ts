import { randomUUID } from 'expo-crypto';

import * as encryptedKv from '@/lib/persist/encrypted-kv';

/**
 * The per-account "Sync chats across devices" choice and this install's
 * source id, in the encrypted store beside the chats themselves. Sync is on
 * until the person turns it off: only a stored `off` keeps a chat local.
 */

export type ChatSyncSetting = 'on' | 'off';

const SETTING_KEY = 'chat-sync-setting';
const SOURCE_KEY = 'chat-sync-source-id';

/** The account scope sync settings live under, from a chat scope's user half. */
export function syncSettingsScope(chatScope: string): string {
  const userId = chatScope.split(':')[0] ?? chatScope;
  return `chat-sync:${userId}`;
}

/** The answer for this account: on unless this device was told otherwise. */
export async function readChatSyncSetting(chatScope: string): Promise<ChatSyncSetting> {
  const stored = await encryptedKv.getItem(syncSettingsScope(chatScope), SETTING_KEY);
  return stored === 'off' ? 'off' : 'on';
}

export async function writeChatSyncSetting(
  chatScope: string,
  setting: 'on' | 'off'
): Promise<void> {
  await encryptedKv.setItem(syncSettingsScope(chatScope), SETTING_KEY, setting);
}

/**
 * This install's source id for the account: minted on first use, then held
 * for every chat the account syncs from this device.
 */
export async function chatSyncSourceId(chatScope: string): Promise<string> {
  const scope = syncSettingsScope(chatScope);
  const held = await encryptedKv.getItem(scope, SOURCE_KEY);
  if (held !== null && held !== '') {
    return held;
  }
  const minted = randomUUID();
  await encryptedKv.setItem(scope, SOURCE_KEY, minted);
  return minted;
}
