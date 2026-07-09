/**
 * Unit tests for connection module.
 *
 * Tests connection diagnostics and session.idle filtering logic.
 */

import { describe, expect, it } from 'vitest';
import {
  buildIngestConnectionFailureMessage,
  isSessionIdleEvent,
} from '../../../wrapper/src/connection.js';

// ---------------------------------------------------------------------------
// Ingest connection diagnostics
// ---------------------------------------------------------------------------

describe('buildIngestConnectionFailureMessage', () => {
  it('explains websocket errors without assuming a network or DO cause', () => {
    const message = buildIngestConnectionFailureMessage({
      reason: 'websocket_error',
      wsUrl: 'http://192.168.200.164:8794/sessions/user/agent/ingest?executionId=exc_123',
    });

    expect(message).toContain('Failed to connect to ingest: http://192.168.200.164:8794');
    expect(message).toContain('Bun does not expose the HTTP status');
    expect(message).toContain('check WORKER_URL and sandbox-to-host networking');
    expect(message).toContain('inspect the DO rejection reason');
  });

  it('includes close code and reason when the socket closes before opening', () => {
    const message = buildIngestConnectionFailureMessage({
      reason: 'closed_before_open',
      wsUrl: 'http://worker.test/ingest',
      closeCode: 1006,
      closeReason: '',
    });

    expect(message).toContain('WebSocket closed before open');
    expect(message).toContain('closeCode=1006 closeReason=(none)');
  });

  it('uses a reachability hint for initial connection timeouts', () => {
    const message = buildIngestConnectionFailureMessage({
      reason: 'timeout',
      wsUrl: 'http://worker.test/ingest',
    });

    expect(message).toContain('Timed out before open');
    expect(message).toContain('sandbox can reach the local cloud-agent Worker');
  });
});

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
