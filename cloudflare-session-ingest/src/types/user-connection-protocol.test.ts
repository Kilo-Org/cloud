import { describe, it, expect } from 'vitest';
import {
  CLIOutboundMessageSchema,
  CLIInboundMessageSchema,
  WebOutboundMessageSchema,
  WebInboundMessageSchema,
} from './user-connection-protocol';

const validSessionId = 'ses_12345678901234567890123456';

describe('CLIOutboundMessageSchema', () => {
  it('parses valid heartbeat', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [{ id: validSessionId, status: 'busy', title: 'Fix bug' }],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses heartbeat with empty sessions', () => {
    const msg = { type: 'heartbeat', sessions: [] };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('rejects heartbeat with null title', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [{ id: validSessionId, status: 'busy', title: null }],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it('parses valid event', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      event: 'message.updated',
      data: { id: 'msg_1' },
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid response', () => {
    const msg = { type: 'response', id: 'req_abc', result: { ok: true } };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses response with error only', () => {
    const msg = { type: 'response', id: 'req_err', error: 'not found' };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses event with parentSessionId', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      parentSessionId: 'parent-ses-1',
      event: 'message.updated',
      data: { id: 'msg-1' },
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty('parentSessionId', 'parent-ses-1');
    }
  });

  it('parses event without parentSessionId (backward compat)', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      event: 'message.updated',
      data: { id: 'msg-1' },
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('parentSessionId');
    }
  });

  it('rejects unknown type', () => {
    const msg = { type: 'unknown' };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });
});

describe('CLIInboundMessageSchema', () => {
  it('parses valid subscribe', () => {
    const msg = { type: 'subscribe', sessionId: validSessionId };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid unsubscribe', () => {
    const msg = { type: 'unsubscribe', sessionId: validSessionId };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid command', () => {
    const msg = {
      type: 'command',
      id: 'cmd_1',
      command: 'send_message',
      sessionId: validSessionId,
      data: { text: 'hello' },
    };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses command without sessionId', () => {
    const msg = {
      type: 'command',
      id: 'cmd_2',
      command: 'list_sessions',
      data: null,
    };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid system', () => {
    const msg = { type: 'system', event: 'web.connected', data: {} };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('rejects subscribe with missing sessionId', () => {
    const msg = { type: 'subscribe' };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });
});

describe('WebOutboundMessageSchema', () => {
  it('parses valid subscribe', () => {
    const msg = { type: 'subscribe', sessionId: validSessionId };
    const result = WebOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid unsubscribe', () => {
    const msg = { type: 'unsubscribe', sessionId: validSessionId };
    const result = WebOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid command', () => {
    const msg = {
      type: 'command',
      id: 'req_1',
      command: 'send_message',
      sessionId: validSessionId,
      data: { text: 'hi' },
    };
    const result = WebOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses command with connectionId', () => {
    const msg = {
      type: 'command',
      id: 'req_2',
      command: 'start_session',
      connectionId: 'conn_1',
      data: {},
    };
    const result = WebOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('rejects command without id', () => {
    const msg = { type: 'command', command: 'test', data: {} };
    const result = WebOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });
});

describe('WebInboundMessageSchema', () => {
  it('parses valid event', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      event: 'session.updated',
      data: {},
    };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid system', () => {
    const msg = {
      type: 'system',
      event: 'cli.connected',
      data: { connectionId: 'conn_1' },
    };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid response', () => {
    const msg = { type: 'response', id: 'req_abc', result: { success: true } };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses event with parentSessionId', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      parentSessionId: 'parent-ses-1',
      event: 'message.updated',
      data: { id: 'msg-1' },
    };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty('parentSessionId', 'parent-ses-1');
    }
  });

  it('parses event without parentSessionId (backward compat)', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      event: 'session.updated',
      data: {},
    };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('parentSessionId');
    }
  });

  it('rejects unknown type', () => {
    const msg = { type: 'unknown', data: {} };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });
});

describe('extra fields', () => {
  it('strips unknown fields by default on strict objects', () => {
    const msg = {
      type: 'subscribe',
      sessionId: validSessionId,
      extra: 'should-be-stripped',
    };
    const result = WebOutboundMessageSchema.parse(msg);
    expect(result).not.toHaveProperty('extra');
  });
});
