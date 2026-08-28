import { expect, it } from 'vitest';
import * as c from './contracts';

const id = '11111111-1111-4111-8111-111111111111';
const time = '2026-08-28T07:00:00.000Z';
const context = { type: 'organization', organizationId: id };
const error = { code: 'access_revoked', message: 'Access removed', retryable: false };
const conversation = {
  id,
  ownerUserId: 'auth0|old-user',
  context,
  permissionMode: 'ask',
  permissionRevision: 0,
};
const run = {
  id,
  conversationId: id,
  inputMessageId: id,
  originClientId: id,
  modelId: 'test/model',
  variant: 'fast',
};
const call = {
  id,
  runId: id,
  name: 'app.notifications',
  definitionVersion: '1',
  arguments: { nested: ['value'] },
  context,
  effect: 'side_effect',
  executionTarget: { kind: 'client', clientId: id },
  approval: null,
  state: 'waiting',
  result: null,
};
const grant = {
  id,
  conversationId: id,
  ownerUserId: conversation.ownerUserId,
  clientId: id,
  toolCallId: id,
  context,
  definitionVersion: '1',
  inputDigest: 'digest',
  generation: 0,
  expiresAt: time,
};
const interaction = { id, kind: 'approval', toolCall: call, resolution: null };
const action = { toolCall: call, grant, reason: 'locked' };
const text = {
  id,
  role: 'assistant',
  content: 'Historical answer',
  clientId: null,
  createdAt: time,
};
const snapshot = {
  protocolVersion: 1,
  conversation,
  recentMessages: [],
  historyCursor: null,
  activeRun: null,
  queuedRuns: [],
  unresolvedInteractions: [interaction],
  pendingClientActions: [action],
  eventCursor: 42,
};
const serialized = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const completedRead = {
  ...call,
  id: '22222222-2222-4222-8222-222222222222',
  runId: '33333333-3333-4333-8333-333333333333',
  name: 'test.read',
  effect: 'read',
  executionTarget: { kind: 'backend' },
  state: 'settled',
  result: { status: 'succeeded', output: { records: [{ id: 'record-7', value: 21 }] } },
};
const toolMessage = {
  ...text,
  provenance: 'harness',
  protocolVersion: 1,
  runId: completedRead.runId,
  parts: [{ type: 'tool_call', toolCall: completedRead }],
  incomplete: false,
};
const completedSnapshot = {
  ...snapshot,
  recentMessages: [toolMessage],
  unresolvedInteractions: [],
  pendingClientActions: [],
};
const completedEvent = {
  protocolVersion: 1,
  conversationId: id,
  sequence: 43,
  event: { type: 'message', message: toolMessage },
};

it.each([
  ['snapshot', c.SnapshotSchema, completedSnapshot],
  ['history message', c.MessageSchema, toolMessage],
  ['message event', c.EventEnvelopeSchema, completedEvent],
] as const)(
  'restores a completed backend read from a %s without pending work',
  (_name, schema, input) => {
    expect(schema.parse(serialized(schema.parse(input)))).toEqual(input);
  }
);
it('restores immutable tool inputs and targets from a historical message', () => {
  const restored = c.MessageSchema.parse(serialized(c.MessageSchema.parse(toolMessage)));
  const part = restored.parts[0];
  if (part.type !== 'tool_call') throw new Error('Missing tool record');
  expect(Reflect.set(part.toolCall, 'definitionVersion', '2')).toBe(false);
  expect(Reflect.set(part.toolCall.context, 'organizationId', 'another-org')).toBe(false);
  expect(Reflect.set(part.toolCall.executionTarget, 'kind', 'client')).toBe(false);
  const nested = part.toolCall.arguments.nested;
  if (typeof nested !== 'object' || nested === null) throw new Error('Missing nested arguments');
  expect(Reflect.set(nested, '0', 'changed')).toBe(false);
  expect(part.toolCall).toEqual(completedRead);
});
it('restores the approval and unknown outcome after a resolved interaction leaves the snapshot', () => {
  const approvedCall = {
    ...completedRead,
    name: 'test.write',
    effect: 'side_effect',
    approval: { interactionId: id, commandId: id, decision: 'approve' },
    result: { status: 'outcome_unknown', reason: 'Lost reply', providerReference: 'operation-1' },
  };
  const input = {
    ...completedSnapshot,
    recentMessages: [{ ...toolMessage, parts: [{ type: 'tool_call', toolCall: approvedCall }] }],
  };
  expect(c.SnapshotSchema.parse(serialized(c.SnapshotSchema.parse(input)))).toEqual(input);
});
it.each(['id', 'arguments', 'result'])(
  'rejects a recorded call missing %s across synchronization payloads',
  field => {
    const message = {
      ...toolMessage,
      parts: [{ type: 'tool_call', toolCall: { ...completedRead, [field]: undefined } }],
    };
    expect(c.MessageSchema.safeParse(serialized(message)).success).toBe(false);
    expect(
      c.SnapshotSchema.safeParse(serialized({ ...completedSnapshot, recentMessages: [message] }))
        .success
    ).toBe(false);
    expect(
      c.EventEnvelopeSchema.safeParse(
        serialized({ ...completedEvent, event: { type: 'message', message } })
      ).success
    ).toBe(false);
  }
);

