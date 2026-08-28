import { activeSessionSchema, parseCustomerBillingFailure } from './schemas';
import * as browser from './schemas';
import * as relay from '../../../services/session-ingest/src/types/user-connection-protocol';

// Canonical v1 examples also appear in the relay protocol tests.
const requestId = '00000000-0000-4000-8000-000000000001';
const handle = {
  providerId: 'bp_00000000-0000-4000-8000-000000000002',
  browserTaskId: 'bt_00000000-0000-4000-8000-000000000003',
  jobId: 'bj_00000000-0000-4000-8000-000000000004',
  invocationId: `b1.1787875200000.${'a'.repeat(64)}`,
} as const;
const owner = { parentSessionId: 'ses_parent', parentProof: 'b'.repeat(64) };
const binding = { providerId: handle.providerId, generation: 1 };
const jobBinding = { ...handle, generation: 1 };
const tab = {
  tabId: 7,
  title: 'Example',
  url: 'https://example.com/',
  effectiveMode: 'safe',
} as const;
const job = {
  ...jobBinding,
  payloadFingerprint: 'c'.repeat(64),
  createdAt: '2026-08-28T00:00:00.000Z',
  expiresAt: '2026-09-04T00:00:00.000Z',
  deadlines: { queue: '2026-08-28T00:10:00.000Z', approval: '2026-08-28T00:02:00.000Z' },
  status: 'awaiting_approval',
} as const;
const completed = {
  ...handle,
  status: 'succeeded',
  reason: 'completed',
  effectsUncertain: false,
  summary: 'Read the example page',
  evidence: [{ text: 'Example Domain', title: tab.title, url: tab.url }],
} satisfies browser.BrowserResult;
const finishedJob = { ...job, status: 'succeeded', approvedTab: tab, result: completed } as const;
const invoke = {
  type: 'browser_request',
  requestId,
  operation: 'invoke',
  owner,
  providerId: handle.providerId,
  invocationId: handle.invocationId,
  goal: 'Read the example page',
} as const;
const registration = {
  type: 'provider_register',
  requestId,
  providerId: handle.providerId,
  generation: 0,
  providerProof: 'd'.repeat(64),
  label: 'Work browser',
  enabled: true,
} as const;
const provider = {
  providerId: handle.providerId,
  label: registration.label,
  availability: 'available',
  queueDepth: 0,
} as const;
const cliRequests = [
  { type: 'browser_request', requestId, operation: 'list' },
  { type: 'browser_request', requestId, operation: 'list', cursor: handle.providerId },
  invoke,
  { ...invoke, browserTaskId: handle.browserTaskId },
  ...(['status', 'cancel'] as const).flatMap(operation => [
    { type: 'browser_request', requestId, operation, owner, browserTaskId: handle.browserTaskId },
    {
      type: 'browser_request',
      requestId,
      operation,
      owner,
      browserTaskId: handle.browserTaskId,
      jobId: handle.jobId,
    },
  ]),
  {
    type: 'browser_request',
    requestId,
    operation: 'recover',
    owner,
    invocationId: handle.invocationId,
  },
];
const cliResponses = [
  { type: 'browser_response', requestId, response: { kind: 'providers', providers: [] } },
  {
    type: 'browser_response',
    requestId,
    response: { kind: 'providers', providers: [provider], nextCursor: handle.providerId },
  },
  ...(['invoke', 'cancel'] as const).map(operation => ({
    type: 'browser_response',
    requestId,
    response: { kind: 'ack', operation, ...handle },
  })),
  { type: 'browser_response', requestId, response: { kind: 'status', job } },
  { type: 'browser_response', requestId, response: { kind: 'recovered', job: finishedJob } },
  {
    type: 'browser_response',
    requestId,
    response: { kind: 'not_found', invocationId: handle.invocationId },
  },
  {
    type: 'browser_response',
    requestId,
    response: {
      kind: 'error',
      code: 'provider_unavailable',
      message: 'Open the browser panel',
      retryable: true,
    },
  },
  {
    type: 'browser_response',
    requestId,
    response: {
      kind: 'error',
      code: 'owner_mismatch',
      message: 'This parent does not own the job',
      retryable: false,
    },
  },
];
const cliEvents = [
  { type: 'browser_event', requestId, event: 'progress', job },
  { type: 'browser_event', requestId, event: 'result', result: completed },
];
const providerStatusRequest = {
  type: 'provider_status',
  requestId,
  providerId: handle.providerId,
  providerProof: registration.providerProof,
} as const;
const interruptedHandle = {
  ...handle,
  jobId: 'bj_00000000-0000-4000-8000-000000000005',
  invocationId: `b1.1787875200000.${'e'.repeat(64)}`,
} as const;
const providerStatusResult = {
  type: 'provider_status_result',
  requestId,
  providerId: handle.providerId,
  jobs: [
    finishedJob,
    {
      ...finishedJob,
      ...interruptedHandle,
      generation: 2,
      status: 'interrupted',
      result: {
        ...completed,
        ...interruptedHandle,
        status: 'interrupted',
        reason: 'effects_uncertain',
        effectsUncertain: true,
      },
    },
  ],
  nextCursor: interruptedHandle.jobId,
} as const;
const providerOutbound = [
  providerStatusRequest,
  { ...providerStatusRequest, cursor: handle.jobId },
  registration,
  {
    ...registration,
    generation: 1,
    recovery: {
      invocationId: handle.invocationId,
      tabId: tab.tabId,
      tabClosed: true,
      locksDrained: true,
    },
  },
  { type: 'provider_heartbeat', requestId, ...binding, cursor: handle.jobId },
  { type: 'provider_approval', ...jobBinding, approval: { decision: 'approved', tab } },
  {
    type: 'provider_approval',
    ...jobBinding,
    approval: { decision: 'denied', reason: 'approval_denied' },
  },
  { type: 'provider_result', ...jobBinding, tab, result: completed },
  { type: 'provider_quiesced', ...jobBinding, tabId: tab.tabId },
  { type: 'provider_unavailable', ...binding, reason: 'provider_lost', effectsUncertain: true },
  { type: 'provider_cancel', ...jobBinding },
];
const providerInbound = [
  { type: 'provider_job', job, goal: invoke.goal, ownerLabel: 'Parent chat' },
  { type: 'provider_job_cancel', ...jobBinding, reason: 'cancelled' },
  {
    type: 'provider_snapshot',
    requestId,
    ...binding,
    jobs: [job, finishedJob],
    nextCursor: handle.jobId,
  },
  { type: 'provider_snapshot', ...binding, jobs: [] },
  { type: 'provider_lease_ack', requestId, ...binding, leaseExpiresAt: '2026-08-28T00:00:15.000Z' },
  providerStatusResult,
  { type: 'provider_status_result', requestId, providerId: handle.providerId, jobs: [] },
];

