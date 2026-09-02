import {
  activeSessionSchema,
  parseCustomerBillingFailure,
  sessionEventPayloadSchema,
  sessionEventV2RowSchema,
} from './schemas';

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
    { data: { billingFailure: { ...failure, remainingMicrodollars: -1 } } },
    { data: { code: 'PAYMENT_REQUIRED', httpStatus: 402 } },
  ])('omits malformed or legacy generic errors', error =>
    expect(parseCustomerBillingFailure(error)).toBeNull()
  );

  it('preserves zero-valued customer billing balances from the Worker', () => {
    expect(
      parseCustomerBillingFailure({
        data: {
          billingFailure: {
            ...failure,
            remainingMicrodollars: 0,
            minimumRequiredMicrodollars: 0,
          },
        },
      })
    ).toMatchObject({ remainingMicrodollars: 0, minimumRequiredMicrodollars: 0 });
  });
});

describe('session worktree event schemas', () => {
  const session = {
    source: 'v2' as const,
    sessionId: 'ses_12345678901234567890123456',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    title: 'Test',
    createdOnPlatform: 'cloud-agent-web',
    organizationId: null,
    gitUrl: null,
    gitBranch: null,
    parentSessionId: null,
    status: 'idle' as const,
    statusUpdatedAt: null,
  };

  it.each([null, undefined])('accepts legacy worktree ID %s', worktreeId => {
    const parsed = sessionEventV2RowSchema.parse({
      ...session,
      ...(worktreeId === undefined ? {} : { worktreeId }),
    });

    expect(parsed.worktreeId).toBe(worktreeId);
  });

  it.each(['session.created', 'session.updated'] as const)(
    'retains worktree IDs in %s payloads',
    type => {
      const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
      const event = sessionEventPayloadSchema.parse({
        type,
        data: {
          source: 'v2',
          session: { ...session, worktreeId },
          changedAt: session.updatedAt,
        },
      });

      expect(event.data).toHaveProperty('session.worktreeId', worktreeId);
    }
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
