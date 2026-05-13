import * as SecureStore from 'expo-secure-store';

import { CONSENT_USER_KEY_PREFIX } from '@/lib/storage-keys';

function keyFor(userId: string): string {
  return `${CONSENT_USER_KEY_PREFIX}${userId}`;
}

export async function hasAcceptedConsent(userId: string): Promise<boolean> {
  const value = await SecureStore.getItemAsync(keyFor(userId));
  return value === 'true';
}

export async function acceptConsent(userId: string): Promise<void> {
  await SecureStore.setItemAsync(keyFor(userId), 'true');
}

export async function revokeConsent(userId: string): Promise<void> {
  await SecureStore.deleteItemAsync(keyFor(userId));
}
