import { describe, it, expect } from 'vitest';
import {
  CLIWebSocketMessageSchema,
  ServerToWebMessageSchema,
  WebToServerMessageSchema,
  ServerToCLIMessageSchema,
} from './ws-protocol';

const validSessionId = 'ses_12345678901234567890123456';

describe('CLIWebSocketMessageSchema', () => {
  it('parses a valid ingest message', () => {
    const msg = {
      type: 'ingest',
      sessionId: validSessionId,
      data: [{ type: 'session', data: { title: 'Hello' } }],
    };
    const result = CLIWebSocketMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('rejects an invalid sessionId', () => {
    const msg = {
      type: 'ingest',
      sessionId: 'bad_id',
      data: [{ type: 'session', data: {} }],
    };
    const result = CLIWebSocketMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it('parses with an empty data array', () => {
    const msg = {
      type: 'ingest',
      sessionId: validSessionId,
      data: [],
    };
    const result = CLIWebSocketMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });
});

describe('ServerToWebMessageSchema', () => {
  it('parses a valid catch_up message', () => {
    const msg = {
      type: 'catch_up',
      items: [{ sessionId: 'ses_abc', itemId: 'i1', itemType: 'message', itemData: '{}' }],
    };
    const result = ServerToWebMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses a valid events message', () => {
    const msg = {
      type: 'events',
      sessionId: validSessionId,
      data: [{ type: 'session', data: {} }],
    };
    const result = ServerToWebMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses a valid cli_status message', () => {
    const msg = { type: 'cli_status', connected: true };
    const result = ServerToWebMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('rejects an invalid type', () => {
    const msg = { type: 'unknown_type', data: {} };
    const result = ServerToWebMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });
});

describe('WebToServerMessageSchema', () => {
  it('parses a valid command message', () => {
    const msg = { type: 'command', command: 'approve', data: { id: 1 } };
    const result = WebToServerMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('rejects a message with missing command', () => {
    const msg = { type: 'command', data: {} };
    const result = WebToServerMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });
});

describe('ServerToCLIMessageSchema', () => {
  it('parses a valid command message', () => {
    const msg = { type: 'command', command: 'run', data: null };
    const result = ServerToCLIMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });
});

describe('extra fields', () => {
  it('strips unknown fields by default on strict objects', () => {
    const msg = {
      type: 'command',
      command: 'test',
      data: 'x',
      extra: 'should-be-stripped',
    };
    const result = WebToServerMessageSchema.parse(msg);
    expect(result).not.toHaveProperty('extra');
  });
});
