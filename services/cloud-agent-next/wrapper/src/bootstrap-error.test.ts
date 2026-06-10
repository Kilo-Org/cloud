import { describe, expect, it } from 'bun:test';
import { kiloServerStartupError } from './bootstrap-error';

describe('kiloServerStartupError', () => {
  it('classifies startup failures without exposing raw secrets', () => {
    const error = kiloServerStartupError();

    expect(error).toMatchObject({
      code: 'KILO_SERVER_FAILED',
      message: 'Failed to start Kilo server',
      retryable: true,
    });
    expect(error.detail).toBeUndefined();
    expect(error.message).not.toContain('startup-secret');
  });
});
