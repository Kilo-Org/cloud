import { randomUUID } from 'expo-crypto';

import * as encryptedKv from '@/lib/persist/encrypted-kv';

/**
 * The per-account "Sync chats across devices" choice and this install's
 * source id, in the encrypted store beside the chats themselves. The choice
 * defaults to off: `undecided` (never answered) and `off` both keep chats
 * on the device, and only `undecided` shows the one-time prompt.
 */

export type ChatSyncSetting =
  | { readonly kind: 'undecided' }
  | { readonly kind: 'on' }
  | { readonly kind: 'off' };

const SETTING_KEY = 'chat-sync-setting';
const SOURCE_KEY = 'chat-sync-source-id';

/** The account scope sync settings live under, from a chat scope's user half. */
export function syncSettingsScope(chatScope: string): string {
  const userId = chatScope.split(':')[0] ?? chatScope;
  return `chat-sync:${userId}`;
}

export async function readChatSyncSetting(chatScope: string): Promise<ChatSyncSetting> {
  const stored = await encryptedKv.getItem(syncSettingsScope(chatScope), SETTING_KEY);
  if (stored === 'on') {
    return { kind: 'on' };
  }
  if (stored === 'off') {
    return { kind: 'off' };
  }
  return { kind: 'undecided' };
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
