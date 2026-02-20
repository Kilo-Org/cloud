/**
 * Unit tests for connection module.
 *
 * Tests the isSessionIdleEvent type guard and session.idle filtering logic.
 */

import { describe, expect, it } from 'vitest';
import { isSessionIdleEvent } from '../../../wrapper/src/connection.js';

// ---------------------------------------------------------------------------
// isSessionIdleEvent
// ---------------------------------------------------------------------------

describe('isSessionIdleEvent', () => {
  it('returns true for a valid session.idle event with sessionID', () => {
    const data = {
      event: 'session.idle',
      properties: { sessionID: 'sess_root_123' },
    };
    expect(isSessionIdleEvent(data)).toBe(true);
  });

  it('narrows properties.sessionID to string', () => {
    const data: unknown = {
      event: 'session.idle',
      properties: { sessionID: 'sess_abc' },
    };
    if (isSessionIdleEvent(data)) {
      // TypeScript should narrow this — verify at runtime
      expect(data.properties.sessionID).toBe('sess_abc');
    } else {
      expect.unreachable('should have matched');
    }
  });

  it('returns false when event is not session.idle', () => {
    const data = {
      event: 'message.updated',
      properties: { sessionID: 'sess_123' },
    };
    expect(isSessionIdleEvent(data)).toBe(false);
  });

  it('returns false when data is null', () => {
    expect(isSessionIdleEvent(null)).toBe(false);
  });

  it('returns false when data is not an object', () => {
    expect(isSessionIdleEvent('session.idle')).toBe(false);
    expect(isSessionIdleEvent(42)).toBe(false);
    expect(isSessionIdleEvent(undefined)).toBe(false);
  });

  it('returns false when properties is missing', () => {
    const data = { event: 'session.idle' };
    expect(isSessionIdleEvent(data)).toBe(false);
  });

  it('returns false when properties is null', () => {
    const data = { event: 'session.idle', properties: null };
    expect(isSessionIdleEvent(data)).toBe(false);
  });

  it('returns false when sessionID is missing from properties', () => {
    const data = { event: 'session.idle', properties: {} };
    expect(isSessionIdleEvent(data)).toBe(false);
  });

  it('returns false when sessionID is not a string', () => {
    const data = { event: 'session.idle', properties: { sessionID: 123 } };
    expect(isSessionIdleEvent(data)).toBe(false);
  });
});
