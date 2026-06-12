import { describe, expect, it } from 'vitest';

import { ClientErrorSchema, PublicErrorCodeSchema } from './client-error.js';

describe('ClientErrorSchema', () => {
  it('accepts the public client error wire contract', () => {
    expect(
      ClientErrorSchema.parse({
        code: 'PENDING_QUEUE_FULL',
        message: 'Queue is full',
        retryable: true,
      })
    ).toEqual({
      code: 'PENDING_QUEUE_FULL',
      message: 'Queue is full',
      retryable: true,
    });
  });

  it.each(['', 'lowercase', '_PRIVATE', '9INVALID', 'HAS-DASH'])(
    'rejects invalid code %j',
    code => {
      expect(PublicErrorCodeSchema.safeParse(code).success).toBe(false);
    }
  );
});
