import { describe, it, expect } from 'vitest';
import {
  CLIOutboundMessageSchema,
  CLIInboundMessageSchema,
  WebOutboundMessageSchema,
  WebInboundMessageSchema,
  SessionEventPayloadSchema,
} from './user-connection-protocol';
import * as browser from './user-connection-protocol';
import * as sdk from '../../../../packages/cloud-agent-sdk/src/schemas';

// Canonical v1 examples also appear in the SDK schema tests.
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
const unresolvedFence = { invocationId: interruptedHandle.invocationId, tabId: tab.tabId };
const expiredInvocationId = `b1.1.${'f'.repeat(64)}`;
const emptyProviderStatusResult = {
  type: 'provider_status_result',
  requestId,
  providerId: handle.providerId,
  jobs: [],
} as const;
const recovery = {
  invocationId: handle.invocationId,
  tabClosed: true,
  locksDrained: true,
} as const;
const providerOutbound = [
  providerStatusRequest,
  { ...providerStatusRequest, cursor: handle.jobId },
  registration,
  { ...registration, generation: 1, recovery },
  { ...registration, generation: 1, recovery: { ...recovery, tabId: tab.tabId } },
  { type: 'provider_heartbeat', requestId, ...binding, cursor: handle.jobId },
  { type: 'provider_approval', ...jobBinding, approval: { decision: 'approved', tab } },
  {
    type: 'provider_approval',
    ...jobBinding,
    approval: { decision: 'denied', reason: 'approval_denied' },
  },
  { type: 'provider_result', ...jobBinding, tab, result: completed },
  { type: 'provider_quiesced', ...jobBinding },
  { type: 'provider_quiesced', ...jobBinding, tabId: tab.tabId },
  { type: 'provider_unavailable', ...binding, reason: 'provider_lost', effectsUncertain: true },
  { type: 'provider_cancel', ...jobBinding },
];
const providerInbound = [
  { type: 'provider_job', job, goal: invoke.goal, ownerLabel: 'Parent chat' },
  ...(['new', 'continue'] as const).map(
    conversationMode =>
      ({
        type: 'provider_job',
        job,
        goal: invoke.goal,
        ownerLabel: 'Parent chat',
        conversationMode,
      }) satisfies browser.BrowserProviderInboundMessage
  ),
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
  emptyProviderStatusResult,
  { ...providerStatusResult, unresolvedFence },
  { ...emptyProviderStatusResult, unresolvedFence: { invocationId: expiredInvocationId } },
];

describe.each([
  { name: 'provider', schema: browser.browserProviderInboundMessageSchema },
  { name: 'negotiated web', schema: browser.webInboundWithBrowserMessageSchema },
])('provider conversation intent: $name', ({ schema }) => {
  it('keeps legacy jobs parseable without inventing conversation intent', () => {
    const parsed = schema.parse(providerInbound[0]);
    expect(parsed).toStrictEqual(providerInbound[0]);
    expect(parsed).not.toHaveProperty('conversationMode');
  });

  it.each(['new', 'continue'] as const)(
    'preserves explicit %s intent and rejects unknown fields',
    conversationMode => {
      const frame = { ...providerInbound[0], conversationMode };
      expect(schema.parse(frame)).toStrictEqual(frame);
      expect(schema.safeParse({ ...frame, extra: true }).success).toBe(false);
      expect(schema.safeParse({ ...frame, job: { ...job, conversationMode } }).success).toBe(false);
    }
  );

  it.each([
    { conversationMode: '' },
    { conversationMode: 'unknown' },
    { conversationMode: 'NEW' },
    { conversationMode: 'CONTINUE' },
    { conversationMode: 'new ' },
    { conversationMode: null },
    { conversationMode: false },
    { conversationMode: 0 },
    { conversationMode: [] },
    { conversationMode: {} },
  ])('rejects invalid conversation modes: %j', fields => {
    expect(schema.safeParse({ ...providerInbound[0], ...fields }).success).toBe(false);
  });
});

describe.each([
  { name: 'relay', contract: browser },
  { name: 'SDK', contract: sdk },
])('provider quiescence: $name', ({ contract }) => {
  const quiesced = { type: 'provider_quiesced', ...jobBinding };

  it.each([{}, { tabId: tab.tabId }, { tabId: 0 }, { tabId: Number.MAX_SAFE_INTEGER }])(
    'preserves the exact binding and supplied or omitted tab: %j',
    tabFields => {
      const frame = { ...quiesced, ...tabFields };
      expect(contract.browserProviderOutboundMessageSchema.parse(frame)).toStrictEqual(frame);
      expect(contract.webOutboundWithBrowserMessageSchema.parse(frame)).toStrictEqual(frame);
    }
  );

  it.each([
    { tabId: null },
    { tabId: -1 },
    { tabId: 1.5 },
    { tabId: Number.MAX_SAFE_INTEGER + 1 },
    { tabId: '7' },
    { tabId: true },
    { tabId: [] },
    { tabId: {} },
  ])('rejects invalid supplied quiescence tabs: %j', fields => {
    const frame = { ...quiesced, ...fields };
    expect(contract.browserProviderOutboundMessageSchema.safeParse(frame).success).toBe(false);
    expect(contract.webOutboundWithBrowserMessageSchema.safeParse(frame).success).toBe(false);
  });

  it.each([
    { providerId: undefined },
    { providerId: handle.jobId },
    { browserTaskId: undefined },
    { browserTaskId: handle.jobId },
    { jobId: undefined },
    { jobId: handle.providerId },
    { invocationId: undefined },
    { invocationId: handle.jobId },
    { generation: undefined },
    { generation: null },
    { generation: 0 },
    { generation: -1 },
    { generation: 1.5 },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { generation: '1' },
  ])('rejects invalid or missing quiescence bindings: %j', fields => {
    for (const tabFields of [{}, { tabId: tab.tabId }]) {
      const frame = JSON.parse(JSON.stringify({ ...quiesced, ...tabFields, ...fields }));
      expect(contract.browserProviderOutboundMessageSchema.safeParse(frame).success).toBe(false);
      expect(contract.webOutboundWithBrowserMessageSchema.safeParse(frame).success).toBe(false);
    }
  });

  it.each([
    { connectionId: 'foreign-socket' },
    { recovery },
    { tabClosed: true },
    { locksDrained: true },
  ])('rejects socket or recovery authority on quiescence: %j', fields => {
    for (const tabFields of [{}, { tabId: tab.tabId }]) {
      const frame = { ...quiesced, ...tabFields, ...fields };
      expect(contract.browserProviderOutboundMessageSchema.safeParse(frame).success).toBe(false);
      expect(contract.webOutboundWithBrowserMessageSchema.safeParse(frame).success).toBe(false);
    }
  });

  it.each([{ tab: undefined }, { tab: { ...tab, tabId: undefined } }])(
    'keeps approved tabs required outside quiescence: %j',
    ({ tab }) => {
      for (const frame of [
        {
          type: 'provider_approval',
          ...jobBinding,
          approval: { decision: 'approved', tab },
        },
        { type: 'provider_result', ...jobBinding, tab, result: completed },
      ]) {
        expect(contract.browserProviderOutboundMessageSchema.safeParse(frame).success).toBe(false);
        expect(contract.webOutboundWithBrowserMessageSchema.safeParse(frame).success).toBe(false);
      }
    }
  );
});

