import {
  activeSessionSchema,
  cloudAgentEventSchema,
  cloudSessionMessagesPageSchema,
  cloudSessionMetadataSchema,
  cloudWorktreeChangesReadyDataSchema,
  parseCustomerBillingFailure,
  remoteCommandCatalogV1Schema,
  sessionEventPayloadSchema,
  sessionEventV2RowSchema,
  sessionStatusDataSchema,
  sessionStatusUpdatedPayloadSchema,
} from './schemas';
import { stubUserMessage } from './test-helpers';
import type { AssociatedPrData, FetchedSessionData } from './session-manager';
import type { CloudSessionSnapshotPage } from './types';

describe('cloudSessionMetadataSchema', () => {
  it('preserves safe PR, spend, and origin metadata without exposing unprojected fields', () => {
    const associatedPr = {
      url: 'https://github.com/Kilo-Org/cloud/pull/42',
      number: 42,
      state: 'open',
      title: 'Preserve metadata',
      headSha: 'a'.repeat(40),
      lastSyncedAt: '2026-10-19T21:00:00.000Z',
      platform: 'github',
      reviewDecision: 'approved',
      reviewDecisionPending: false,
    };
    const metadata = {
      sessionId: 'workspace_12345678-1234-4234-9234-123456789abc',
      associatedPr,
      totalCostMicrodollars: 350_000,
      createdOnPlatform: 'extension',
      profileId: 'profile-1',
    };
    expect(cloudSessionMetadataSchema.parse({ ...metadata, unprojected: 'discarded' })).toEqual(
      metadata
    );
  });

  it.each([-1, Infinity, NaN, '42'])('rejects invalid total spend %p', totalCostMicrodollars => {
    expect(
      cloudSessionMetadataSchema.safeParse({ sessionId: 'workspace_root', totalCostMicrodollars })
        .success
    ).toBe(false);
  });

  it.each([{}, { platform: undefined }, { platform: 'github' }])(
    'accepts optional PR platform %p',
    platform => {
      const associatedPr = {
        url: 'https://github.com/Kilo-Org/cloud/pull/42',
        number: 42,
        state: 'open',
        title: null,
        headSha: null,
        lastSyncedAt: '2026-10-19T21:00:00.000Z',
        reviewDecision: null,
        reviewDecisionPending: false,
        ...platform,
      };
      const metadata = cloudSessionMetadataSchema.parse({
        sessionId: 'workspace_root',
        associatedPr,
      });
      const parsedPr: AssociatedPrData | null | undefined = metadata.associatedPr;
      expect(parsedPr).toEqual(associatedPr);
    }
  );

  it.each([{}, { model: undefined, variant: undefined }, { model: 'kilo/auto', variant: 'high' }])(
    'accepts optional runtime agent overrides %p',
    overrides => {
      const runtimeAgents = [{ slug: 'custom', name: 'Custom', ...overrides }];
      const metadata = cloudSessionMetadataSchema.parse({
        sessionId: 'workspace_root',
        runtimeAgents,
      });
      const parsedAgents: FetchedSessionData['runtimeAgents'] = metadata.runtimeAgents;
      expect(parsedAgents).toEqual(runtimeAgents);
    }
  );
});

