import { activeSessionSchema, parseCustomerBillingFailure } from './schemas';

describe('parseCustomerBillingFailure', () => {
  const failure = {
    code: 'COMPUTE_STOPPING',
    payer: { type: 'org', id: 'org-1' },
    retryable: true,
  } as const;
  it.each([
    { data: { billingFailure: failure } },
    { shape: { data: { billingFailure: failure } } },
  ])('parses an explicit billing failure from either tRPC location', error =>
    expect(parseCustomerBillingFailure(error)).toEqual(failure)
  );
  it.each([
    { data: { billingFailure: { ...failure, payer: { type: 'org' } } } },
    { data: { code: 'PAYMENT_REQUIRED', httpStatus: 402 } },
  ])('omits malformed or legacy generic errors', error =>
    expect(parseCustomerBillingFailure(error)).toBeNull()
  );
});

describe('activeSessionSchema capabilities', () => {
  it('parses a session whose `capabilities` is absent', () => {
    const parsed = activeSessionSchema.parse({
      id: 'ses_remote_a',
      status: 'idle',
      title: 'Test',
      connectionId: 'conn-1',
    });
    expect(parsed.capabilities).toBeUndefined();
  });

  it('parses a session whose `capabilities.attachments` is false', () => {
    const parsed = activeSessionSchema.parse({
      id: 'ses_remote_b',
      status: 'idle',
      title: 'Test',
      connectionId: 'conn-1',
      capabilities: { attachments: false },
    });
    expect(parsed.capabilities).toEqual({ attachments: false });
  });

  it('parses a session whose `capabilities.attachments` is true', () => {
    const parsed = activeSessionSchema.parse({
      id: 'ses_remote_c',
      status: 'idle',
      title: 'Test',
      connectionId: 'conn-1',
      capabilities: { attachments: true },
    });
    expect(parsed.capabilities).toEqual({ attachments: true });
  });

  it('parses a session whose `capabilities` is an empty object (no attachments key)', () => {
    const parsed = activeSessionSchema.parse({
      id: 'ses_remote_d',
      status: 'idle',
      title: 'Test',
      connectionId: 'conn-1',
      capabilities: {},
    });
    expect(parsed.capabilities).toEqual({});
  });

  it('rejects a session whose `capabilities.attachments` is not a boolean', () => {
    const result = activeSessionSchema.safeParse({
      id: 'ses_remote_e',
      status: 'idle',
      title: 'Test',
      connectionId: 'conn-1',
      capabilities: { attachments: 'yes' },
    });
    expect(result.success).toBe(false);
  });
});
