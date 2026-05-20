import * as SecureStore from 'expo-secure-store';

import { CONSENT_USER_KEY_PREFIX } from '@/lib/storage-keys';

export const CURRENT_CONSENT_VERSION = 1;

type ConsentChange = {
  readonly userId: string;
  readonly hasAccepted: boolean;
};

type ConsentChangeListener = (change: ConsentChange) => void;

const listeners = new Set<ConsentChangeListener>();

// SecureStore on iOS only accepts alphanumerics, '.', '-', and '_' in keys.
// User ids can contain other characters (e.g. "oauth/google:103283..."), so strip
// everything else before using the id as part of a key.
function keyFor(userId: string): string {
  return `${CONSENT_USER_KEY_PREFIX}${userId.replaceAll(/[^A-Za-z0-9]/g, '')}`;
}

function notifyConsentChange(change: ConsentChange) {
  for (const listener of listeners) {
    listener(change);
  }
}

export function subscribeToConsentChanges(listener: ConsentChangeListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export async function hasAcceptedConsent(userId: string): Promise<boolean> {
  const value = await SecureStore.getItemAsync(keyFor(userId));
  if (!value) {
    return false;
  }

  return Number(value) === CURRENT_CONSENT_VERSION;
}

export async function acceptConsent(userId: string): Promise<void> {
  await SecureStore.setItemAsync(keyFor(userId), String(CURRENT_CONSENT_VERSION));
  notifyConsentChange({ userId, hasAccepted: true });
}

export async function revokeConsent(userId: string): Promise<void> {
  await SecureStore.deleteItemAsync(keyFor(userId));
  notifyConsentChange({ userId, hasAccepted: false });
}