describe.each([
  { name: 'SDK', contract: browser },
  { name: 'relay', contract: relay },
])('read-only provider status: $name', ({ contract }) => {
  it('keeps historical generations separate from execution snapshots', () => {
    expect(contract.browserProviderInboundMessageSchema.parse(providerStatusResult)).toEqual(
      providerStatusResult
    );
    for (const generation of [1, 2]) {
      expect(
        contract.browserProviderInboundMessageSchema.safeParse({
          ...providerStatusResult,
          type: 'provider_snapshot',
          generation,
        }).success
      ).toBe(false);
    }
  });

  it.each([
    { requestId: undefined },
    { requestId: 'invalid' },
    { providerId: undefined },
    { providerId: handle.jobId },
    { providerProof: undefined },
    { providerProof: 'd'.repeat(63) },
    { providerProof: 'D'.repeat(64) },
    { cursor: handle.providerId },
    { cursor: '' },
  ])('rejects malformed status requests: %j', fields => {
    expect(
      contract.browserProviderOutboundMessageSchema.safeParse({
        ...providerStatusRequest,
        ...fields,
      }).success
    ).toBe(false);
  });

  it.each([
    { requestId: undefined },
    { requestId: 'invalid' },
    { providerId: undefined },
    { providerId: handle.jobId },
    { jobs: undefined },
    { jobs: null },
    { jobs: [{ ...job, generation: undefined }] },
    { jobs: [{ ...job, generation: 0 }] },
    { jobs: [{ ...finishedJob, result: undefined }] },
    { jobs: [{ ...finishedJob, result: { ...completed, jobId: interruptedHandle.jobId } }] },
    { nextCursor: handle.providerId },
    { nextCursor: '' },
  ])('rejects malformed provider history: %j', fields => {
    expect(
      contract.browserProviderInboundMessageSchema.safeParse({ ...providerStatusResult, ...fields })
        .success
    ).toBe(false);
  });

  it.each([
    { generation: 1 },
    { enabled: true },
    { leaseExpiresAt: '2026-08-28T00:00:15.000Z' },
    { approval: { decision: 'approved', tab } },
    {
      recovery: {
        invocationId: handle.invocationId,
        tabId: tab.tabId,
        tabClosed: true,
        locksDrained: true,
      },
    },
  ])('rejects authority fields on status frames: %j', fields => {
    expect(
      contract.browserProviderOutboundMessageSchema.safeParse({
        ...providerStatusRequest,
        ...fields,
      }).success
    ).toBe(false);
    expect(
      contract.browserProviderInboundMessageSchema.safeParse({ ...providerStatusResult, ...fields })
        .success
    ).toBe(false);
  });

  it('rejects otherwise valid history from another provider', () => {
    const providerId = 'bp_00000000-0000-4000-8000-000000000006';
    const foreignJob = { ...finishedJob, providerId, result: { ...completed, providerId } };
    expect(contract.browserJobSnapshotSchema.parse(foreignJob)).toEqual(foreignJob);
    expect(
      contract.browserProviderInboundMessageSchema.safeParse({
        ...providerStatusResult,
        jobs: [...providerStatusResult.jobs, foreignJob],
      }).success
    ).toBe(false);
  });

  it('redacts status proofs and attacker-controlled keys from parse errors', () => {
    const secret = 'private-status-proof-must-not-appear';
    const cases = [
      {
        schema: contract.browserProviderOutboundMessageSchema,
        frame: { ...providerStatusRequest, providerProof: secret },
      },
      {
        schema: contract.webOutboundWithBrowserMessageSchema,
        frame: { ...providerStatusRequest, [secret]: true },
      },
      {
        schema: contract.browserProviderInboundMessageSchema,
        frame: { ...providerStatusResult, [secret]: true },
      },
      {
        schema: contract.webInboundWithBrowserMessageSchema,
        frame: { ...providerStatusResult, providerProof: secret },
      },
    ];
    for (const { schema, frame } of cases) {
      const parsed = schema.safeParse(frame);
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error('Invalid status frame was accepted');
      expect(parsed.error.message).not.toContain(secret);
      expect(JSON.stringify(parsed.error)).not.toContain(secret);
    }
  });

  it('accepts 25 historical jobs but rejects a 26th job', () => {
    const page = { ...providerStatusResult, jobs: Array.from({ length: 25 }, () => job) };
    expect(contract.browserProviderInboundMessageSchema.parse(page)).toEqual(page);
    expect(
      contract.browserProviderInboundMessageSchema.safeParse({ ...page, jobs: [...page.jobs, job] })
        .success
    ).toBe(false);
  });

  it('bounds historical pages by serialized UTF-8 bytes', () => {
    const largeJob = {
      ...finishedJob,
      result: { ...completed, summary: '\u00e9'.repeat(16384) },
    };
    const page = { ...providerStatusResult, jobs: Array.from({ length: 3 }, () => largeJob) };
    expect(contract.browserProviderInboundMessageSchema.parse(page)).toEqual(page);
    expect(
      contract.browserProviderInboundMessageSchema.safeParse({
        ...page,
        jobs: [...page.jobs, largeJob],
      }).success
    ).toBe(false);
  });
});