describe.each([
  { name: 'relay', contract: browser },
  { name: 'SDK', contract: sdk },
])('provider recovery registration: $name', ({ contract }) => {
  it.each([
    recovery,
    { ...recovery, tabId: tab.tabId },
    { ...recovery, tabId: 0 },
    { ...recovery, tabId: Number.MAX_SAFE_INTEGER },
    { ...recovery, invocationId: expiredInvocationId },
    { ...recovery, invocationId: expiredInvocationId, tabId: tab.tabId },
  ])('preserves recovery identity and tab omission: %j', recovery => {
    const frame = { ...registration, generation: 1, recovery };
    expect(contract.browserProviderOutboundMessageSchema.parse(frame)).toStrictEqual(frame);
    expect(contract.webOutboundWithBrowserMessageSchema.parse(frame)).toStrictEqual(frame);
  });

  it.each([
    { tabClosed: undefined },
    { tabClosed: false },
    { tabClosed: 'true' },
    { tabClosed: 1 },
    { locksDrained: undefined },
    { locksDrained: false },
    { locksDrained: 'true' },
    { locksDrained: 1 },
    { invocationId: undefined },
    { invocationId: null },
    { invocationId: 7 },
    { invocationId: '' },
    { invocationId: handle.jobId },
    { invocationId: `b1.0.${'a'.repeat(64)}` },
    { invocationId: `b1.01.${'a'.repeat(64)}` },
    { invocationId: `b1.8640000000000001.${'a'.repeat(64)}` },
    { invocationId: `b1.9007199254740992.${'a'.repeat(64)}` },
    { invocationId: `b1.1787875200000.${'A'.repeat(64)}` },
    { invocationId: `b1.1787875200000.${'a'.repeat(63)}` },
    { owner },
    { extra: true },
  ])('rejects unsafe or malformed recovery with and without a tab: %j', fields => {
    for (const tabFields of [{}, { tabId: tab.tabId }]) {
      const frame = {
        ...registration,
        generation: 1,
        recovery: { ...recovery, ...tabFields, ...fields },
      };
      expect(contract.browserProviderOutboundMessageSchema.safeParse(frame).success).toBe(false);
      expect(contract.webOutboundWithBrowserMessageSchema.safeParse(frame).success).toBe(false);
    }
  });

  it.each([
    { tabId: null },
    { tabId: -1 },
    { tabId: 1.5 },
    { tabId: Number.MAX_SAFE_INTEGER + 1 },
    { tabId: '7' },
    { tabId: true },
    { tabId: [] },
    { tabId: {} },
  ])('rejects invalid supplied recovery tabs: %j', fields => {
    const frame = { ...registration, generation: 1, recovery: { ...recovery, ...fields } };
    expect(contract.browserProviderOutboundMessageSchema.safeParse(frame).success).toBe(false);
    expect(contract.webOutboundWithBrowserMessageSchema.safeParse(frame).success).toBe(false);
  });
});

