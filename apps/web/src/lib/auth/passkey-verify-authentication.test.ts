import { describe, expect, it, jest } from '@jest/globals';

// The guard runs before any database call, so the client is stubbed: were the
// check to sit after the credential lookup, these tests would reject with a
// TypeError from the stub instead of the ceremony's refusal.
jest.mock('@/lib/drizzle', () => ({ db: {} }));

import { PasskeyVerificationError, verifyAuthentication } from './passkey';

const challengeId = '22222222-2222-4222-8222-222222222222';

function assertionWithId(id: unknown) {
  return {
    id,
    rawId: 'raw',
    type: 'public-key',
    clientExtensionResults: {},
    response: {},
  };
}

/** The refusal the route turns into a 401 with a stable code. */
async function refusalFor(id: unknown): Promise<PasskeyVerificationError> {
  const error: unknown = await verifyAuthentication(challengeId, assertionWithId(id) as never).then(
    () => undefined,
    (rejection: unknown) => rejection
  );
  expect(error).toBeInstanceOf(PasskeyVerificationError);
  return error as PasskeyVerificationError;
}

describe('verifyAuthentication response.id guard', () => {
  it('refuses a numeric credential id before querying or consuming the challenge', async () => {
    const error = await refusalFor(42);
    expect(error.code).toBe('VERIFICATION_FAILED');
  });

  it('refuses an absent credential id', async () => {
    const error = await refusalFor(undefined);
    expect(error.code).toBe('VERIFICATION_FAILED');
  });

  it('refuses an empty credential id', async () => {
    const error = await refusalFor('');
    expect(error.code).toBe('VERIFICATION_FAILED');
  });
});
