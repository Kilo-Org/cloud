import {
  activeSessionSchema,
  cloudAgentEventSchema,
  cloudWorktreeChangesReadyDataSchema,
  isStreamError,
  isValidCloudAgentEvent,
  parseCustomerBillingFailure,
  remoteCommandCatalogV1Schema,
  sessionEventPayloadSchema,
  sessionEventV2RowSchema,
  sessionStatusDataSchema,
  sessionStatusUpdatedPayloadSchema,
} from './schemas';

function omitKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = record;
  return rest;
}

describe('cloudWorktreeChangesReadyDataSchema', () => {
  it.each([1, 42, Number.MAX_SAFE_INTEGER])('accepts positive safe revision %p', revision => {
    expect(cloudWorktreeChangesReadyDataSchema.parse({ revision })).toEqual({ revision });
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    0,
    -1,
    1.5,
    '1',
    true,
    null,
    undefined,
    {},
    [],
  ])('rejects invalid revision %p', revision => {
    expect(cloudWorktreeChangesReadyDataSchema.safeParse({ revision }).success).toBe(false);
  });

  it.each([null, undefined, [], {}, { revision: 1, extra: true }])(
    'rejects invalid payload %p',
    data => {
      expect(cloudWorktreeChangesReadyDataSchema.safeParse(data).success).toBe(false);
    }
  );

  it('keeps envelope event names open and accepts events without executionId', () => {
    const envelope = {
      eventId: 1,
      sessionId: 'agent-1',
      streamEventType: 'cloud.worktree.changes.ready',
      timestamp: '2026-09-02T00:00:00.000Z',
      data: { revision: 1 },
    };
    expect(cloudAgentEventSchema.parse(envelope)).toEqual(envelope);
    expect(
      cloudAgentEventSchema.safeParse({
        ...envelope,
        streamEventType: 'future.event',
      }).success
    ).toBe(true);
  });
});

describe('isValidCloudAgentEvent', () => {
  const envelope = {
    eventId: 7,
    sessionId: 'agent-1',
    streamEventType: 'message.part.updated',
    timestamp: '2026-10-22T00:00:00.000Z',
    data: { type: 'message.part.updated' },
  };

  it.each([
    ['without executionId', envelope],
    ['with a string executionId', { ...envelope, executionId: 'exec-1' }],
    ['with a null executionId', { ...envelope, executionId: null }],
    ['with an unknown stream event type', { ...envelope, streamEventType: 'future.event' }],
    ['with an extra field', { ...envelope, extra: true }],
  ])('accepts a frame %s', (_case, frame) => {
    expect(isValidCloudAgentEvent(frame)).toBe(true);
  });

  it.each([
    ['a frame without data', omitKey(envelope, 'data')],
    ['a frame without eventId', omitKey(envelope, 'eventId')],
    ['a frame without sessionId', omitKey(envelope, 'sessionId')],
    ['a frame without streamEventType', omitKey(envelope, 'streamEventType')],
    ['a frame without timestamp', omitKey(envelope, 'timestamp')],
    ['a numeric executionId', { ...envelope, executionId: 42 }],
    ['a numeric timestamp', { ...envelope, timestamp: 1 }],
    ['an array', [envelope]],
    ['null', null],
    ['a stream error', { type: 'error', code: 'WS_AUTH_ERROR', message: 'bad' }],
  ])('rejects %s', (_case, frame) => {
    expect(isValidCloudAgentEvent(frame)).toBe(false);
  });
});

describe('isStreamError', () => {
  it.each([
    'WS_PROTOCOL_ERROR',
    'WS_AUTH_ERROR',
    'WS_SESSION_NOT_FOUND',
    'WS_EXECUTION_NOT_FOUND',
    'WS_DUPLICATE_CONNECTION',
    'WS_INTERNAL_ERROR',
  ])('accepts the %s code', code => {
    expect(isStreamError({ type: 'error', code, message: 'bad' })).toBe(true);
  });

  it.each([
    ['an unknown code', { type: 'error', code: 'INVALID', message: 'bad' }],
    ['a missing message', { type: 'error', code: 'WS_AUTH_ERROR' }],
    ['a cloud agent event', { eventId: 1, data: {} }],
    ['null', null],
  ])('rejects %s', (_case, frame) => {
    expect(isStreamError(frame)).toBe(false);
  });
});

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

