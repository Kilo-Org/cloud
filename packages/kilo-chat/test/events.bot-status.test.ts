import { describe, it, expect } from 'vitest';
import { botStatusEventSchema } from '../src/events';

describe('botStatusEventSchema', () => {
  it('carries capabilities when present', () => {
    const parsed = botStatusEventSchema.parse({
      sandboxId: 'sbx-abc',
      online: true,
      at: 1,
      capabilities: ['attachments'],
    });
    expect(parsed.capabilities).toEqual(['attachments']);
  });
  it('parses legacy event without capabilities', () => {
    const parsed = botStatusEventSchema.parse({
      sandboxId: 'sbx-abc',
      online: true,
      at: 1,
    });
    expect(parsed.capabilities).toBeUndefined();
  });
});
