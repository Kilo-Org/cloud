import { describe, expect, it } from 'vitest';
import { gastownKilledResponse, isGastownKilled } from './kill-switch.util';

describe('isGastownKilled', () => {
  it('is killed only for the exact value "true"', () => {
    expect(isGastownKilled({ GASTOWN_KILLED: 'true' })).toBe(true);
  });

  it.each(['false', 'TRUE', '1', '', undefined])('is not killed for %j', value => {
    expect(isGastownKilled({ GASTOWN_KILLED: value as 'true' })).toBe(false);
  });
});

describe('gastownKilledResponse', () => {
  it('is an uncacheable 503', async () => {
    const response = gastownKilledResponse();
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ success: false, error: 'Gastown is disabled' });
  });
});