describe.each([
  { name: 'relay', contract: browser },
  { name: 'SDK', contract: sdk },
])('read-only provider status: $name', ({ contract }) => {
  it('keeps absent fences omitted from old status frames', () => {
    for (const frame of [providerStatusResult, emptyProviderStatusResult]) {
      expect(contract.browserProviderInboundMessageSchema.parse(frame)).toStrictEqual(frame);
      expect(contract.webInboundWithBrowserMessageSchema.parse(frame)).toStrictEqual(frame);
    }
  });

  it.each([
    { invocationId: handle.invocationId },
    unresolvedFence,
    { ...unresolvedFence, tabId: 0 },
    { ...unresolvedFence, tabId: Number.MAX_SAFE_INTEGER },
    { invocationId: expiredInvocationId },
    { ...unresolvedFence, invocationId: expiredInvocationId },
  ])('preserves a compact fence without retained jobs: %j', unresolvedFence => {
    const frame = { ...emptyProviderStatusResult, unresolvedFence };
    expect(contract.browserProviderInboundMessageSchema.parse(frame)).toStrictEqual(frame);
    expect(contract.webInboundWithBrowserMessageSchema.parse(frame)).toStrictEqual(frame);
  });

  it.each([
    { unresolvedFence: null },
    { unresolvedFence: false },
    { unresolvedFence: 0 },
    { unresolvedFence: 'fence' },
    { unresolvedFence: [] },
    { unresolvedFence: {} },
    { unresolvedFence: { tabId: tab.tabId } },
  ])('rejects malformed fence objects: %j', fields => {
    const frame = { ...providerStatusResult, ...fields };
    expect(contract.browserProviderInboundMessageSchema.safeParse(frame).success).toBe(false);
    expect(contract.webInboundWithBrowserMessageSchema.safeParse(frame).success).toBe(false);
  });

  it.each([
    { invocationId: undefined },
    { invocationId: null },
    { invocationId: 7 },
    { invocationId: '' },
    { invocationId: handle.jobId },
    { invocationId: `b1.0.${'a'.repeat(64)}` },
    { invocationId: `b1.01.${'a'.repeat(64)}` },
    { invocationId: `b1.8640000000000001.${'a'.repeat(64)}` },
    { invocationId: `b1.9007199254740992.${'a'.repeat(64)}` },
    { invocationId: `b1.1787875200000.${'A'.repeat(64)}` },
    { invocationId: `b1.1787875200000.${'a'.repeat(63)}` },
    { tabId: null },
    { tabId: -1 },
    { tabId: 1.5 },
    { tabId: Number.MAX_SAFE_INTEGER + 1 },
    { tabId: '7' },
    { tabId: true },
  ])('rejects invalid fence fields: %j', fields => {
    const frame = { ...providerStatusResult, unresolvedFence: { ...unresolvedFence, ...fields } };
    expect(contract.browserProviderInboundMessageSchema.safeParse(frame).success).toBe(false);
    expect(contract.webInboundWithBrowserMessageSchema.safeParse(frame).success).toBe(false);
  });

  it.each([
    { parentSessionId: owner.parentSessionId },
    { parentProof: owner.parentProof },
    { providerProof: registration.providerProof },
    { connectionId: 'private-route' },
    { generation: 1 },
    { goal: invoke.goal },
    { result: completed },
    { tabClosed: true },
    { locksDrained: true },
    { extra: true },
  ])('rejects private or unknown fence fields: %j', fields => {
    const frame = { ...providerStatusResult, unresolvedFence: { ...unresolvedFence, ...fields } };
    expect(contract.browserProviderInboundMessageSchema.safeParse(frame).success).toBe(false);
    expect(contract.webInboundWithBrowserMessageSchema.safeParse(frame).success).toBe(false);
  });

  it('keeps fence discovery out of execution frames and job snapshots', () => {
    for (const frame of providerInbound) {
      if (frame.type === 'provider_status_result') continue;
      expect(
        contract.browserProviderInboundMessageSchema.safeParse({ ...frame, unresolvedFence })
          .success
      ).toBe(false);
    }
    expect(contract.browserJobSnapshotSchema.safeParse({ ...job, unresolvedFence }).success).toBe(
      false
    );
  });

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

  it('accepts 25 historical jobs with a fence but rejects a 26th job', () => {
    const page = {
      ...providerStatusResult,
      unresolvedFence,
      jobs: Array.from({ length: 25 }, () => job),
    };
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

  it('counts compact fences in the existing frame byte limit', () => {
    const largeJob = {
      ...finishedJob,
      result: { ...completed, summary: '\u00e9'.repeat(16384) },
    };
    const lastJob = { ...finishedJob, result: { ...completed, summary: '' } };
    const page = {
      ...providerStatusResult,
      unresolvedFence,
      jobs: [largeJob, largeJob, largeJob, lastJob],
    };
    lastJob.result.summary = 'x'.repeat(
      128 * 1024 - 1 - Buffer.byteLength(JSON.stringify(page), 'utf8')
    );
    expect(contract.browserProviderInboundMessageSchema.parse(page)).toEqual(page);
    lastJob.result.summary += 'x';
    expect(contract.browserProviderInboundMessageSchema.safeParse(page).success).toBe(false);
    const unfencedPage = { ...providerStatusResult, jobs: page.jobs };
    expect(contract.browserProviderInboundMessageSchema.parse(unfencedPage)).toEqual(unfencedPage);
  });
});

const modelArguments = [
  { operation: 'list' },
  { operation: 'run', provider_id: handle.providerId, goal: invoke.goal },
  {
    operation: 'run',
    provider_id: handle.providerId,
    goal: invoke.goal,
    browser_task_id: handle.browserTaskId,
  },
  ...(['status', 'cancel'] as const).flatMap(operation => [
    { operation, browser_task_id: handle.browserTaskId },
    { operation, browser_task_id: handle.browserTaskId, job_id: handle.jobId },
  ]),
  { operation: 'recover' },
];

describe.each([
  { name: 'relay', contract: browser },
  { name: 'SDK', contract: sdk },
])('browser jobs v1: $name', ({ contract }) => {
  const directions = [
    { name: 'CLI requests', schema: contract.browserRequestSchema, frames: cliRequests },
    {
      name: 'CLI replies',
      schema: contract.browserCLIInboundMessageSchema,
      frames: [...cliResponses, ...cliEvents],
    },
    {
      name: 'provider outbound',
      schema: contract.browserProviderOutboundMessageSchema,
      frames: providerOutbound,
    },
    {
      name: 'provider inbound',
      schema: contract.browserProviderInboundMessageSchema,
      frames: providerInbound,
    },
  ];

  it.each(directions)(
    'round-trips canonical $name only in the correct direction',
    ({ schema, frames }) => {
      for (const frame of frames) {
        expect(schema.parse(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
        expect(schema.safeParse({ ...frame, extra: true }).success).toBe(false);
        for (const other of directions) {
          if (other.schema !== schema) expect(other.schema.safeParse(frame).success).toBe(false);
        }
        for (const legacy of [
          CLIOutboundMessageSchema,
          CLIInboundMessageSchema,
          WebOutboundMessageSchema,
          WebInboundMessageSchema,
          sdk.webInboundMessageSchema,
        ]) {
          expect(legacy.safeParse(frame).success).toBe(false);
        }
      }
    }
  );

  it.each(modelArguments)('accepts the model operation matrix: %j', args => {
    expect(contract.browserTaskArgumentsSchema.parse(args)).toEqual(args);
  });

  it.each([
    'owner',
    'parentSessionId',
    'parentProof',
    'providerProof',
    'userId',
    'connectionId',
    'invocationId',
    'sessionID',
    'messageID',
    'callID',
  ])('rejects model-selected authority: %s', field => {
    for (const args of modelArguments) {
      expect(
        contract.browserTaskArgumentsSchema.safeParse({ ...args, [field]: 'untrusted' }).success
      ).toBe(false);
    }
  });

  it('requires a conversation for status and cancel, even with an exact job ID', () => {
    for (const operation of ['status', 'cancel']) {
      expect(
        contract.browserTaskArgumentsSchema.safeParse({ operation, job_id: handle.jobId }).success
      ).toBe(false);
      expect(
        contract.browserRequestSchema.safeParse({
          type: 'browser_request',
          requestId,
          operation,
          owner,
          jobId: handle.jobId,
        }).success
      ).toBe(false);
      expect(
        contract.browserRequestSchema.safeParse({
          type: 'browser_request',
          requestId,
          operation,
          owner,
          browserTaskId: handle.jobId,
        }).success
      ).toBe(false);
    }
  });

  it('requires a run target and goal, and keeps recover lookup-only', () => {
    for (const args of [
      { operation: 'run', goal: invoke.goal },
      { operation: 'run', provider_id: handle.providerId },
      { operation: 'invoke', provider_id: handle.providerId, goal: invoke.goal },
      { operation: 'list', provider_id: handle.providerId },
    ])
      expect(contract.browserTaskArgumentsSchema.safeParse(args).success).toBe(false);
    const recover = {
      type: 'browser_request',
      requestId,
      operation: 'recover',
      owner,
      invocationId: handle.invocationId,
    };
    for (const extra of [
      { goal: invoke.goal },
      { providerId: handle.providerId },
      { jobId: handle.jobId },
      { browserTaskId: handle.browserTaskId },
    ]) {
      expect(contract.browserRequestSchema.safeParse({ ...recover, ...extra }).success).toBe(false);
    }
    for (const extra of [
      { goal: invoke.goal },
      { provider_id: handle.providerId },
      { browser_task_id: handle.browserTaskId },
      { job_id: handle.jobId },
    ]) {
      expect(
        contract.browserTaskArgumentsSchema.safeParse({ operation: 'recover', ...extra }).success
      ).toBe(false);
    }
    expect(contract.browserRequestSchema.safeParse({ ...recover, owner: undefined }).success).toBe(
      false
    );
    expect(
      contract.browserRequestSchema.safeParse({ ...recover, invocationId: undefined }).success
    ).toBe(false);
  });

  it('keeps proofs on owned requests, registration, and provider status', () => {
    for (const frame of [...cliResponses, ...cliEvents]) {
      for (const extra of [
        { owner },
        { parentProof: owner.parentProof },
        { providerProof: registration.providerProof },
      ]) {
        expect(
          contract.browserCLIInboundMessageSchema.safeParse({ ...frame, ...extra }).success
        ).toBe(false);
      }
    }
    for (const frame of providerInbound) {
      expect(
        contract.browserProviderInboundMessageSchema.safeParse({ ...frame, owner }).success
      ).toBe(false);
      expect(
        contract.browserProviderInboundMessageSchema.safeParse({
          ...frame,
          providerProof: registration.providerProof,
        }).success
      ).toBe(false);
    }
    for (const frame of providerOutbound) {
      expect(
        contract.browserProviderOutboundMessageSchema.safeParse({ ...frame, owner }).success
      ).toBe(false);
      if (frame.type !== 'provider_register' && frame.type !== 'provider_status') {
        expect(
          contract.browserProviderOutboundMessageSchema.safeParse({
            ...frame,
            providerProof: registration.providerProof,
          }).success
        ).toBe(false);
      }
    }
    expect(
      contract.browserRequestSchema.safeParse({
        ...invoke,
        providerProof: registration.providerProof,
      }).success
    ).toBe(false);
    expect(
      contract.browserRequestSchema.safeParse({
        type: 'browser_request',
        requestId,
        operation: 'list',
        owner,
      }).success
    ).toBe(false);
    expect(
      contract.browserRequestSchema.safeParse({
        ...invoke,
        owner: { parentSessionId: owner.parentSessionId },
      }).success
    ).toBe(false);
    expect(
      contract.browserProviderOutboundMessageSchema.safeParse({
        ...registration,
        providerProof: undefined,
      }).success
    ).toBe(false);
    expect(
      contract.browserResponseSchema.safeParse({
        type: 'browser_response',
        requestId,
        response: {
          kind: 'providers',
          providers: [{ ...provider, providerProof: registration.providerProof }],
        },
      }).success
    ).toBe(false);
    expect(
      contract.browserProviderInboundMessageSchema.safeParse({
        type: 'provider_job',
        job: { ...job, owner },
        goal: invoke.goal,
        ownerLabel: 'Parent chat',
      }).success
    ).toBe(false);
    expect(
      contract.browserEventSchema.safeParse({
        type: 'browser_event',
        requestId,
        event: 'result',
        result: { ...completed, parentProof: owner.parentProof },
      }).success
    ).toBe(false);
  });

  it('redacts invalid proof values and attacker-controlled key names from errors', () => {
    const secret = 'private-proof-must-not-appear';
    const cases = [
      {
        schema: contract.browserRequestSchema,
        frame: { ...invoke, owner: { ...owner, parentProof: secret, [secret]: true } },
      },
      {
        schema: contract.browserProviderOutboundMessageSchema,
        frame: { ...registration, providerProof: secret, [secret]: true },
      },
      {
        schema: contract.browserTaskArgumentsSchema,
        frame: { operation: 'recover', [secret]: true },
      },
      {
        schema: contract.webOutboundWithBrowserMessageSchema,
        frame: { ...registration, providerProof: secret, [secret]: true },
      },
      {
        schema: contract.webInboundWithBrowserMessageSchema,
        frame: { ...providerInbound[0], [secret]: true },
      },
    ];
    for (const { schema, frame } of cases) {
      const parsed = schema.safeParse(frame);
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error('Invalid proof-bearing input was accepted');
      expect(parsed.error.message).not.toContain(secret);
      expect(JSON.stringify(parsed.error)).not.toContain(secret);
    }
  });

  it.each([
    { requestId: 'request-1' },
    { requestId: '' },
    { providerId: handle.browserTaskId },
    { browserTaskId: handle.jobId },
    { providerId: 'bp_not-a-uuid' },
    { invocationId: `b1.0.${'a'.repeat(64)}` },
    { invocationId: `b1.01787875200000.${'a'.repeat(64)}` },
    { invocationId: `b1.8640000000000001.${'a'.repeat(64)}` },
    { invocationId: `b1.9007199254740992.${'a'.repeat(64)}` },
    { invocationId: `b1.1787875200000.${'A'.repeat(64)}` },
    { owner: { ...owner, parentSessionId: 'parent' } },
    { owner: { ...owner, connectionId: 'untrusted' } },
  ])('rejects malformed request identities: %j', fields => {
    expect(contract.browserRequestSchema.safeParse({ ...invoke, ...fields }).success).toBe(false);
  });

  it('requires correlation IDs and separates acknowledgements from progress and results', () => {
    for (const frame of cliRequests)
      expect(
        contract.browserRequestSchema.safeParse({ ...frame, requestId: undefined }).success
      ).toBe(false);
    for (const frame of [...cliResponses, ...cliEvents])
      expect(
        contract.browserCLIInboundMessageSchema.safeParse({ ...frame, requestId: undefined })
          .success
      ).toBe(false);
    expect(
      contract.browserResponseSchema.safeParse({
        type: 'browser_response',
        requestId,
        response: { kind: 'ack', operation: 'cancel', ...handle, result: completed },
      }).success
    ).toBe(false);
    expect(
      contract.browserEventSchema.safeParse({
        type: 'browser_event',
        requestId,
        event: 'progress',
        job: finishedJob,
      }).success
    ).toBe(false);
    expect(
      contract.browserEventSchema.safeParse({
        type: 'browser_event',
        requestId,
        event: 'result',
        result: { ...completed, status: 'running' },
      }).success
    ).toBe(false);
  });

  const statusResults = {
    queued: null,
    awaiting_approval: null,
    running: null,
    succeeded: completed,
    failed: { ...completed, status: 'failed', reason: 'runner_failed', effectsUncertain: false },
    cancelled: { ...completed, status: 'cancelled', reason: 'cancelled', effectsUncertain: false },
    interrupted: {
      ...completed,
      status: 'interrupted',
      reason: 'effects_uncertain',
      effectsUncertain: true,
    },
    timed_out: {
      ...completed,
      status: 'timed_out',
      reason: 'execution_timeout',
      effectsUncertain: true,
    },
  } satisfies Record<
    browser.BrowserJobSnapshot['status'],
    browser.BrowserResult | null
  > satisfies Record<sdk.BrowserJobSnapshot['status'], sdk.BrowserResult | null>;

  describe('queue metadata', () => {
    const queuedJob = { ...job, status: 'queued' } as const;

    it.each([
      {},
      { ownerLabel: owner.parentSessionId },
      { queuePosition: 1 },
      { queuePosition: 100 },
      { ownerLabel: owner.parentSessionId, queuePosition: 50 },
    ])('preserves optional fields without inventing missing metadata: %j', fields => {
      const snapshot = { ...queuedJob, ...fields };
      expect(contract.browserJobSnapshotSchema.parse(snapshot)).toStrictEqual(snapshot);
    });

    it.each([
      { queuePosition: 0 },
      { queuePosition: -1 },
      { queuePosition: 101 },
      { queuePosition: 1.5 },
      { queuePosition: '1' },
      { queuePosition: null },
      { queuePosition: true },
      { queuePosition: [] },
      { queuePosition: {} },
      { queuePosition: NaN },
      { queuePosition: Infinity },
    ])('rejects malformed queue positions: %j', fields => {
      expect(contract.browserJobSnapshotSchema.safeParse({ ...queuedJob, ...fields }).success).toBe(
        false
      );
    });

    it.each([
      { ownerLabel: 'x', accepted: true },
      { ownerLabel: 'x'.repeat(128), accepted: true },
      { ownerLabel: '\u00e9'.repeat(64), accepted: true },
      { ownerLabel: '', accepted: false },
      { ownerLabel: 'x'.repeat(129), accepted: false },
      { ownerLabel: '\u00e9'.repeat(65), accepted: false },
      { ownerLabel: null, accepted: false },
      { ownerLabel: 1, accepted: false },
      { ownerLabel: false, accepted: false },
      { ownerLabel: [], accepted: false },
      { ownerLabel: {}, accepted: false },
    ])('matches the existing dispatch owner-label bounds: %j', ({ ownerLabel, accepted }) => {
      expect(
        contract.browserJobSnapshotSchema.safeParse({ ...queuedJob, ownerLabel }).success
      ).toBe(accepted);
      expect(
        contract.browserProviderInboundMessageSchema.safeParse({
          type: 'provider_job',
          job,
          goal: invoke.goal,
          ownerLabel,
        }).success
      ).toBe(accepted);
    });

    it.each(Object.entries(statusResults).filter(([status]) => status !== 'queued'))(
      'preserves legacy %s snapshots and labels but rejects stale queue positions',
      (status, result) => {
        const snapshot = {
          ...job,
          status,
          ...(status === 'running' ? { approvedTab: tab } : {}),
          ...(result ? { result } : {}),
        };
        expect(contract.browserJobSnapshotSchema.parse(snapshot)).toStrictEqual(snapshot);
        const labeled = { ...snapshot, ownerLabel: owner.parentSessionId };
        expect(contract.browserJobSnapshotSchema.parse(labeled)).toStrictEqual(labeled);
        expect(
          contract.browserJobSnapshotSchema.safeParse({ ...labeled, queuePosition: 1 }).success
        ).toBe(false);
      }
    );

    it.each([
      { owner },
      { parentSessionId: owner.parentSessionId },
      { parentProof: owner.parentProof },
      { providerProof: registration.providerProof },
      { connectionId: 'private-route' },
      { capabilities: { browserJobsV1: true } },
      { goal: invoke.goal },
      { recovery },
      { leaseExpiresAt: '2026-08-28T00:00:15.000Z' },
    ])('keeps private data and authority out of labeled snapshots: %j', fields => {
      expect(
        contract.browserJobSnapshotSchema.safeParse({
          ...queuedJob,
          ownerLabel: owner.parentSessionId,
          queuePosition: 1,
          ...fields,
        }).success
      ).toBe(false);
    });

    it.each([{ ownerLabel: owner.parentSessionId }, { queuePosition: 1 }])(
      'keeps projection metadata out of requests and immutable results: %j',
      fields => {
        for (const args of modelArguments) {
          expect(
            contract.browserTaskArgumentsSchema.safeParse({ ...args, ...fields }).success
          ).toBe(false);
        }
        for (const frame of cliRequests) {
          expect(contract.browserRequestSchema.safeParse({ ...frame, ...fields }).success).toBe(
            false
          );
        }
        for (const frame of providerOutbound) {
          expect(
            contract.browserProviderOutboundMessageSchema.safeParse({ ...frame, ...fields }).success
          ).toBe(false);
        }
        expect(contract.browserResultSchema.safeParse({ ...completed, ...fields }).success).toBe(
          false
        );
      }
    );
  });

  it.each(Object.entries(statusResults))(
    'enforces the observable result contract for %s',
    (status, result) => {
      const snapshot = {
        ...job,
        status,
        ...(status === 'running' ? { approvedTab: tab } : {}),
        ...(result ? { result } : {}),
      };
      expect(contract.browserJobSnapshotSchema.parse(snapshot)).toEqual(snapshot);
      if (result) {
        expect(
          contract.browserEventSchema.parse({
            type: 'browser_event',
            requestId,
            event: 'result',
            result,
          })
        ).toEqual({ type: 'browser_event', requestId, event: 'result', result });
        expect(
          contract.browserJobSnapshotSchema.safeParse({ ...snapshot, result: undefined }).success
        ).toBe(false);
      } else {
        expect(
          contract.browserEventSchema.parse({
            type: 'browser_event',
            requestId,
            event: 'progress',
            job: snapshot,
          })
        ).toEqual({ type: 'browser_event', requestId, event: 'progress', job: snapshot });
        expect(
          contract.browserJobSnapshotSchema.safeParse({ ...snapshot, result: completed }).success
        ).toBe(false);
      }
    }
  );

  it('rejects unknown states, false success, empty evidence, and mismatched job results', () => {
    expect(contract.browserJobSnapshotSchema.safeParse({ ...job, status: 'idle' }).success).toBe(
      false
    );
    expect(
      contract.browserResultSchema.safeParse({ ...completed, effectsUncertain: true }).success
    ).toBe(false);
    expect(
      contract.browserResultSchema.safeParse({ ...completed, reason: 'runner_failed' }).success
    ).toBe(false);
    expect(contract.browserResultSchema.safeParse({ ...completed, status: 'failed' }).success).toBe(
      false
    );
    expect(contract.browserResultSchema.safeParse({ ...completed, evidence: [{}] }).success).toBe(
      false
    );
    expect(
      contract.browserResultSchema.safeParse({
        ...completed,
        evidence: [{ text: 'Observed', screenshot: 'data:image/png;base64,AAAA' }],
      }).success
    ).toBe(false);
    for (const field of ['providerId', 'browserTaskId', 'jobId', 'invocationId'] as const) {
      const result = { ...completed, [field]: handle[field].replace(/.$/, '5') };
      expect(contract.browserJobSnapshotSchema.safeParse({ ...finishedJob, result }).success).toBe(
        false
      );
      expect(
        contract.browserProviderOutboundMessageSchema.safeParse({
          type: 'provider_result',
          ...jobBinding,
          tab,
          result,
        }).success
      ).toBe(false);
    }
    expect(
      contract.browserJobSnapshotSchema.safeParse({ ...finishedJob, status: 'failed' }).success
    ).toBe(false);
  });

  it.each([
    'approval_denied',
    'permission_denied',
    'invocation_expired',
    'invocation_conflict',
    'conversation_busy',
    'capacity_exceeded',
    'tab_lost',
    'provider_lost',
    'provider_unavailable',
    'queue_timeout',
    'approval_timeout',
    'execution_timeout',
    'lease_expired',
    'effects_uncertain',
    'cancelled',
    'runner_failed',
    'unsupported',
    'invalid_request',
    'owner_mismatch',
    'not_found',
  ])('retains finite error reason %s', code => {
    const frame = {
      type: 'browser_response',
      requestId,
      response: { kind: 'error', code, message: 'Browser request rejected', retryable: false },
    };
    expect(contract.browserResponseSchema.parse(frame)).toEqual(frame);
    expect(
      contract.browserResponseSchema.safeParse({
        ...frame,
        response: { ...frame.response, code: `${code}_unknown` },
      }).success
    ).toBe(false);
  });

  it('binds approval and cancellation to an invocation and generation, not parent authority', () => {
    const approval = {
      type: 'provider_approval',
      ...jobBinding,
      approval: { decision: 'approved', tab },
    };
    const cancel = { type: 'provider_cancel', ...jobBinding };
    for (const frame of [approval, cancel]) {
      for (const field of Object.keys(jobBinding))
        expect(
          contract.browserProviderOutboundMessageSchema.safeParse({ ...frame, [field]: undefined })
            .success
        ).toBe(false);
      expect(
        contract.browserProviderOutboundMessageSchema.safeParse({ ...frame, generation: 0 }).success
      ).toBe(false);
      expect(
        contract.browserProviderOutboundMessageSchema.safeParse({ ...frame, owner }).success
      ).toBe(false);
    }
    for (const fields of [
      { tabId: -1 },
      { tabId: 1.5 },
      { title: undefined },
      { url: 'not-a-url' },
      { effectiveMode: 'automatic' },
      { extra: true },
    ]) {
      expect(
        contract.browserProviderOutboundMessageSchema.safeParse({
          ...approval,
          approval: { decision: 'approved', tab: { ...tab, ...fields } },
        }).success
      ).toBe(false);
    }
    expect(contract.browserJobSnapshotSchema.safeParse({ ...job, status: 'running' }).success).toBe(
      false
    );
    for (const status of ['queued', 'awaiting_approval'])
      expect(
        contract.browserJobSnapshotSchema.safeParse({ ...job, status, approvedTab: tab }).success
      ).toBe(false);
    expect(
      contract.browserProviderInboundMessageSchema.safeParse({
        type: 'provider_job',
        job: { ...job, status: 'running', approvedTab: tab },
        goal: invoke.goal,
        ownerLabel: 'Parent chat',
      }).success
    ).toBe(false);
    for (const fields of [
      { generation: 2 },
      { providerId: handle.providerId.replace(/.$/, '5') },
    ]) {
      expect(
        contract.browserProviderInboundMessageSchema.safeParse({
          type: 'provider_snapshot',
          ...binding,
          jobs: [{ ...job, ...fields }],
        }).success
      ).toBe(false);
    }
  });

  it('rejects invalid provider registration generations', () => {
    for (const generation of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        contract.browserProviderOutboundMessageSchema.safeParse({ ...registration, generation })
          .success
      ).toBe(false);
    }
  });

  it.each([
    { createdAt: '2026-08-28' },
    { createdAt: '2026-08-28T00:00:00Z' },
    { createdAt: '2026-02-30T00:00:00.000Z' },
    { createdAt: '2026-08-28T00:00:00.000+01:00' },
    { expiresAt: '2026-08-27T00:00:00.000Z' },
    { payloadFingerprint: 'not-a-digest' },
    { deadlines: { queue: '2026-08-27T00:00:00.000Z' } },
    { deadlines: { queue: '2026-09-04T00:00:00.001Z' } },
    { deadlines: { ...job.deadlines, execution: '2026-09-04T00:00:00.001Z' } },
    { deadlines: { ...job.deadlines, lease: 'invalid' } },
    { deadlines: { ...job.deadlines, extra: true } },
  ])('rejects malformed metadata and out-of-retention deadlines: %j', fields => {
    expect(contract.browserJobSnapshotSchema.safeParse({ ...job, ...fields }).success).toBe(false);
  });

  it('applies UTF-8 byte limits instead of JavaScript string lengths', () => {
    const goal = '\u00e9'.repeat(8192);
    expect(contract.browserRequestSchema.parse({ ...invoke, goal })).toMatchObject({ goal });
    expect(
      contract.browserTaskArgumentsSchema.parse({
        operation: 'run',
        provider_id: handle.providerId,
        goal,
      })
    ).toMatchObject({ goal });
    expect(contract.browserRequestSchema.safeParse({ ...invoke, goal: `${goal}a` }).success).toBe(
      false
    );
    expect(
      contract.browserTaskArgumentsSchema.safeParse({
        operation: 'run',
        provider_id: handle.providerId,
        goal: `${goal}a`,
      }).success
    ).toBe(false);
    expect(contract.browserRequestSchema.safeParse({ ...invoke, goal: '' }).success).toBe(false);
    expect(
      contract.browserProviderOutboundMessageSchema.safeParse({
        ...registration,
        label: '\u00e9'.repeat(65),
      }).success
    ).toBe(false);
    expect(
      contract.browserResultSchema.safeParse({ ...completed, summary: '\u00e9'.repeat(16385) })
        .success
    ).toBe(false);
    expect(
      contract.browserResultSchema.safeParse({
        ...completed,
        evidence: [{ text: '\u00e9'.repeat(4097) }],
      }).success
    ).toBe(false);
    expect(
      contract.browserResultSchema.safeParse({
        ...completed,
        evidence: [{ title: '\u00e9'.repeat(513) }],
      }).success
    ).toBe(false);
    expect(
      contract.browserResultSchema.safeParse({
        ...completed,
        evidence: [{ url: `https://example.com/${'\u00e9'.repeat(4096)}` }],
      }).success
    ).toBe(false);
    expect(
      contract.browserResponseSchema.safeParse({
        type: 'browser_response',
        requestId,
        response: {
          kind: 'error',
          code: 'invalid_request',
          message: '\u00e9'.repeat(513),
          retryable: false,
        },
      }).success
    ).toBe(false);
  });

  it('bounds serialized results at 64 KiB and complete frames below 128 KiB', () => {
    const evidence = [
      { text: 'x'.repeat(8192) },
      { text: 'x'.repeat(8192) },
      { text: 'x'.repeat(8192) },
      { text: '' },
    ];
    const result = { ...completed, summary: 'x'.repeat(32768), evidence };
    evidence[3].text = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(result), 'utf8'));
    expect(contract.browserResultSchema.parse(result)).toEqual(result);
    expect(
      contract.browserResultSchema.safeParse({
        ...result,
        summary: `${result.summary.slice(1)}\u00e9`,
      }).success
    ).toBe(false);
    const snapshot = { ...finishedJob, result };
    expect(
      contract.browserProviderInboundMessageSchema.parse({
        type: 'provider_snapshot',
        ...binding,
        jobs: [snapshot],
      })
    ).toMatchObject({ jobs: [snapshot] });
    expect(
      contract.browserProviderInboundMessageSchema.safeParse({
        type: 'provider_snapshot',
        ...binding,
        jobs: [snapshot, snapshot],
      }).success
    ).toBe(false);
    expect(
      contract.browserResultSchema.safeParse({
        ...completed,
        evidence: Array.from({ length: 33 }, () => ({ text: 'Observed' })),
      }).success
    ).toBe(false);
  });

  it('bounds discovery pages, snapshot pages, and queue depth', () => {
    const response = {
      type: 'browser_response',
      requestId,
      response: { kind: 'providers', providers: Array.from({ length: 25 }, () => provider) },
    };
    expect(contract.browserResponseSchema.parse(response)).toEqual(response);
    expect(
      contract.browserResponseSchema.safeParse({
        ...response,
        response: { ...response.response, providers: [...response.response.providers, provider] },
      }).success
    ).toBe(false);
    expect(
      contract.browserResponseSchema.safeParse({
        ...response,
        response: { ...response.response, providers: [{ ...provider, queueDepth: 101 }] },
      }).success
    ).toBe(false);
    expect(
      contract.browserProviderInboundMessageSchema.safeParse({
        type: 'provider_snapshot',
        ...binding,
        jobs: Array.from({ length: 26 }, () => job),
      }).success
    ).toBe(false);
  });
});

describe('browser opt-in compatibility', () => {
  it('adds new frames only through explicitly selected composite parsers', () => {
    for (const frame of cliRequests)
      expect(browser.cliOutboundWithBrowserMessageSchema.parse(frame)).toEqual(frame);
    for (const frame of [...cliResponses, ...cliEvents])
      expect(browser.cliInboundWithBrowserMessageSchema.parse(frame)).toEqual(frame);
    for (const frame of providerOutbound)
      expect(browser.webOutboundWithBrowserMessageSchema.parse(frame)).toEqual(frame);
    for (const frame of providerInbound)
      expect(browser.webInboundWithBrowserMessageSchema.parse(frame)).toEqual(frame);
    expect(browser.cliOutboundWithBrowserMessageSchema.safeParse(registration).success).toBe(false);
    expect(browser.webOutboundWithBrowserMessageSchema.safeParse(invoke).success).toBe(false);
    expect(browser.webInboundWithBrowserMessageSchema.safeParse(cliEvents[0]).success).toBe(false);
    expect(browser.cliInboundWithBrowserMessageSchema.safeParse(providerInbound[0]).success).toBe(
      false
    );
  });

  it.each([
    { capabilities: undefined, supported: false },
    { capabilities: {}, supported: false },
    { capabilities: { browserJobsV1: false }, supported: false },
    { capabilities: { browserJobsV1: true }, supported: true },
  ])(
    'normalizes negotiation without changing legacy envelopes: %j',
    ({ capabilities, supported }) => {
      const cases = [
        { schema: CLIOutboundMessageSchema, frame: { type: 'heartbeat', sessions: [] } },
        { schema: CLIInboundMessageSchema, frame: { type: 'heartbeat_ack' } },
        { schema: WebOutboundMessageSchema, frame: { type: 'ping', nonce: 'legacy-nonce' } },
        { schema: WebInboundMessageSchema, frame: { type: 'pong', nonce: 'legacy-nonce' } },
      ];
      for (const { schema, frame } of cases) {
        const input = { ...frame, ...(capabilities === undefined ? {} : { capabilities }) };
        const parsed = schema.parse(input);
        expect(parsed).toEqual(input);
        const advertised = 'capabilities' in parsed ? parsed.capabilities : undefined;
        expect(browser.normalizedBrowserCapabilitiesSchema.parse(advertised)).toEqual({
          browserJobsV1: supported,
        });
        expect(sdk.normalizedBrowserCapabilitiesSchema.parse(advertised)).toEqual({
          browserJobsV1: supported,
        });
        expect(schema.safeParse({ ...frame, capabilities: { browserJobsV1: 'yes' } }).success).toBe(
          false
        );
      }
    }
  );

  // Frozen pre-browser callbacks must remain assignable to the parser output.
  type LegacyCliInbound =
    | { type: 'subscribe' | 'unsubscribe'; sessionId: string }
    | { type: 'command'; id: string; command: string }
    | { type: 'system'; event: string; data?: unknown }
    | { type: 'heartbeat_ack' };
  type LegacyWebInbound =
    | { type: 'event'; sessionId: string; event: string; data?: unknown }
    | { type: 'system'; event: string; data?: unknown }
    | { type: 'response'; id: string; result?: unknown; error?: unknown }
    | { type: 'pong'; nonce: string };
  const cliCallback: (message: browser.CLIInboundMessage) => string = (
    message: LegacyCliInbound
  ) => {
    switch (message.type) {
      case 'subscribe':
      case 'unsubscribe':
        return `${message.type}:${message.sessionId}`;
      case 'command':
        return `${message.command}:${message.id}`;
      case 'system':
        return message.event;
      case 'heartbeat_ack':
        return 'alive';
    }
  };
  const webCallback: (message: browser.WebInboundMessage) => unknown = (
    message: LegacyWebInbound
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

  it('preserves legacy callback types and delivered values', () => {
    const cliExamples = [
      {
        frame: { type: 'subscribe', sessionId: 'legacy-session' },
        value: 'subscribe:legacy-session',
      },
      {
        frame: { type: 'unsubscribe', sessionId: 'legacy-session' },
        value: 'unsubscribe:legacy-session',
      },
      {
        frame: { type: 'command', id: 'legacy-request', command: 'list_sessions', data: null },
        value: 'list_sessions:legacy-request',
      },
      { frame: { type: 'system', event: 'web.connected', data: {} }, value: 'web.connected' },
      { frame: { type: 'heartbeat_ack' }, value: 'alive' },
    ];
    const webExamples = [
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
      { frame: { type: 'pong', nonce: 'legacy-nonce' }, value: 'legacy-nonce' },
    ];
    for (const { frame, value } of cliExamples) {
      expect(cliCallback(CLIInboundMessageSchema.parse(frame))).toEqual(value);
      expect(browser.cliInboundWithBrowserMessageSchema.parse(frame)).toEqual(frame);
    }
    for (const { frame, value } of webExamples) {
      expect(webCallback(WebInboundMessageSchema.parse(frame))).toEqual(value);
      expect(browser.webInboundWithBrowserMessageSchema.parse(frame)).toEqual(frame);
    }
    for (const frame of [
      { type: 'heartbeat', sessions: [] },
      { type: 'event', sessionId: 'legacy-session', event: 'message.updated', data: {} },
      { type: 'response', id: 'legacy-request', error: { arbitrary: ['legacy'] } },
    ]) {
      expect(browser.cliOutboundWithBrowserMessageSchema.parse(frame)).toEqual(frame);
    }
    expect(
      WebOutboundMessageSchema.parse({
        type: 'subscribe',
        sessionId: 'legacy-session',
        extra: true,
      })
    ).toEqual({ type: 'subscribe', sessionId: 'legacy-session' });
  });
});

const validSessionId = 'ses_12345678901234567890123456';

describe('CLIOutboundMessageSchema', () => {
  it('parses valid heartbeat', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [{ id: validSessionId, status: 'busy', title: 'Fix bug' }],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses heartbeat with empty sessions', () => {
    const msg = { type: 'heartbeat', sessions: [] };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses heartbeat with instance and per-session platform (kilo remote CLI)', () => {
    const msg = {
      type: 'heartbeat',
      instance: { name: 'laptop-1', projectName: 'kilo', version: '0.1.2' },
      sessions: [
        {
          id: 'ses_1',
          status: 'busy',
          title: 'Remote session',
          platform: 'darwin',
        },
      ],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.instance).toEqual({
        name: 'laptop-1',
        projectName: 'kilo',
        version: '0.1.2',
      });
      expect(result.data.sessions[0]).toMatchObject({ platform: 'darwin' });
    }
  });

  it('parses instance without version (optional field)', () => {
    const msg = {
      type: 'heartbeat',
      instance: { name: 'laptop-1', projectName: 'kilo' },
      sessions: [],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.instance).toEqual({ name: 'laptop-1', projectName: 'kilo' });
    }
  });

  it('rejects instance with empty name', () => {
    const msg = {
      type: 'heartbeat',
      instance: { name: '', projectName: 'kilo' },
      sessions: [],
    };
    expect(CLIOutboundMessageSchema.safeParse(msg).success).toBe(false);
  });

  it('rejects instance with oversize name', () => {
    const msg = {
      type: 'heartbeat',
      instance: { name: 'x'.repeat(65), projectName: 'kilo' },
      sessions: [],
    };
    expect(CLIOutboundMessageSchema.safeParse(msg).success).toBe(false);
  });

  it('rejects per-session platform that exceeds the 32-char cap', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [{ id: 'ses_1', status: 'busy', title: 't', platform: 'x'.repeat(33) }],
    };
    expect(CLIOutboundMessageSchema.safeParse(msg).success).toBe(false);
  });

  it('parses legacy heartbeat without instance or platform (backward compat regression)', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [{ id: 'ses_1', status: 'busy', title: 'Legacy' }],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.instance).toBeUndefined();
      expect(result.data.sessions[0]).not.toHaveProperty('platform');
    }
  });

  it('parses heartbeat with parentSessionId on sessions', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [
        { id: 'root-1', status: 'busy', title: 'Root' },
        { id: 'child-1', status: 'busy', title: 'Child', parentSessionId: 'root-1' },
      ],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.sessions[1]).toHaveProperty('parentSessionId', 'root-1');
    }
  });

  it('parses heartbeat without parentSessionId (backward compat)', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [{ id: 'ses_1', status: 'busy', title: 'Session' }],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.sessions[0]).not.toHaveProperty('parentSessionId');
    }
  });

  it('rejects heartbeat with null title', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [{ id: validSessionId, status: 'busy', title: null }],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it('parses valid event', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      event: 'message.updated',
      data: { id: 'msg_1' },
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid response', () => {
    const msg = { type: 'response', id: 'req_abc', result: { ok: true } };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses response with error only', () => {
    const msg = { type: 'response', id: 'req_err', error: 'not found' };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses event with parentSessionId', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      parentSessionId: 'parent-ses-1',
      event: 'message.updated',
      data: { id: 'msg-1' },
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty('parentSessionId', 'parent-ses-1');
    }
  });

  it('parses event without parentSessionId (backward compat)', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      event: 'message.updated',
      data: { id: 'msg-1' },
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('parentSessionId');
    }
  });

  it('rejects unknown type', () => {
    const msg = { type: 'unknown' };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });
});