it.each([
  {},
  { provenance: 'legacy' },
  { parts: [{ type: 'tool_call', toolCallId: id }], runId: id },
  { parts: toolMessage.parts, runId: completedRead.runId },
  { provenance: 'legacy', parts: toolMessage.parts, runId: completedRead.runId },
])('normalizes legacy text without authority: %j', additions => {
  for (const role of ['user', 'assistant']) {
    expect(c.MessageSchema.parse({ ...text, role, ...additions })).toEqual({
      ...text,
      role,
      provenance: 'legacy',
      parts: [{ type: 'text', text: text.content }],
    });
  }
});
it('forces legacy append rows to text even when a caller forges harness provenance', () => {
  expect(c.LegacyMessageSchema.parse(toolMessage)).toEqual({
    ...text,
    provenance: 'legacy',
    parts: [{ type: 'text', text: text.content }],
  });
});
it.each([{ type: 'personal' }, context])(
  'defaults missing settings without replacing context: %j',
  scope => {
    expect(
      c.ConversationSchema.parse({ id, ownerUserId: conversation.ownerUserId, context: scope })
    ).toEqual({ ...conversation, context: scope });
    expect(
      c.ConversationSchema.parse({ ...conversation, permissionMode: 'yolo', permissionRevision: 7 })
    ).toMatchObject({ permissionMode: 'yolo', permissionRevision: 7 });
  }
);
const parts = [
  { type: 'text', text: 'Result' },
  { type: 'tool_call', toolCall: call },
  { type: 'citation', title: 'Source', url: 'https://example.com/source' },
];
it.each([
  { input: undefined, expected: [{ type: 'text', text: 'Historical answer' }] },
  { input: parts, expected: parts },
])('preserves new parts or supplies the text fallback: %j', ({ input, expected }) => {
  const message = {
    ...text,
    provenance: 'harness',
    protocolVersion: 1,
    runId: id,
    incomplete: true,
  };
  expect(serialized(c.MessageSchema.parse({ ...message, parts: input }))).toEqual({
    ...message,
    parts: expected,
  });
});

