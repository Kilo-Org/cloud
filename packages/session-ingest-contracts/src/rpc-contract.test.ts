/**
 * Tests for the Cloud Agent attention RPC contract.
 *
 * The schema intentionally permits only `question` and `permission` reasons —
 * `blocking_suggestion` is excluded because the wrapper's policy filter
 * suppresses suggestions before they reach the worker, and the per-session
 * outbox handles them separately. The contract also rejects any extra body
 * fields so the producer cannot smuggle prompt text or permission arguments
 * into the RPC surface.
 */
import { describe, expect, it } from 'vitest';

import { recordCloudAgentSessionAttentionSchema, sessionIdSchema } from './index';

const VALID_KILO_SESSION_ID = 'ses_12345678901234567890123456';

function validRaise() {
  return {
    kiloUserId: 'usr_owner',
    kiloSessionId: VALID_KILO_SESSION_ID,
    requestId: 'req_attn_01',
    intent: { kind: 'raise', reason: 'question' },
  };
}

function validResolve() {
  return {
    kiloUserId: 'usr_owner',
    kiloSessionId: VALID_KILO_SESSION_ID,
    requestId: 'req_attn_01',
    intent: { kind: 'resolve' },
  };
}

describe('recordCloudAgentSessionAttentionSchema', () => {
  it('accepts a valid raise intent with reason "question"', () => {
    const result = recordCloudAgentSessionAttentionSchema.safeParse(validRaise());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validRaise());
    }
  });

  it('accepts a valid raise intent with reason "permission"', () => {
    const result = recordCloudAgentSessionAttentionSchema.safeParse({
      ...validRaise(),
      intent: { kind: 'raise', reason: 'permission' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid resolve intent', () => {
    const result = recordCloudAgentSessionAttentionSchema.safeParse(validResolve());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validResolve());
    }
  });

  it('rejects a raise intent with the blocking_suggestion reason', () => {
    const result = recordCloudAgentSessionAttentionSchema.safeParse({
      ...validRaise(),
      intent: { kind: 'raise', reason: 'blocking_suggestion' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown reason string', () => {
    const result = recordCloudAgentSessionAttentionSchema.safeParse({
      ...validRaise(),
      intent: { kind: 'raise', reason: 'urgent' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-`ses_` kilo session ID before the DO is reached', () => {
    const result = recordCloudAgentSessionAttentionSchema.safeParse({
      ...validRaise(),
      kiloSessionId: 'not-a-session',
    });
    expect(result.success).toBe(false);
    expect(sessionIdSchema.safeParse('not-a-session').success).toBe(false);
  });

  it('rejects a kilo session ID of the wrong length', () => {
    const result = recordCloudAgentSessionAttentionSchema.safeParse({
      ...validRaise(),
      kiloSessionId: 'ses_short',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty requestId', () => {
    const result = recordCloudAgentSessionAttentionSchema.safeParse({
      ...validRaise(),
      requestId: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty kiloUserId', () => {
    const result = recordCloudAgentSessionAttentionSchema.safeParse({
      ...validRaise(),
      kiloUserId: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown intent kind', () => {
    const result = recordCloudAgentSessionAttentionSchema.safeParse({
      ...validRaise(),
      intent: { kind: 'cancel' },
    });
    expect(result.success).toBe(false);
  });

  it('strips any raw body or envelope payload from the contract', () => {
    const result = recordCloudAgentSessionAttentionSchema.safeParse({
      ...validRaise(),
      body: 'raw prompt text that must be stripped',
      promptText: 'another raw field',
      envelope: { id: 'e_1', payload: 'secret' },
      permissionArgs: { command: 'rm -rf /' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('body');
      expect(result.data).not.toHaveProperty('promptText');
      expect(result.data).not.toHaveProperty('envelope');
      expect(result.data).not.toHaveProperty('permissionArgs');
      expect(result.data).toEqual(validRaise());
    }
  });
});
