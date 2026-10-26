import 'server-only';

import { deriveCallbackToken, verifyCallbackToken } from '@kilocode/worker-utils/callback-token';

export const VERCEL_USAGE_TOPIC = 'usage-staging';
const SIGNING_SCOPE = 'vercel-usage-queue-v1';

type SignedUsageMessage<T = unknown> = { version: 1; payload: T; token: string };

function resourceParts(payload: unknown): string[] {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error('Usage queue payload is not serializable');
  return [VERCEL_USAGE_TOPIC, serialized];
}

export async function signUsageMessage<T>(
  payload: T,
  secret: string
): Promise<SignedUsageMessage<T>> {
  const token = await deriveCallbackToken({
    secret,
    scope: SIGNING_SCOPE,
    resourceParts: resourceParts(payload),
  });
  return { version: 1, payload, token };
}

export async function verifyUsageMessage(
  message: unknown,
  secret: string
): Promise<SignedUsageMessage | null> {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('version' in message) ||
    message.version !== 1 ||
    !('payload' in message) ||
    !('token' in message) ||
    typeof message.token !== 'string'
  ) {
    return null;
  }
  try {
    const valid = await verifyCallbackToken({
      secret,
      scope: SIGNING_SCOPE,
      resourceParts: resourceParts(message.payload),
      token: message.token,
    });
    return valid ? { version: 1, payload: message.payload, token: message.token } : null;
  } catch {
    return null;
  }
}
