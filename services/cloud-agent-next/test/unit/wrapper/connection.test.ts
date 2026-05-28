/**
 * Unit tests for connection module.
 *
 * Tests connection diagnostics, event trimming, and session.idle filtering logic.
 */

import { describe, expect, it } from 'vitest';
import {
  buildIngestConnectionFailureMessage,
  isSessionIdleEvent,
  isAssistantMessageCompleted,
  getCompletedAssistantParentID,
  trimIngestEvent,
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

describe('trimIngestEvent', () => {
  it('trims top-level file parts before ingest serialization', () => {
    const rawDataUrl = 'data:image/png;base64,wrapper-private-image';
    const rawSourceText = 'wrapper private source text';

    const event = trimIngestEvent({
      streamEventType: 'kilocode',
      data: {
        event: 'message.part.updated',
        type: 'message.part.updated',
        part: {
          type: 'file',
          url: rawDataUrl,
          source: { text: { value: rawSourceText } },
        },
      },
      timestamp: '2026-04-14T08:00:00.000Z',
    });

    const payload = event.data as {
      part: { url: string; source: { text: { value: string } } };
    };

    expect(payload.part.url).toBe('');
    expect(payload.part.source.text.value).toBe('');
    expect(JSON.stringify(event)).not.toContain(rawDataUrl);
    expect(JSON.stringify(event)).not.toContain(rawSourceText);
  });
});

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

// ---------------------------------------------------------------------------
// isAssistantMessageCompleted
// ---------------------------------------------------------------------------

describe('isAssistantMessageCompleted', () => {
  const completedAssistant = {
    event: 'message.updated' as const,
    properties: {
      info: {
        role: 'assistant',
        parentID: 'msg_018f1e2d3c4bParentMsg123456',
        id: 'assistant_msg_001',
        time: { completed: 1700000000000 },
      },
    },
  };

  it('returns true for a completed assistant message.updated event', () => {
    expect(isAssistantMessageCompleted(completedAssistant)).toBe(true);
  });

  it('returns parentID via getCompletedAssistantParentID', () => {
    expect(getCompletedAssistantParentID(completedAssistant)).toBe(
      'msg_018f1e2d3c4bParentMsg123456'
    );
  });

  it('returns true for object-shaped terminal assistant errors', () => {
    const failedAssistant = {
      event: 'message.updated' as const,
      properties: {
        info: {
          role: 'assistant',
          parentID: 'msg_018f1e2d3c4bParentMsg123456',
          id: 'assistant_msg_error',
          error: { name: 'UnknownError', data: { message: 'provider failed' } },
        },
      },
    };

    expect(isAssistantMessageCompleted(failedAssistant)).toBe(true);
    expect(getCompletedAssistantParentID(failedAssistant)).toBe('msg_018f1e2d3c4bParentMsg123456');
  });

  it('returns false when event is not message.updated', () => {
    expect(
      isAssistantMessageCompleted({
        event: 'session.idle',
        properties: completedAssistant.properties,
      })
    ).toBe(false);
  });

  it('returns false when role is not assistant', () => {
    expect(
      isAssistantMessageCompleted({
        event: 'message.updated',
        properties: {
          info: { ...completedAssistant.properties.info, role: 'user' },
        },
      })
    ).toBe(false);
  });

  it('returns false when parentID is missing', () => {
    const data = {
      event: 'message.updated' as const,
      properties: {
        info: {
          role: 'assistant',
          id: 'assistant_msg_001',
          time: { completed: 1700000000000 },
        },
      },
    };
    expect(isAssistantMessageCompleted(data)).toBe(false);
  });

  it('returns false when time.completed is missing', () => {
    const data = {
      event: 'message.updated' as const,
      properties: {
        info: {
          role: 'assistant',
          parentID: 'msg_018f1e2d3c4bParentMsg123456',
          id: 'assistant_msg_001',
          time: {},
        },
      },
    };
    expect(isAssistantMessageCompleted(data)).toBe(false);
  });

  it('returns false when time is missing entirely', () => {
    const data = {
      event: 'message.updated' as const,
      properties: {
        info: {
          role: 'assistant',
          parentID: 'msg_018f1e2d3c4bParentMsg123456',
          id: 'assistant_msg_001',
        },
      },
    };
    expect(isAssistantMessageCompleted(data)).toBe(false);
  });

  it('returns false when data is null', () => {
    expect(isAssistantMessageCompleted(null)).toBe(false);
  });

  it('returns false when data is not an object', () => {
    expect(isAssistantMessageCompleted('message.updated')).toBe(false);
    expect(isAssistantMessageCompleted(undefined)).toBe(false);
  });

  it('getCompletedAssistantParentID returns undefined for non-matching data', () => {
    expect(getCompletedAssistantParentID(null)).toBeUndefined();
    expect(getCompletedAssistantParentID({ event: 'other' })).toBeUndefined();
  });
});
