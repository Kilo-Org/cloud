import { expect, test } from 'vitest';
import { deriveCallbackToken } from '@kilocode/worker-utils/callback-token';
import { payload } from './fixture';
import { signUsageMessage, verifyUsageMessage, VERCEL_USAGE_TOPIC } from './message';

test('authentication survives queue JSON serialization and preserves the original usage', async () => {
  const signed = await signUsageMessage(payload, 'synthetic-secret');
  expect(await verifyUsageMessage(JSON.parse(JSON.stringify(signed)), 'synthetic-secret')).toEqual(
    signed
  );
  expect(signed.payload).toBe(payload);
});

test.each([
  null,
  {},
  payload,
  { version: 2, payload, token: '0'.repeat(64) },
  { version: 1, payload, token: 'not-a-token' },
  { version: 1, payload, token: 123 },
])('malformed or unsigned envelope fails closed (case %#)', async message => {
  expect(await verifyUsageMessage(message, 'synthetic-secret')).toBeNull();
});

test.each(['purpose', 'topic'])(
  'a valid MAC bound to another %s cannot authorize queued usage',
  async binding => {
    const token = await deriveCallbackToken({
      secret: 'synthetic-secret',
      scope: binding === 'purpose' ? 'other-callback' : 'vercel-usage-queue-v1',
      resourceParts: [
        binding === 'topic' ? 'other-topic' : VERCEL_USAGE_TOPIC,
        JSON.stringify(payload),
      ],
    });
    expect(await verifyUsageMessage({ version: 1, payload, token }, 'synthetic-secret')).toBeNull();
  }
);

test.each(['', '   '])('blank configuration cannot sign or authenticate (%j)', async secret => {
  await expect(signUsageMessage(payload, secret)).rejects.toThrow();
  const signed = await signUsageMessage(payload, 'synthetic-secret');
  expect(await verifyUsageMessage(signed, secret)).toBeNull();
});
