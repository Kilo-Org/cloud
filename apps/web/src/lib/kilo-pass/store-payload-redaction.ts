import * as z from 'zod';

const STORE_JSON_TOKEN_KEYS = new Set([
  'appAccountToken',
  'purchaseToken',
  'signedPayload',
  'signedRenewalInfo',
  'signedTransactionInfo',
  'signedTransactionJws',
]);

const StorePayloadJsonObjectSchema = z.record(z.string(), z.unknown());

function parseStorePayloadJsonObject(value: unknown): Record<string, unknown> | null {
  const parsed = StorePayloadJsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function redactStoreAccountLinkedJson(value: unknown): Record<string, unknown> {
  const payload = parseStorePayloadJsonObject(value);
  if (!payload) {
    return {};
  }

  return redactJsonObject(payload);
}

function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => redactJsonValue(item));
  }

  const payload = parseStorePayloadJsonObject(value);
  if (payload) {
    return redactJsonObject(payload);
  }

  return value;
}

function redactJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      STORE_JSON_TOKEN_KEYS.has(key) ? null : redactJsonValue(nestedValue),
    ])
  );
}