describe('browser jobs v1 Cloud parity', () => {
  const boundaries = [
    { schema: 'browserRequestSchema', frames: cliRequests },
    { schema: 'browserResponseSchema', frames: cliResponses },
    { schema: 'browserEventSchema', frames: cliEvents },
    { schema: 'browserProviderOutboundMessageSchema', frames: providerOutbound },
    { schema: 'browserProviderInboundMessageSchema', frames: providerInbound },
  ] as const;

  it.each(boundaries)(
    'matches the relay at $schema without widening legacy parsing',
    ({ schema, frames }) => {
      for (const frame of frames) {
        const input = JSON.parse(JSON.stringify(frame));
        expect(browser[schema].parse(input)).toEqual(frame);
        expect(browser[schema].parse(input)).toEqual(relay[schema].parse(input));
        expect(browser[schema].safeParse({ ...frame, extra: true }).success).toBe(false);
        expect(browser.webInboundMessageSchema.safeParse(input).success).toBe(false);
        expect(browser.webOutboundMessageSchema.safeParse(input).success).toBe(false);
      }
    }
  );

  it('keeps provider frames opt-in and rejects reversed directions', () => {
    for (const frame of providerOutbound) {
      expect(browser.webOutboundWithBrowserMessageSchema.parse(frame)).toEqual(frame);
      expect(browser.webInboundWithBrowserMessageSchema.safeParse(frame).success).toBe(false);
    }
    for (const frame of providerInbound) {
      expect(browser.webInboundWithBrowserMessageSchema.parse(frame)).toEqual(frame);
      expect(browser.webOutboundWithBrowserMessageSchema.safeParse(frame).success).toBe(false);
    }
    for (const frame of [...cliRequests, ...cliResponses, ...cliEvents]) {
      expect(browser.webInboundWithBrowserMessageSchema.safeParse(frame).success).toBe(false);
      expect(browser.webOutboundWithBrowserMessageSchema.safeParse(frame).success).toBe(false);
    }
  });

  it.each([
    { capabilities: undefined, supported: false },
    { capabilities: {}, supported: false },
    { capabilities: { browserJobsV1: false }, supported: false },
    { capabilities: { browserJobsV1: true }, supported: true },
  ])(
    'normalizes web negotiation while preserving old frames: %j',
    ({ capabilities, supported }) => {
      for (const { schema, frame } of [
        {
          schema: browser.webOutboundMessageSchema,
          frame: { type: 'ping', nonce: 'legacy-nonce' },
        },
        { schema: browser.webInboundMessageSchema, frame: { type: 'pong', nonce: 'legacy-nonce' } },
      ]) {
        const input = { ...frame, ...(capabilities === undefined ? {} : { capabilities }) };
        const parsed = schema.parse(input);
        expect(parsed).toEqual(input);
        const advertised = 'capabilities' in parsed ? parsed.capabilities : undefined;
        expect(browser.normalizedBrowserCapabilitiesSchema.parse(advertised)).toEqual({
          browserJobsV1: supported,
        });
        expect(schema.safeParse({ ...frame, capabilities: { browserJobsV1: 1 } }).success).toBe(
          false
        );
      }
    }
  );

  // This callback accepts only the four legacy variants, independent of new traffic.
  type LegacyInbound =
    | { type: 'event'; sessionId: string; event: string; data?: unknown }
    | { type: 'system'; event: string; data?: unknown }
    | { type: 'response'; id: string; result?: unknown; error?: unknown }
    | { type: 'pong'; nonce: string };
  const legacyCallback: (message: browser.WebInboundMessage) => unknown = (
    message: LegacyInbound
  ) => {
    switch (message.type) {
      case 'event':
        return `${message.sessionId}:${message.event}`;
      case 'system':
        return message.event;
      case 'response':
        return message.error ?? message.result;
      case 'pong':
        return message.nonce;
    }
  };

  it('preserves legacy callback types, command results, and error shapes', () => {
    const examples = [
      {
        frame: { type: 'event', sessionId: 'legacy-session', event: 'message.updated', data: {} },
        value: 'legacy-session:message.updated',
      },
      { frame: { type: 'system', event: 'cli.connected', data: {} }, value: 'cli.connected' },
      {
        frame: { type: 'response', id: 'legacy-request', result: { ok: true } },
        value: { ok: true },
      },
      { frame: { type: 'response', id: 'legacy-request', error: 'not found' }, value: 'not found' },
      {
        frame: {
          type: 'response',
          id: 'legacy-request',
          error: { source: 'relay', code: 'OWNER_CHANGED', message: 'Owner changed' },
        },
        value: { source: 'relay', code: 'OWNER_CHANGED', message: 'Owner changed' },
      },
      { frame: { type: 'pong', nonce: 'legacy-nonce' }, value: 'legacy-nonce' },
    ];
    for (const { frame, value } of examples) {
      expect(legacyCallback(browser.webInboundMessageSchema.parse(frame))).toEqual(value);
      expect(browser.webInboundWithBrowserMessageSchema.parse(frame)).toEqual(frame);
      expect(browser.webInboundMessageSchema.parse(frame)).toEqual(
        relay.WebInboundMessageSchema.parse(frame)
      );
    }
    const outbound = [
      { type: 'subscribe', sessionId: 'legacy-session' },
      { type: 'unsubscribe', sessionId: 'legacy-session' },
      { type: 'command', id: 'legacy-request', command: 'list_sessions', data: null },
      {
        type: 'command',
        id: 'legacy-request',
        command: 'send_message',
        sessionId: 'legacy-session',
        connectionId: 'legacy-connection',
        mutationId: 'legacy-intent',
        data: {},
      },
      { type: 'ping', nonce: 'legacy-nonce' },
    ];
    for (const frame of outbound) {
      expect(browser.webOutboundWithBrowserMessageSchema.parse(frame)).toEqual(frame);
      expect(browser.webOutboundMessageSchema.parse(frame)).toEqual(
        relay.WebOutboundMessageSchema.parse(frame)
      );
    }
    expect(
      browser.webInboundMessageSchema.parse({ type: 'pong', nonce: 'legacy-nonce', extra: true })
    ).toEqual({ type: 'pong', nonce: 'legacy-nonce' });
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
