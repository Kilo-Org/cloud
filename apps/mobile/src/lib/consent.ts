import * as SecureStore from 'expo-secure-store';

import {
  captureEvent,
  CONSENT_OUTCOME_EVENT,
  flushLastPostHogEvent,
  isPostHogReady,
  subscribeToPostHogReady,
} from '@/lib/analytics/posthog';
import { chainSave } from '@/lib/hooks/save-chain';
import { CONSENT_USER_KEY_PREFIX, encodeStorageKey } from '@/lib/storage-keys';

export const CURRENT_CONSENT_VERSION = 2;

type ConsentChange = {
  readonly userId: string;
  readonly hasAccepted: boolean;
  readonly optional: boolean;
};

type ConsentChangeListener = (change: ConsentChange) => void;

const listeners = new Set<ConsentChangeListener>();

type PendingConsentOutcome = {
  action: 'accepted' | 'optional_changed' | 'revoked';
  optional: boolean;
};

// A consent outcome queued before PostHog became ready. The ready listener
// below captures it once (and only once) the client exists. `revokeConsent`
// clears it so a queued enable can never fire after a revoke.
let pendingConsentOutcome: PendingConsentOutcome | null = null;

// Register once at module load: when PostHog becomes ready and an outcome is
// pending, capture it and clear the pending slot. A not-ready transition
// leaves the pending outcome in place for the next ready transition.
subscribeToPostHogReady(() => {
  if (isPostHogReady() && pendingConsentOutcome) {
    captureEvent(CONSENT_OUTCOME_EVENT, pendingConsentOutcome);
    pendingConsentOutcome = null;
  }
});

// Clear a queued outcome so it cannot survive sign-out and drain onto a later
// account's client. `revokeConsent` clears it for the revoke path; sign-out
// calls this during its telemetry teardown.
export function clearPendingConsentOutcome(): void {
  pendingConsentOutcome = null;
}

function keyFor(userId: string): string {
  return encodeStorageKey(CONSENT_USER_KEY_PREFIX, userId);
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

/*
 * Every consent write below runs through `chainSave(keyFor(userId), ...)`: one
 * SecureStore record per user, serialized per key (DEC-01 class
 * `account-metadata (persistent)`). Consent deliberately SURVIVES sign-out, so
 * these writes carry NO auth-epoch fence: a consent choice made before a
 * sign-out must still land after it. Serialization prevents concurrent
 * mutations of one user's record (e.g. `setOptionalConsent` racing
 * `revokeConsent`) from interleaving, and the chain's result tells the caller
 * whether the write ran.
 */

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
      await chainSave(keyFor(userId), async () => {
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
  await chainSave(keyFor(userId), async () => {
    const prior = await readCurrentConsent(userId);
    await SecureStore.setItemAsync(
      keyFor(userId),
      JSON.stringify({ v: CURRENT_CONSENT_VERSION, optional })
    );
    // Queue an enable-side outcome only for a real optional-accept change.
    // Duplicate accepts with the same optional value do not re-queue.
    const alreadyAcceptedWithSameOptional = prior.mandatory && prior.optional === optional;
    if (optional && !alreadyAcceptedWithSameOptional) {
      pendingConsentOutcome = { action: 'accepted', optional: true };
    }
  });
  notifyConsentChange({ userId, hasAccepted: true, optional });
}

export async function setOptionalConsent(userId: string, optional: boolean): Promise<void> {
  // Read and write decision inside the same per-user chain: the update reads
  // the record left by the previous serialized write, so a concurrent revoke
  // queued ahead of it deletes first and cannot be undone by a stale update.
  const { wrote, priorOptional } = await chainSave(keyFor(userId), async () => {
    const stored = await readCurrentConsent(userId);
    if (!stored.mandatory) {
      return { wrote: false, priorOptional: false };
    }
    await SecureStore.setItemAsync(
      keyFor(userId),
      JSON.stringify({ v: CURRENT_CONSENT_VERSION, optional })
    );
    return { wrote: true, priorOptional: stored.optional };
  });
  if (!wrote) {
    return;
  }
  if (priorOptional === optional) {
    // No real change: notify as today and emit nothing.
    notifyConsentChange({ userId, hasAccepted: true, optional });
    return;
  }
  if (optional) {
    // Enable-side: queue the outcome and let the ready listener capture it.
    pendingConsentOutcome = { action: 'optional_changed', optional: true };
  } else {
    // Disable-side: clear a queued enable outcome so it can never fire after
    // the user disabled, then capture and flush before notifying so the
    // turn-off lands while optional telemetry is still allowed.
    pendingConsentOutcome = null;
    captureEvent(CONSENT_OUTCOME_EVENT, { action: 'optional_changed', optional: false });
    await flushLastPostHogEvent();
  }
  notifyConsentChange({ userId, hasAccepted: true, optional });
}

export async function revokeConsent(userId: string): Promise<void> {
  await chainSave(keyFor(userId), async () => {
    await SecureStore.deleteItemAsync(keyFor(userId));
    await SecureStore.deleteItemAsync(legacyKeyFor(userId));
  });
  // A queued enable outcome must never fire after revoke.
  pendingConsentOutcome = null;
  captureEvent(CONSENT_OUTCOME_EVENT, { action: 'revoked', optional: false });
  await flushLastPostHogEvent();
  notifyConsentChange({ userId, hasAccepted: false, optional: false });
}