describe('CLIOutboundMessageSchema capabilities', () => {
  const baseSession = { id: 'ses_cap_1', status: 'busy', title: 'cap' };

  it('accepts capabilities.attachments: true on a heartbeat', () => {
    const msg = {
      type: 'heartbeat',
      protocolVersion: '1',
      capabilities: { attachments: true },
      sessions: [baseSession],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.capabilities).toEqual({ attachments: true });
    }
  });

  it('accepts capabilities.attachments: false on a heartbeat', () => {
    const msg = {
      type: 'heartbeat',
      capabilities: { attachments: false },
      sessions: [baseSession],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.capabilities).toEqual({ attachments: false });
    }
  });

  it('accepts an absent capabilities field on a heartbeat (legacy CLI)', () => {
    const msg = { type: 'heartbeat', sessions: [baseSession] };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.capabilities).toBeUndefined();
    }
  });

  it('accepts an empty capabilities object on a heartbeat', () => {
    const msg = {
      type: 'heartbeat',
      capabilities: {},
      sessions: [baseSession],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.capabilities).toEqual({});
    }
  });

  it('rejects a non-boolean capabilities.attachments value', () => {
    const msg = {
      type: 'heartbeat',
      capabilities: { attachments: 'yes' },
      sessions: [baseSession],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it('accepts capabilities.sessionClone: true on a heartbeat', () => {
    const msg = {
      type: 'heartbeat',
      capabilities: { sessionClone: true },
      sessions: [baseSession],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.capabilities).toEqual({ sessionClone: true });
    }
  });

  it('accepts an absent sessionClone flag (legacy CLI)', () => {
    const msg = {
      type: 'heartbeat',
      capabilities: { attachments: true },
      sessions: [baseSession],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.capabilities).toEqual({ attachments: true });
    }
  });
});

