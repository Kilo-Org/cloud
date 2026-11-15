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

let intent: CreditPurchaseIntent | null = null;
let loaded: Promise<void> | null = null;

export function resetCreditPurchaseIntentForTests(): void {
  intent = null;
  loaded = null;
}

export async function restoreCreditPurchaseIntent(): Promise<CreditPurchaseIntent | null> {
  loaded ??= (async () => {
    const saved = await getItem(SCOPE, KEY);
    if (saved !== null) {
      // Corrupt admission must fail closed, never silently authorize another charge.
      intent = intentSchema.parse(JSON.parse(saved));
      const normalized = JSON.stringify(intent);
      if (normalized !== saved) {
        await setItem(SCOPE, KEY, normalized);
      }
      if (!intent.dispatched) {
        await retireCreditPurchaseIntent(intent);
      }
    }
  })();
  await loaded;
  return intent;
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

export async function markCreditPurchaseIntentDispatched(record: CreditPurchaseIntent): Promise<void> {
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
  const stored = intentSchema.parse(JSON.parse(saved));
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