it.each([
  ...['queued', 'running', 'stopping', 'completed', 'cancelled'].map(status => ({ status })),
  ...['approval', 'question', 'client', 'reconciliation'].map(reason => ({
    status: 'waiting',
    waiting: { toolCallId: id, reason },
  })),
  { status: 'failed', error },
])('retains the run state in ordered events: %j', state => {
  const event = {
    protocolVersion: 1,
    conversationId: id,
    sequence: 43,
    event: { type: 'run', run: { ...run, state } },
  };
  expect(serialized(c.EventEnvelopeSchema.parse(event))).toEqual(event);
  expect(c.RunStateSchema.safeParse({ ...state, unexpected: true }).success).toBe(false);
});
it.each([
  { status: 'succeeded', output: { values: ['ok', 1, true, null] } },
  { status: 'failed', error },
  { status: 'denied' },
  { status: 'cancelled' },
  { status: 'outcome_unknown', reason: 'Lost reply', providerReference: 'operation-1' },
])('retains each settled tool outcome without converting uncertainty: %j', result => {
  const settled = { ...call, state: 'settled', result };
  expect(serialized(c.ToolCallSchema.parse(settled))).toEqual(settled);
  expect(c.ToolOutcomeSchema.safeParse({ ...result, unexpected: true }).success).toBe(false);
});
it.each(['browser', 'mobile'])('preserves the registered %s client and arbitrary user ID', kind => {
  const client = {
    id,
    ownerUserId: conversation.ownerUserId,
    kind,
    supportedTools: [{ name: call.name, version: '1' }],
    revokedAt: null,
  };
  expect(serialized(c.ClientSchema.parse(client))).toEqual(client);
});
it.each([
  interaction,
  { ...interaction, resolution: { interactionId: id, commandId: id, decision: 'approve' } },
  { ...interaction, resolution: { interactionId: id, commandId: id, decision: 'deny' } },
  { ...interaction, kind: 'question', questionId: 'q1', resolution: null },
  {
    ...interaction,
    kind: 'question',
    questionId: 'q1',
    resolution: { kind: 'answer', choiceIds: ['c1'], text: 'Other' },
  },
  { ...interaction, kind: 'question', questionId: 'q1', resolution: { kind: 'dismiss' } },
])('retains durable interaction identity and resolution: %j', record => {
  expect(serialized(c.InteractionSchema.parse(record))).toEqual(record);
});
it.each(['offline', 'background', 'locked', 'gesture', 'unavailable', 'reconciliation'])(
  'retains %s client actions and interactions outside an empty history page',
  reason => {
    const input = { ...snapshot, pendingClientActions: [{ ...action, reason }] };
    expect(serialized(c.SnapshotSchema.parse(input))).toEqual(input);
  }
);
it.each(Object.keys(snapshot))('rejects a snapshot missing %s', field => {
  const input = { ...snapshot };
  Reflect.deleteProperty(input, field);
  expect(c.SnapshotSchema.safeParse(input).success).toBe(false);
});
it('prevents changing normalized context, arguments, definitions, and designated targets', () => {
  const parsed = c.ToolCallSchema.parse(call);
  expect(Reflect.set(parsed, 'context', { type: 'personal' })).toBe(false);
  expect(Reflect.set(parsed.context, 'organizationId', 'another-org')).toBe(false);
  expect(Reflect.set(parsed, 'definitionVersion', '2')).toBe(false);
  expect(Reflect.set(parsed.executionTarget, 'clientId', 'another-client')).toBe(false);
  const nested = parsed.arguments.nested;
  if (typeof nested !== 'object' || nested === null) throw new Error('Missing nested arguments');
  expect(Reflect.set(nested, '0', 'changed')).toBe(false);
  expect(serialized(parsed)).toEqual(call);
});

it.each([
  { provenance: 'legacy' },
  { provenance: 'harness', protocolVersion: 1, runId: id, incomplete: false },
])('restores missing producer fields before serialization: %j', fields => {
  const input = { ...text, ...fields };
  Reflect.deleteProperty(input, 'clientId');
  Reflect.deleteProperty(input, 'incomplete');
  expect(serialized(c.MessageSchema.parse(input))).toEqual({
    ...text,
    ...fields,
    parts: [{ type: 'text', text: text.content }],
  });
});
it.each([
  { state: 'pending', effect: 'read', executionTarget: { kind: 'backend' } },
  { state: 'executing', effect: 'unknown', executionTarget: { kind: 'client', clientId: id } },
  { state: 'waiting', effect: 'side_effect', executionTarget: { kind: 'interaction' } },
])('retains unsettled calls and their execution targets: %j', fields => {
  const input = { ...call, ...fields };
  expect(serialized(c.ToolCallSchema.parse(input))).toEqual(input);
});
it.each([
  { status: 'running' },
  { status: 'waiting', waiting: { toolCallId: id, reason: 'approval' } },
  { status: 'stopping' },
])('retains active and queued runs with an opaque history cursor: %j', state => {
  const input = {
    ...snapshot,
    historyCursor: 'before:message-1',
    activeRun: { ...run, state },
    queuedRuns: [{ ...run, state: { status: 'queued' } }],
  };
  expect(serialized(c.SnapshotSchema.parse(input))).toEqual(input);
});
const envelope = {
  protocolVersion: 1,
  conversationId: id,
  sequence: 43,
  event: { type: 'conversation', conversation },
};
it.each([
  envelope.event,
  {
    type: 'message',
    message: {
      ...text,
      provenance: 'harness',
      protocolVersion: 1,
      runId: id,
      parts,
      incomplete: false,
    },
  },
  { type: 'interaction', interaction },
  { type: 'client_action', toolCallId: id, action },
  { type: 'client_action', toolCallId: id, action: null },
])('preserves each non-run event payload: %j', event => {
  const input = { ...envelope, event };
  expect(serialized(c.EventEnvelopeSchema.parse(input))).toEqual(input);
});