describe('CLIOutboundMessageSchema prLink', () => {
  const baseSession = { id: 'ses_pr_1', status: 'busy', title: 'PR session' };

  it('parses a heartbeat session with a prLink', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [
        {
          ...baseSession,
          prLink: { platform: 'github', prUrl: 'https://github.com/o/r/pull/42', prNumber: 42 },
        },
      ],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.sessions[0].prLink).toEqual({
        platform: 'github',
        prUrl: 'https://github.com/o/r/pull/42',
        prNumber: 42,
      });
    }
  });

  it('parses a legacy heartbeat session without prLink', () => {
    const msg = { type: 'heartbeat', sessions: [baseSession] };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.sessions[0]).not.toHaveProperty('prLink');
    }
  });

  it('rejects a prLink with an oversize prUrl', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [
        {
          ...baseSession,
          prLink: { platform: 'github', prUrl: 'x'.repeat(2049), prNumber: 42 },
        },
      ],
    };
    expect(CLIOutboundMessageSchema.safeParse(msg).success).toBe(false);
  });

  it('rejects a prLink with a non-positive prNumber', () => {
    for (const prNumber of [0, -1]) {
      const msg = {
        type: 'heartbeat',
        sessions: [
          {
            ...baseSession,
            prLink: { platform: 'github', prUrl: 'https://github.com/o/r/pull/1', prNumber },
          },
        ],
      };
      expect(CLIOutboundMessageSchema.safeParse(msg).success).toBe(false);
    }
  });

  it('rejects a prLink with an empty platform', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [
        {
          ...baseSession,
          prLink: { platform: '', prUrl: 'https://github.com/o/r/pull/1', prNumber: 1 },
        },
      ],
    };
    expect(CLIOutboundMessageSchema.safeParse(msg).success).toBe(false);
  });
});

