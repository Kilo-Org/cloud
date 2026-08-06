import * as SecureStore from 'expo-secure-store';

import { chainSave } from '@/lib/hooks/save-chain';
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

/**
 * Per-key serialized SecureStore write for one consent record (DEC-01 class
 * `account-metadata (persistent)`). Consent deliberately SURVIVES sign-out,
 * so these writes use the shared per-key `chainSave` serializer WITHOUT the
 * auth-epoch fence: a consent choice made before a sign-out must still land
 * after it. Serialization prevents concurrent mutations of one user's record
 * (e.g. `setOptionalConsent` racing `revokeConsent`) from interleaving.
 * Returns the write's result so callers can observe whether the write ran.
 */
// eslint-disable-next-line typescript-eslint/require-await -- the chain's promise is returned directly; awaiting it here would trip return-await
async function serializeConsentWrite<T>(userId: string, write: () => Promise<T>): Promise<T> {
  return chainSave(keyFor(userId), write);
}

export function subscribeToConsentChanges(listener: ConsentChangeListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

// Reads only the current-version record for `userId` — no legacy-key
// migration and no chainSave. Safe to run inside a per-user chain, where
// `readConsent`'s legacy cleanup would re-enter the chain and deadlock.
// Callers inside a chain observe the state left by the previous serialized
// write for that user.
async function readCurrentConsent(
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
      // Corrupt record — fall through to the legacy check.
    }
  }

  return { mandatory: false, optional: false };
}

export async function readConsent(
  userId: string
): Promise<{ mandatory: boolean; optional: boolean }> {
  const current = await readCurrentConsent(userId);
  if (current.mandatory) {
    return current;
  }

  const legacyRaw = await SecureStore.getItemAsync(legacyKeyFor(userId));
  if (legacyRaw) {
    // Ambiguous legacy key — cannot be attributed to one user id.
    // Delete it and force re-consent. Best-effort: a failed delete must not
    // throw or block the consent check.
    try {
      await serializeConsentWrite(userId, async () => {
        await SecureStore.deleteItemAsync(legacyKeyFor(userId));
      });
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
  await serializeConsentWrite(userId, async () => {
    await SecureStore.setItemAsync(
      keyFor(userId),
      JSON.stringify({ v: CURRENT_CONSENT_VERSION, optional })
    );
  });
  notifyConsentChange({ userId, hasAccepted: true, optional });
}

export async function setOptionalConsent(userId: string, optional: boolean): Promise<void> {
  // Read and write decision inside the same per-user chain: the update reads
  // the record left by the previous serialized write, so a concurrent revoke
  // queued ahead of it deletes first and cannot be undone by a stale update.
  const wrote = await serializeConsentWrite(userId, async () => {
    const stored = await readCurrentConsent(userId);
    if (!stored.mandatory) {
      return false;
    }
    await SecureStore.setItemAsync(
      keyFor(userId),
      JSON.stringify({ v: CURRENT_CONSENT_VERSION, optional })
    );
    return true;
  });
  if (wrote) {
    notifyConsentChange({ userId, hasAccepted: true, optional });
  }
}

export async function revokeConsent(userId: string): Promise<void> {
  await serializeConsentWrite(userId, async () => {
    await SecureStore.deleteItemAsync(keyFor(userId));
    await SecureStore.deleteItemAsync(legacyKeyFor(userId));
  });
  notifyConsentChange({ userId, hasAccepted: false, optional: false });
}
