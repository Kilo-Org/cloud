/**
 * Tests for the runtime-validated input of `SessionIngestDO.recordAttentionEvent`.
 */

import { describe, expect, it } from 'vitest';

import { recordAttentionEventInputSchema } from './attention-event-input';

function validBase() {
  return {
    kiloUserId: 'u_1',
    sessionId: 's_1',
    requestId: 'r_1',
  };
}

describe('recordAttentionEventInputSchema', () => {
  it('accepts a valid raise intent', () => {
    const result = recordAttentionEventInputSchema.safeParse({
      ...validBase(),
      intent: { kind: 'raise', reason: 'question' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.intent).toEqual({ kind: 'raise', reason: 'question' });
    }
  });

  it('accepts a valid resolve intent', () => {
    const result = recordAttentionEventInputSchema.safeParse({
      ...validBase(),
      intent: { kind: 'resolve' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        ...validBase(),
        intent: { kind: 'resolve' },
      });
    }
  });

  it('rejects an unknown reason', () => {
    const result = recordAttentionEventInputSchema.safeParse({
      ...validBase(),
      intent: { kind: 'raise', reason: 'unknown' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty reason', () => {
    const result = recordAttentionEventInputSchema.safeParse({
      ...validBase(),
      intent: { kind: 'raise', reason: '' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid reason type', () => {
    const result = recordAttentionEventInputSchema.safeParse({
      ...validBase(),
      intent: { kind: 'raise', reason: 123 },
    });
    expect(result.success).toBe(false);
  });

  it('strips any raw body or envelope payload', () => {
    const result = recordAttentionEventInputSchema.safeParse({
      ...validBase(),
      intent: { kind: 'raise', reason: 'question' },
      body: 'raw prompt text that must be stripped',
      promptText: 'another raw field',
      envelope: { id: 'e_1', payload: 'secret' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('body');
      expect(result.data).not.toHaveProperty('promptText');
      expect(result.data).not.toHaveProperty('envelope');
      expect(result.data).toEqual({
        ...validBase(),
        intent: { kind: 'raise', reason: 'question' },
      });
    }
  });
});
