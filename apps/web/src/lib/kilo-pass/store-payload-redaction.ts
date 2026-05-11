const STORE_JSON_TOKEN_KEYS = new Set([
  'appAccountToken',
  'purchaseToken',
  'signedPayload',
  'signedRenewalInfo',
  'signedTransactionInfo',
  'signedTransactionJws',
]);

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function redactStoreAccountLinkedJson(value: unknown): Record<string, unknown> {
  if (!isJsonObject(value)) {
    return {};
  }

  return redactJsonObject(value);
}

function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => redactJsonValue(item));
  }

  if (isJsonObject(value)) {
    return redactJsonObject(value);
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
