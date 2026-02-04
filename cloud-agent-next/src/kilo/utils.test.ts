import { describe, expect, it } from 'vitest';
import { executionIdToMessageId, extractUuid } from './utils.js';
import { KiloClientError } from './errors.js';

describe('executionIdToMessageId', () => {
  it('returns msg_* id unchanged (identity function)', () => {
    expect(executionIdToMessageId('msg_123')).toBe('msg_123');
    expect(executionIdToMessageId('msg_abc-def-ghi')).toBe('msg_abc-def-ghi');
  });

  it('throws for invalid execution id (non-msg_ prefix)', () => {
    expect(() => executionIdToMessageId('bad_123')).toThrow(KiloClientError);
    expect(() => executionIdToMessageId('exec_123')).toThrow(KiloClientError);
  });
});

describe('extractUuid', () => {
  it('extracts uuid portion from msg_ id', () => {
    expect(extractUuid('msg_123-456-789')).toBe('123-456-789');
    expect(extractUuid('msg_abc')).toBe('abc');
  });
});
