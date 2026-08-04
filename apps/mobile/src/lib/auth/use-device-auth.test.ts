import { describe, expect, it } from 'vitest';
import { getDeviceAuth429Message } from '@/lib/auth/poll-response';

describe('use-device-auth start path — 429 rate-limit message', () => {
  it('extracts the server error field from a 429 JSON body', () => {
    const serverBody = {
      error: 'Too many sign-in attempts from this network. Wait a few minutes and try again.',
    };
    const message = getDeviceAuth429Message(serverBody);
    expect(message).toBe(serverBody.error);
  });

  it('falls back to a fixed string when the server body has no error field', () => {
    const serverBody: { error?: string } = {};
    const message = getDeviceAuth429Message(serverBody);
    expect(message).toBe('Too many sign-in attempts. Please wait and try again.');
  });

  it('falls back to the fixed string when JSON parsing fails', () => {
    const message = getDeviceAuth429Message(undefined);
    expect(message).toBe('Too many sign-in attempts. Please wait and try again.');
  });
});