describe('CLIInboundMessageSchema', () => {
  it('parses valid subscribe', () => {
    const msg = { type: 'subscribe', sessionId: validSessionId };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid unsubscribe', () => {
    const msg = { type: 'unsubscribe', sessionId: validSessionId };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid command', () => {
    const msg = {
      type: 'command',
      id: 'cmd_1',
      command: 'send_message',
      sessionId: validSessionId,
      data: { text: 'hello' },
    };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses command without sessionId', () => {
    const msg = {
      type: 'command',
      id: 'cmd_2',
      command: 'list_sessions',
      data: null,
    };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid system', () => {
    const msg = { type: 'system', event: 'web.connected', data: {} };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('rejects subscribe with missing sessionId', () => {
    const msg = { type: 'subscribe' };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it('parses valid heartbeat_ack', () => {
    const msg = { type: 'heartbeat_ack' };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });
});

describe('WebOutboundMessageSchema', () => {
  it('parses valid subscribe', () => {
    const msg = { type: 'subscribe', sessionId: validSessionId };
    const result = WebOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid unsubscribe', () => {
    const msg = { type: 'unsubscribe', sessionId: validSessionId };
    const result = WebOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid command', () => {
    const msg = {
      type: 'command',
      id: 'req_1',
      command: 'send_message',
      sessionId: validSessionId,
      data: { text: 'hi' },
    };
    const result = WebOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses command with connectionId', () => {
    const msg = {
      type: 'command',
      id: 'req_2',
      command: 'start_session',
      connectionId: 'conn_1',
      data: {},
    };
    const result = WebOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses viewer ping with a nonce', () => {
    const result = WebOutboundMessageSchema.safeParse({ type: 'ping', nonce: 'ping-1' });
    expect(result.success).toBe(true);
  });

  it('rejects viewer ping without a nonce', () => {
    const result = WebOutboundMessageSchema.safeParse({ type: 'ping' });
    expect(result.success).toBe(false);
  });

  it('rejects command without id', () => {
    const msg = { type: 'command', command: 'test', data: {} };
    const result = WebOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });
});

describe('WebInboundMessageSchema', () => {
  it('parses valid event', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      event: 'session.updated',
      data: {},
    };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid system', () => {
    const msg = {
      type: 'system',
      event: 'cli.connected',
      data: { connectionId: 'conn_1' },
    };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid response', () => {
    const msg = { type: 'response', id: 'req_abc', result: { success: true } };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses viewer pong with a nonce', () => {
    const result = WebInboundMessageSchema.safeParse({ type: 'pong', nonce: 'ping-1' });
    expect(result.success).toBe(true);
  });

  it('rejects viewer pong without a nonce', () => {
    const result = WebInboundMessageSchema.safeParse({ type: 'pong' });
    expect(result.success).toBe(false);
  });

  it('parses event with parentSessionId', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      parentSessionId: 'parent-ses-1',
      event: 'message.updated',
      data: { id: 'msg-1' },
    };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty('parentSessionId', 'parent-ses-1');
    }
  });

  it('parses event without parentSessionId (backward compat)', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      event: 'session.updated',
      data: {},
    };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('parentSessionId');
    }
  });

  it('rejects unknown type', () => {
    const msg = { type: 'unknown', data: {} };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });
});

