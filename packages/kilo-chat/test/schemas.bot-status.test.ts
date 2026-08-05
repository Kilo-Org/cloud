import { describe, it, expect } from 'vitest';
import { botStatusRequestSchema, botStatusRecordSchema } from '../src/schemas';

describe('botStatusRequestSchema with capabilities', () => {
  it('parses payload with capabilities array', () => {
    const parsed = botStatusRequestSchema.parse({
      online: true,
      at: 1000,
      capabilities: ['attachments'],
    });
    expect(parsed.capabilities).toEqual(['attachments']);
  });
  it('parses legacy payload without capabilities (back-compat)', () => {
    const parsed = botStatusRequestSchema.parse({ online: true, at: 1000 });
    expect(parsed.capabilities).toBeUndefined();
  });
  it('filters unknown capabilities, keeping known ones', () => {
    const r = botStatusRequestSchema.safeParse({
      online: true,
      at: 1,
      capabilities: ['foo'],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.capabilities).toEqual([]);
    }
  });

  it('filters mixed known and unknown capabilities', () => {
    const r = botStatusRequestSchema.safeParse({
      online: true,
      at: 1,
      capabilities: ['attachments', 'foo'],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.capabilities).toEqual(['attachments']);
    }
  });
});

describe('botStatusRecordSchema with capabilities', () => {
  it('round-trips capabilities', () => {
    const parsed = botStatusRecordSchema.parse({
      online: true,
      at: 1,
      updatedAt: 2,
      capabilities: ['attachments'],
    });
    expect(parsed.capabilities).toEqual(['attachments']);
  });

  it('filters unknown capabilities from record', () => {
    const parsed = botStatusRecordSchema.parse({
      online: true,
      at: 1,
      updatedAt: 2,
      capabilities: ['attachments', 'unknown'],
    });
    expect(parsed.capabilities).toEqual(['attachments']);
  });
});