it.each([
  [c.RunStateSchema, { status: 'waiting' }],
  [c.RunStateSchema, { status: 'failed' }],
  [c.RunStateSchema, { status: 'paused' }],
  [c.WaitingSchema, { toolCallId: id, reason: 'offline' }],
  [c.RunSchema, { ...run, variant: 1, state: { status: 'queued' } }],
  [c.ToolOutcomeSchema, { status: 'succeeded' }],
  [c.ToolOutcomeSchema, { status: 'failed' }],
  [c.ToolOutcomeSchema, { status: 'outcome_unknown' }],
  [c.ToolOutcomeSchema, { status: 'timeout' }],
  [c.ToolCallSchema, { ...call, state: 'settled' }],
  [c.ToolCallSchema, { ...call, result: { status: 'cancelled' } }],
  [c.ExecutionTargetSchema, { kind: 'client' }],
  [c.ExecutionTargetSchema, { kind: 'backend', clientId: id }],
  [c.InteractionSchema, { ...interaction, kind: 'question' }],
  [c.ExecutionGrantSchema, { ...grant, clientId: undefined }],
  [c.ConversationSchema, { ...conversation, context: { type: 'organization' } }],
  [c.ConversationSchema, { ...conversation, permissionMode: 'auto' }],
  [c.ConversationSchema, { ...conversation, permissionRevision: -1 }],
  [c.MessageSchema, { ...text, provenance: 'harness', runId: id }],
  [c.MessageSchema, { ...text, provenance: 'harness', protocolVersion: 2, runId: id }],
  [c.MessageSchema, { ...text, protocolVersion: 2 }],
  [c.MessageSchema, { ...text, provenance: 'unknown' }],
  [c.MessagePartSchema, { type: 'citation', title: 'Unsafe', url: 'javascript:alert(1)' }],
  [c.MessagePartSchema, { type: 'tool_call' }],
  [c.MessagePartSchema, { type: 'tool_call', toolCallId: completedRead.id }],
  [
    c.MessageSchema,
    { ...toolMessage, parts: [{ type: 'tool_call', toolCallId: completedRead.id }] },
  ],
  ...[0, 2, undefined].map(
    protocolVersion => [c.SnapshotSchema, { ...snapshot, protocolVersion }] as const
  ),
  ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(
    eventCursor => [c.SnapshotSchema, { ...snapshot, eventCursor }] as const
  ),
  [c.SnapshotSchema, { ...snapshot, activeRun: { ...run, state: { status: 'completed' } } }],
  [c.SnapshotSchema, { ...snapshot, queuedRuns: [{ ...run, state: { status: 'running' } }] }],
  [
    c.SnapshotSchema,
    {
      ...snapshot,
      unresolvedInteractions: [
        { ...interaction, resolution: { interactionId: id, commandId: id, decision: 'approve' } },
      ],
    },
  ],
  [
    c.PendingClientActionSchema,
    { ...action, toolCall: { ...call, executionTarget: { kind: 'backend' } } },
  ],
  ...[0, 2, undefined].map(
    protocolVersion => [c.EventEnvelopeSchema, { ...envelope, protocolVersion }] as const
  ),
  ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(
    sequence => [c.EventEnvelopeSchema, { ...envelope, sequence }] as const
  ),
  [c.EventEnvelopeSchema, { ...envelope, event: { type: 'unknown' } }],
] as const)('rejects invalid contract input %#', (schema, input) => {
  expect(schema.safeParse(input).success).toBe(false);
});