describe('cloudSessionMessagesPageSchema', () => {
  const sessionId = 'ses_12345678901234567890123456';
  const page = {
    kind: 'success',
    info: {
      id: sessionId,
      title: 'DO session',
      metadata: { 'kilo.goal': { text: 'Ship', status: 'active' } },
    },
    messages: [],
    nextCursor: null,
    omittedItemCount: 0,
    updateCursor: 9,
  };

  it('preserves the mutation cursor and projects native session metadata', () => {
    expect(cloudSessionMessagesPageSchema.parse(page)).toMatchObject({
      info: { id: sessionId, title: 'DO session', goal: { text: 'Ship', status: 'active' } },
      updateCursor: 9,
    });
    expect(cloudSessionMessagesPageSchema.parse(null)).toBeNull();
  });

  it('preserves the all-messages native cost independently of the bounded page', () => {
    const parsed = cloudSessionMessagesPageSchema.parse({
      ...page,
      messages: [],
      nextCursor: 'older',
      totalCostMicrodollars: 350_000,
    });
    expect(parsed?.messages).toEqual([]);
    expect(parsed?.totalCostMicrodollars).toBe(350_000);
  });

  it.each([{}, { totalCostMicrodollars: undefined }, { totalCostMicrodollars: null }])(
    'accepts an unavailable native cost %p',
    cost => {
      const parsed: CloudSessionSnapshotPage | null = cloudSessionMessagesPageSchema.parse({
        ...page,
        ...cost,
      });
      expect(parsed?.totalCostMicrodollars).toBe(cost.totalCostMicrodollars);
    }
  );

  it.each([
    [
      'The message was interrupted',
      { name: 'UnknownError', data: { message: 'The message was interrupted' } },
    ],
    [
      JSON.stringify({ name: 'MessageAbortedError', data: { message: 'Interrupted' } }),
      { name: 'MessageAbortedError', data: { message: 'Interrupted' } },
    ],
  ])('preserves string-encoded native assistant errors in DO snapshots', (error, expected) => {
    const info = {
      id: 'msg_001',
      sessionID: sessionId,
      role: 'assistant',
      parentID: 'msg_user',
      time: { created: 1, completed: 2 },
      modelID: 'fake-deterministic',
      providerID: 'kilo',
      mode: 'code',
      agent: 'code',
      path: { cwd: '/workspace/app', root: '/workspace/app' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error,
    };
    const parsed = cloudSessionMessagesPageSchema.parse({
      ...page,
      messages: [{ info, parts: [] }],
    });
    expect(parsed?.omittedItemCount).toBe(0);
    expect(parsed?.messages[0]?.info).toMatchObject({ error: expected });
  });

  it.each(['text', 'reasoning', 'patch'])(
    'normalizes a known incomplete native %s part instead of omitting it',
    type => {
      const info = stubUserMessage({ id: 'msg_001', sessionID: sessionId });
      const part = {
        id: 'prt_001',
        sessionID: sessionId,
        messageID: info.id,
        type,
        ...(type === 'reasoning' ? { time: { start: 1 } } : {}),
        ...(type === 'patch' ? { hash: 'patch-hash' } : {}),
      };
      const parsed = cloudSessionMessagesPageSchema.parse({
        ...page,
        messages: [{ info, parts: [part] }],
      });
      expect(parsed?.messages[0]?.parts).toEqual([
        { ...part, ...(type === 'patch' ? { files: [] } : { text: '' }) },
      ]);
      expect(parsed?.omittedItemCount).toBe(0);
    }
  );

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '9', null, undefined])(
    'rejects invalid snapshot mutation cursor %p',
    updateCursor => {
      expect(cloudSessionMessagesPageSchema.safeParse({ ...page, updateCursor }).success).toBe(
        false
      );
    }
  );

  it('adapts known slim native fields and accounts for malformed or cross-session rows', () => {
    const info = stubUserMessage({ id: 'msg_001', sessionID: sessionId });
    const part = {
      id: 'prt_001',
      sessionID: sessionId,
      messageID: info.id,
      type: 'tool',
      tool: 'shell',
      callID: 'call_001',
      state: {
        status: 'completed',
        input: {},
        output: 'done',
        title: 'shell',
        time: { start: 1, end: 2 },
      },
    };
    const parsed = cloudSessionMessagesPageSchema.parse({
      ...page,
      omittedItemCount: 2,
      messages: [
        {
          info: { ...info, summary: { title: 'Summary' } },
          parts: [
            part,
            { ...part, id: 'prt_bad', messageID: 'wrong-message' },
            { type: 'unknown' },
          ],
        },
        { info: { ...info, sessionID: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' }, parts: [] },
      ],
    });
    expect(parsed?.messages).toHaveLength(1);
    expect(parsed?.messages[0]?.info).toMatchObject({ summary: { title: 'Summary', diffs: [] } });
    expect(parsed?.messages[0]?.parts).toEqual([
      { ...part, state: { ...part.state, metadata: {} } },
    ]);
    expect(parsed?.omittedItemCount).toBe(5);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1'])(
    'rejects invalid event mutation cursor %p',
    cursor => {
      expect(
        cloudAgentEventSchema.safeParse({
          eventId: 1,
          cursor,
          sessionId: 'workspace_a',
          streamEventType: 'connected',
          timestamp: 'now',
          data: {},
        }).success
      ).toBe(false);
    }
  );
});

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
