import * as Crypto from 'expo-crypto';
import { type Purchase } from 'expo-iap';
import { z } from 'zod';

import { getItem, removeItemIfValue, setItem } from '@/lib/persist/encrypted-kv';
import { getPurchaseCompletionId } from './use-store-credit-purchase';

const SCOPE = 'credit-purchase';
const KEY = 'unresolved';
const intentSchema = z.object({
  id: z.string().default(() => Crypto.randomUUID()),
  productId: z.string(),
  accountToken: z.string(),
  transactionIds: z.array(z.string()),
  dispatched: z.boolean().default(true),
});
export type CreditPurchaseIntent = z.infer<typeof intentSchema>;

/**
 * The stored admission cannot be parsed. It is a barrier, not a discardable
 * record: only explicit consent may erase it, and this error carries no raw
 * value so a corrupt record never travels through telemetry.
 */
export class MalformedCreditPurchaseIntentError extends Error {
  constructor() {
    super('The stored credit purchase intent cannot be read.');
    this.name = 'MalformedCreditPurchaseIntentError';
  }
}

let intent: CreditPurchaseIntent | null = null;
let loaded: Promise<void> | null = null;
let malformed: string | null = null;

export function resetCreditPurchaseIntentForTests(): void {
  intent = null;
  loaded = null;
  malformed = null;
}

export async function restoreCreditPurchaseIntent(): Promise<CreditPurchaseIntent | null> {
  loaded ??= loadCreditPurchaseIntent();
  const pending = loaded;
  try {
    await pending;
  } catch (error) {
    // A rejected read or migration write must not poison every later attempt:
    // the stored record stays in place and the next restore retries it.
    if (loaded === pending) {
      loaded = null;
    }
    throw error;
  }
  return intent;
}

async function loadCreditPurchaseIntent(): Promise<void> {
  const saved = await getItem(SCOPE, KEY);
  if (saved === null) {
    return;
  }
  // Corrupt admission must fail closed, never silently authorize another charge.
  const parsed = parseCreditPurchaseIntent(saved);
  malformed = null;
  intent = parsed;
  const normalized = JSON.stringify(parsed);
  if (normalized !== saved) {
    await setItem(SCOPE, KEY, normalized);
  }
  if (!parsed.dispatched) {
    await retireCreditPurchaseIntent(parsed);
  }
}

function parseCreditPurchaseIntent(saved: string): CreditPurchaseIntent {
  try {
    const parsed = intentSchema.safeParse(JSON.parse(saved));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // Text that is not JSON is malformed too; both reach the consent barrier.
  }
  malformed = saved;
  throw new MalformedCreditPurchaseIntentError();
}

/**
 * Erases the captured malformed record only while it is still the stored value.
 * Returns true when it was removed or is already absent; a newer value is never
 * deleted.
 */
export async function consentToReplaceMalformedCreditPurchaseIntent(): Promise<boolean> {
  const captured = malformed;
  if (captured === null) {
    return false;
  }
  if (!(await removeItemIfValue(SCOPE, KEY, captured)) && (await getItem(SCOPE, KEY)) !== null) {
    return false;
  }
  malformed = null;
  intent = null;
  loaded = null;
  return true;
}

export async function admitCreditPurchaseIntent(
  productId: string,
  accountToken: string,
  allowCreate = true
) {
  await restoreCreditPurchaseIntent();
  if (intent !== null) {
    return { intent, created: false };
  }
  if (!allowCreate) {
    return { intent: null, created: false };
  }
  const admitted: CreditPurchaseIntent = {
    id: Crypto.randomUUID(),
    productId,
    accountToken,
    transactionIds: [],
    dispatched: false,
  };
  intent = admitted;
  try {
    await setItem(SCOPE, KEY, JSON.stringify(admitted));
  } catch (error) {
    // Nothing was dispatched: release only after its durable reservation is gone.
    await retireCreditPurchaseIntent(admitted);
    throw error;
  }
  return { intent: admitted, created: true };
}

export function ownsCreditPurchaseIntent(record: CreditPurchaseIntent): boolean {
  return intent === record;
}

export function matchesCreditPurchaseIntent(record: CreditPurchaseIntent, purchase: Purchase) {
  return record.transactionIds.includes(getPurchaseCompletionId(purchase));
}

export async function markCreditPurchaseIntentDispatched(
  record: CreditPurchaseIntent
): Promise<void> {
  if (intent !== record) {
    throw new Error('The purchase admission no longer belongs to this request.');
  }
  // Persist before calling native code: a crash must never restore a dispatched
  // request as an unsent reservation and silently authorize another charge.
  record.dispatched = true;
  await setItem(SCOPE, KEY, JSON.stringify(record));
}

export async function identifyCreditPurchaseTransaction(
  record: CreditPurchaseIntent,
  purchase: Purchase
): Promise<void> {
  if (intent !== record) {
    return;
  }
  const id = getPurchaseCompletionId(purchase);
  if (!record.transactionIds.includes(id)) {
    record.transactionIds.push(id);
  }
  await setItem(SCOPE, KEY, JSON.stringify(record));
}

export async function retireCreditPurchaseIntent(record: CreditPurchaseIntent): Promise<void> {
  if (intent !== record) {
    return;
  }
  const saved = await getItem(SCOPE, KEY);
  if (intent !== record) {
    return;
  }
  if (saved === null) {
    intent = null;
    return;
  }
  const stored = parseCreditPurchaseIntent(saved);
  if (
    stored.id !== record.id ||
    stored.accountToken !== record.accountToken ||
    stored.productId !== record.productId
  ) {
    return;
  }
  const removed = await removeItemIfValue(SCOPE, KEY, saved);
  if (removed && intent === record) {
    intent = null;
  }
}
