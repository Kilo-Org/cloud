import { describe, expect, it } from 'vitest';
import {
  CLIENT_REGISTRATION_TTL_SECONDS,
  REFRESH_HISTORY_TTL_MS,
  REFRESH_TOKEN_TTL_SECONDS,
  SESSION_LIFETIME_SECONDS,
} from './session-lifetime';

/**
 * Pins the session-lifetime policy so neither the shipped bound nor the request
 * floor can move silently. Every assertion reads an imported constant; the
 * literals here are the pin, never a re-derivation of the values.
 */
describe('session lifetime policy', () => {
  it('ships exactly one year (365 * 24 * 60 * 60 seconds)', () => {
    expect(SESSION_LIFETIME_SECONDS).toBe(365 * 24 * 60 * 60);
  });

  it('gives the refresh grant the whole session', () => {
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(SESSION_LIFETIME_SECONDS);
  });

  it('keeps the DCR record past the grant so a lapsed session is invalid_grant', () => {
    // A record that expired with the grant would be looked up first and turn a
    // lapsed session into `invalid_client`, which no MCP client re-authorizes on.
    expect(CLIENT_REGISTRATION_TTL_SECONDS).toBeGreaterThan(SESSION_LIFETIME_SECONDS);
  });

  it('keeps the replay guard memory covering the whole session', () => {
    expect(REFRESH_HISTORY_TTL_MS).toBe(SESSION_LIFETIME_SECONDS * 1000);
  });

  it('meets the request floor: at least once every 2 weeks', () => {
    // The owner's fallback is "so they don't need to sign in too often (eg once
    // every 2 weeks)"; this assertion is the requirement that floor pins.
    expect(SESSION_LIFETIME_SECONDS).toBeGreaterThanOrEqual(14 * 24 * 60 * 60);
  });
});