describe('SessionEventPayloadSchema', () => {
  const session = {
    source: 'v2',
    sessionId: validSessionId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    title: 'Test',
    createdOnPlatform: 'web',
    organizationId: null,
    gitUrl: null,
    gitBranch: null,
    parentSessionId: null,
    status: 'idle',
    statusUpdatedAt: null,
  };

  it('parses semantic v2 session events', () => {
    const events = [
      { type: 'session.created', data: { source: 'v2', session, changedAt: session.updatedAt } },
      { type: 'session.updated', data: { source: 'v2', session, changedAt: session.updatedAt } },
      {
        type: 'session.status.updated',
        data: {
          source: 'v2',
          session,
          previousStatus: null,
          status: 'idle',
          statusUpdatedAt: null,
          changedAt: session.updatedAt,
        },
      },
      {
        type: 'session.deleted',
        data: {
          source: 'v2',
          sessionId: validSessionId,
          parentSessionId: null,
          organizationId: null,
          gitUrl: null,
          gitBranch: null,
          createdOnPlatform: 'web',
          deletedAt: '2026-01-01T00:00:02.000Z',
        },
      },
    ];

    for (const event of events) {
      expect(SessionEventPayloadSchema.safeParse(event).success).toBe(true);
    }
  });

  it('parses lightweight status update payloads during rollout compatibility', () => {
    const result = SessionEventPayloadSchema.safeParse({
      type: 'session.status.updated',
      data: {
        source: 'v2',
        sessionId: validSessionId,
        previousStatus: 'idle',
        status: 'busy',
        statusUpdatedAt: '2026-01-01T00:00:02.000Z',
        updatedAt: '2026-01-01T00:00:02.000Z',
        changedAt: '2026-01-01T00:00:02.000Z',
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects invalid v2 session statuses', () => {
    const events = [
      {
        type: 'session.updated',
        data: {
          source: 'v2',
          session: { ...session, status: 'unknown' },
          changedAt: session.updatedAt,
        },
      },
      {
        type: 'session.status.updated',
        data: {
          source: 'v2',
          session,
          previousStatus: 'active',
          status: 'idle',
          statusUpdatedAt: null,
          changedAt: session.updatedAt,
        },
      },
      {
        type: 'session.status.updated',
        data: {
          source: 'v2',
          session,
          previousStatus: null,
          status: 'active',
          statusUpdatedAt: null,
          changedAt: session.updatedAt,
        },
      },
    ];

    for (const event of events) {
      expect(SessionEventPayloadSchema.safeParse(event).success).toBe(false);
    }
  });

  it('rejects non-v2 source and legacy identity fields', () => {
    const result = SessionEventPayloadSchema.safeParse({
      type: 'session.created',
      data: {
        source: 'v1',
        session: { ...session, kiloUserId: 'usr_1', projectId: 'proj_1', platform: 'web' },
        changedAt: session.updatedAt,
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('extra fields', () => {
  it('strips unknown fields by default on strict objects', () => {
    const msg = {
      type: 'subscribe',
      sessionId: validSessionId,
      extra: 'should-be-stripped',
    };
    const result = WebOutboundMessageSchema.parse(msg);
    expect(result).not.toHaveProperty('extra');
  });
});