describe('scheduled session status', () => {
  const scheduledAt = '2026-09-24T09:00:00.000Z';

  it('parses a scheduled session.status payload with its wake time', () => {
    const parsed = sessionStatusDataSchema.parse({
      sessionID: 'ses_12345678901234567890123456',
      status: { type: 'scheduled', scheduledAt },
    });

    expect(parsed.status).toEqual({ type: 'scheduled', scheduledAt });
  });

  it('reads an explicit null wake time as absent instead of failing the parse', () => {
    const parsed = sessionStatusDataSchema.parse({
      sessionID: 'ses_12345678901234567890123456',
      status: { type: 'scheduled', scheduledAt: null },
    });

    expect(parsed.status).toEqual({ type: 'scheduled' });
    if (parsed.status.type !== 'scheduled') {
      throw new Error('expected the scheduled status');
    }
    expect(parsed.status.scheduledAt).toBeUndefined();
  });

  it('carries the wake time through the v2 row and both status-updated payload shapes', () => {
    const row = {
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
      status: 'scheduled',
      statusUpdatedAt: null,
      scheduledAt,
    };

    expect(sessionEventV2RowSchema.parse(row).scheduledAt).toBe(scheduledAt);

    const fullRow = sessionStatusUpdatedPayloadSchema.parse({
      source: 'v2',
      session: row,
      previousStatus: 'idle',
      status: 'scheduled',
      statusUpdatedAt: null,
      scheduledAt,
      changedAt: row.updatedAt,
    });
    expect(fullRow.scheduledAt).toBe(scheduledAt);

    const lightweight = sessionStatusUpdatedPayloadSchema.parse({
      source: 'v2',
      sessionId: row.sessionId,
      previousStatus: 'idle',
      status: 'scheduled',
      statusUpdatedAt: null,
      scheduledAt,
      changedAt: row.updatedAt,
    });
    expect(lightweight.scheduledAt).toBe(scheduledAt);
  });

  it('parses an unknown status string and preserves it verbatim', () => {
    const unknownStatus = 'hibernating';
    const parsed = sessionEventV2RowSchema.parse({
      source: 'v2',
      sessionId: 'ses_12345678901234567890123456',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      title: 'Test',
      createdOnPlatform: 'cloud-agent-web',
      organizationId: null,
      gitUrl: null,
      gitBranch: null,
      parentSessionId: null,
      status: unknownStatus,
      statusUpdatedAt: null,
    });

    expect(parsed.status).toBe(unknownStatus);
    expect(parsed.status).not.toBe('idle');
  });
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

describe('activeSessionSchema scheduledAt', () => {
  it('exposes the wake time for a scheduled session', () => {
    const parsed = activeSessionSchema.parse({
      id: 'ses_remote_scheduled',
      status: 'scheduled',
      title: 'Test',
      scheduledAt: '2026-09-24T09:00:00.000Z',
    });

    expect(parsed.scheduledAt).toBe('2026-09-24T09:00:00.000Z');
  });

  it('leaves the wake time absent when the CLI reports none', () => {
    const parsed = activeSessionSchema.parse({
      id: 'ses_remote_scheduled',
      status: 'scheduled',
      title: 'Test',
    });

    expect(parsed.scheduledAt).toBeUndefined();
  });

  it('reads an explicit null wake time as absent', () => {
    const parsed = activeSessionSchema.parse({
      id: 'ses_remote_scheduled',
      status: 'scheduled',
      title: 'Test',
      scheduledAt: null,
    });

    expect(parsed.scheduledAt).toBeUndefined();
  });
});

describe('live session status values', () => {
  const sessionID = 'ses_12345678901234567890123456';

  it.each(['question', 'permission'] as const)('keeps the documented %s status', type => {
    expect(sessionStatusDataSchema.parse({ sessionID, status: { type } }).status).toEqual({ type });
  });

  it('keeps a status type this SDK does not know yet together with its payload', () => {
    const status = { type: 'offline', requestID: 'que_123', message: 'Kilo is offline' };

    expect(sessionStatusDataSchema.parse({ sessionID, status }).status).toEqual(status);
  });

  it.each([{ type: 'retry' }, { type: 'retry', attempt: 1, message: 'Rate limited' }, {}, 'busy'])(
    'still rejects a status that is not a readable status object: %p',
    status => {
      expect(sessionStatusDataSchema.safeParse({ sessionID, status }).success).toBe(false);
    }
  );
});

describe('remoteCommandCatalogV1Schema runtime-sourced commands', () => {
  it('keeps a skill-sourced command beside an MCP-sourced one', () => {
    const parsed = remoteCommandCatalogV1Schema.parse({
      protocolVersion: 1,
      commands: [
        {
          name: 'mcp-docs',
          description: 'Search the docs MCP server',
          source: 'mcp',
          hints: [],
        },
        {
          name: 'release-notes',
          description: 'Write release notes from a skill',
          source: 'skill',
          hints: [],
        },
      ],
    });

    expect(parsed.commands).toEqual([
      {
        name: 'mcp-docs',
        description: 'Search the docs MCP server',
        source: 'mcp',
        hints: [],
      },
      {
        name: 'release-notes',
        description: 'Write release notes from a skill',
        source: 'skill',
        hints: [],
      },
    ]);
  });
});
