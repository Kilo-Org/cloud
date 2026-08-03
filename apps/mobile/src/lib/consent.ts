import * as SecureStore from 'expo-secure-store';

import { CONSENT_USER_KEY_PREFIX } from '@/lib/storage-keys';

export const CURRENT_CONSENT_VERSION = 2;

type ConsentChange = {
  readonly userId: string;
  readonly hasAccepted: boolean;
  readonly optional: boolean;
};

type ConsentChangeListener = (change: ConsentChange) => void;

const listeners = new Set<ConsentChangeListener>();

// Injective hex-encoding — reversible, alphanumeric, no collisions.
function keyFor(userId: string): string {
  return `${CONSENT_USER_KEY_PREFIX}${[...new TextEncoder().encode(userId)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')}`;
}

// Legacy strip-based key — kept for migration only. Non-injective, so a hit
// forces re-consent and the record is removed.
function legacyKeyFor(userId: string): string {
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

export async function readConsent(
  userId: string
): Promise<{ mandatory: boolean; optional: boolean }> {
  const raw = await SecureStore.getItemAsync(keyFor(userId));
  if (raw) {
    try {
      const record: { v: unknown; optional: unknown } = JSON.parse(raw);
      if (record.v === CURRENT_CONSENT_VERSION) {
        return { mandatory: true, optional: record.optional === true };
      }
    } catch {
      // Corrupt record — fall through to legacy check.
    }
  }

  const legacyRaw = await SecureStore.getItemAsync(legacyKeyFor(userId));
  if (legacyRaw) {
    // Ambiguous legacy key — cannot be attributed to one user id.
    // Delete it and force re-consent. Best-effort: a failed delete must not
    // throw or block the consent check.
    try {
      await SecureStore.deleteItemAsync(legacyKeyFor(userId));
    } catch {
      // Silently ignore — the caller gets the correct forced-reconsent result.
    }
  }

  return { mandatory: false, optional: false };
}

export async function hasAcceptedConsent(userId: string): Promise<boolean> {
  const consent = await readConsent(userId);
  return consent.mandatory;
}

export async function acceptConsent(userId: string, optional = false): Promise<void> {
  await SecureStore.setItemAsync(
    keyFor(userId),
    JSON.stringify({ v: CURRENT_CONSENT_VERSION, optional })
  );
  notifyConsentChange({ userId, hasAccepted: true, optional });
}

export async function setOptionalConsent(userId: string, optional: boolean): Promise<void> {
  const stored = await readConsent(userId);
  if (!stored.mandatory) {
    return;
  }

  await SecureStore.setItemAsync(
    keyFor(userId),
    JSON.stringify({ v: CURRENT_CONSENT_VERSION, optional })
  );
  notifyConsentChange({ userId, hasAccepted: true, optional });
}

export async function revokeConsent(userId: string): Promise<void> {
  await SecureStore.deleteItemAsync(keyFor(userId));
  await SecureStore.deleteItemAsync(legacyKeyFor(userId));
  notifyConsentChange({ userId, hasAccepted: false, optional: false });
}
