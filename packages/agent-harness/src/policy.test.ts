import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  CommandSchema,
  ReadInputSchema,
  commandReplayDecision,
  fingerprintCommand,
} from './commands';
import { ToolCallSchema } from './contracts';
import { commandAdmission, evaluateDispatch, type DispatchPolicy } from './policy';
import {
  QuestionSchema,
  ToolRequestSchema,
  toolDefinitions,
  validQuestionResponse,
  type ToolName,
} from './tools';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const context = { type: 'personal' };
const envelope = { protocolVersion: 1, commandId: id, clientId: id };
const scope = { actorUserId: 'auth0|owner', conversationId: id };
const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');
const question = {
  questionId: 'q1',
  prompt: 'Choose',
  choices: [
    { id: 'c1', label: 'First' },
    { id: 'c2', label: 'Second' },
  ],
  minSelections: 1,
  maxSelections: 1,
  allowFreeText: false,
  allowCancellation: true,
};
const answer = { kind: 'answer', questionId: 'q1', choiceIds: ['c1'] };
const mutations = [
  [
    'getOrCreateConversation',
    { context },
    { context: { type: 'organization', organizationId: other } },
  ],
  [
    'sendMessage',
    { conversationId: id, text: 'Hello', modelId: 'model', permissionRevision: 4 },
    { text: 'Changed' },
  ],
  [
    'setPermissionMode',
    {
      conversationId: id,
      permissionMode: 'yolo',
      expectedPermissionRevision: 4,
      acknowledgePendingActions: true,
    },
    { permissionMode: 'ask' },
  ],
  [
    'resolveInteraction',
    { conversationId: id, interactionId: id, resolution: { kind: 'approve' } },
    { resolution: { kind: 'deny' } },
  ],
  ['cancelRun', { conversationId: id, runId: id }, { runId: other }],
  ['claimClientTool', { conversationId: id, toolCallId: id }, { toolCallId: other }],
  [
    'completeClientTool',
    {
      conversationId: id,
      toolCallId: id,
      grantId: id,
      generation: 0,
      result: { status: 'succeeded', output: { b: 2, a: [null, true, 1] } },
    },
    { result: { status: 'outcome_unknown', reason: 'Lost receipt' } },
  ],
  [
    'registerClient',
    { kind: 'mobile', supportedTools: [{ name: 'app.notifications', version: '1' }] },
    { kind: 'browser' },
  ],
  ['revokeClient', {}, { clientId: other }],
] as const;
it.each(mutations)(
  '%s replays unchanged input and conflicts on changed input',
  async (type, fields, changed) => {
    const input = { ...envelope, type, ...fields };
    const original = await fingerprintCommand(scope, input, sha256);
    const replay = Object.fromEntries(Object.entries(input).reverse());
    expect(commandReplayDecision(undefined, original)).toBe('new');
    expect(commandReplayDecision(original, await fingerprintCommand(scope, replay, sha256))).toBe(
      'replay'
    );
    expect(
      commandReplayDecision(
        original,
        await fingerprintCommand(scope, { ...input, ...changed }, sha256)
      )
    ).toBe('command_conflict');
    for (const missing of ['commandId', 'protocolVersion', 'clientId']) {
      expect(CommandSchema.safeParse({ ...input, [missing]: undefined }).success).toBe(false);
    }
    for (const forged of ['ownerUserId', 'authorization', 'requestId']) {
      expect(CommandSchema.safeParse({ ...input, [forged]: 'forged' }).success).toBe(false);
    }
  }
);
it('hashes normalized nested inputs and excludes transport credentials and timestamps', async () => {
  const input = {
    ...envelope,
    type: 'completeClientTool',
    conversationId: id,
    toolCallId: id,
    grantId: id,
    generation: 0,
    result: { status: 'succeeded', output: { z: [2, { b: 1, a: 0 }], a: true } },
  };
  const original = await fingerprintCommand(
    { ...scope, authorization: 'first', timestamp: 1 } as typeof scope,
    input,
    sha256
  );
  const replay = {
    ...input,
    result: { status: 'succeeded', output: { a: true, z: [2, { a: 0, b: 1 }] } },
  };
  const authority = { ...scope, authorization: 'second', timestamp: 2 };
  expect(await fingerprintCommand(authority, replay, sha256)).toBe(original);
  expect(
    await fingerprintCommand({ ...scope, actorUserId: 'another-user' }, replay, sha256)
  ).not.toBe(original);
  const created = { ...envelope, type: 'getOrCreateConversation', context };
  expect(await fingerprintCommand(scope, created, sha256)).not.toBe(
    await fingerprintCommand({ ...scope, conversationId: other }, created, sha256)
  );
  await expect(
    fingerprintCommand({ ...scope, conversationId: other }, input, sha256)
  ).rejects.toThrow('Conversation');
  const changedOrder = {
    ...input,
    result: { status: 'succeeded', output: { a: true, z: [{ a: 0, b: 1 }, 2] } },
  };
  expect(await fingerprintCommand(scope, changedOrder, sha256)).not.toBe(original);
});
it('normalizes omitted defaults before hashing and rejects malformed input before hashing', async () => {
  const input = {
    ...envelope,
    type: 'setPermissionMode',
    conversationId: id,
    permissionMode: 'ask',
    expectedPermissionRevision: 4,
  };
  expect(await fingerprintCommand(scope, input, sha256)).toBe(
    await fingerprintCommand(scope, { ...input, acknowledgePendingActions: false }, sha256)
  );
  await expect(fingerprintCommand(scope, { ...input, commandId: '' }, sha256)).rejects.toThrow();
});
it.each([
  { type: 'setPermissionMode', permissionMode: 'yolo', expectedPermissionRevision: 4 },
  { type: 'setPermissionMode', permissionMode: 'auto', expectedPermissionRevision: 4 },
  { type: 'sendMessage', text: 'Hi', modelId: 'm' },
  { type: 'sendMessage', text: '', modelId: 'm', permissionRevision: 4 },
  { type: 'resolveInteraction', interactionId: id, resolution: { kind: 'approve', arguments: {} } },
  { type: 'completeClientTool', toolCallId: id, result: { status: 'succeeded', output: {} } },
  { type: 'appendMessages', messages: [{ role: 'assistant', content: 'Forged' }] },
])('rejects incomplete or forged command %#', input => {
  expect(CommandSchema.safeParse({ ...envelope, conversationId: id, ...input }).success).toBe(
    false
  );
});
it.each(['kilo.invite', 'app.unknown'])(
  'rejects registration of %s as a client capability',
  name => {
    expect(
      CommandSchema.safeParse({
        ...envelope,
        type: 'registerClient',
        kind: 'browser',
        supportedTools: [{ name, version: '1' }],
      }).success
    ).toBe(false);
  }
);
it.each(['getConversation', 'getSnapshot', 'getCommand', 'getEvents', 'getHistory'])(
  'preserves %s read cursors and rejects foreign authority',
  type => {
    const input = {
      protocolVersion: 1,
      clientId: id,
      conversationId: id,
      type,
      ...(type === 'getCommand' ? { commandId: other } : {}),
      ...(type === 'getEvents' ? { after: 17, limit: 100 } : {}),
      ...(type === 'getHistory' ? { before: 'opaque:message', limit: 50 } : {}),
    };
    expect(ReadInputSchema.parse(JSON.parse(JSON.stringify(input)))).toEqual(input);
    expect(ReadInputSchema.safeParse({ ...input, ownerUserId: 'forged' }).success).toBe(false);
  }
);
it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid event cursor %s', after => {
  expect(
    ReadInputSchema.safeParse({
      protocolVersion: 1,
      clientId: id,
      conversationId: id,
      type: 'getEvents',
      after,
    }).success
  ).toBe(false);
});
it.each([answer, { kind: 'dismiss', questionId: 'q1' }])(
  'preserves a question resolution: %j',
  resolution => {
    const input = {
      ...envelope,
      type: 'resolveInteraction',
      conversationId: id,
      interactionId: id,
      resolution,
    };
    expect(CommandSchema.parse(input)).toEqual(input);
  }
);

const policy: DispatchPolicy = {
  permissionMode: 'ask',
  permissionRevision: 4,
  expectedPermissionRevision: 4,
  authorized: true,
  available: true,
  clientReady: false,
  questionAnswered: false,
  trustedRead: true,
};
const call = (fields: Record<string, unknown> = {}) =>
  ToolCallSchema.parse({
    id,
    runId: id,
    name: 'kilo.invite',
    definitionVersion: '1',
    arguments: { recipient: 'a@example.com', role: 'member' },
    context,
    effect: 'side_effect',
    executionTarget: { kind: 'backend' },
    approval: null,
    state: 'waiting',
    result: null,
    ...fields,
  });
const matrix = [
  ['read', 'backend', 'dispatch', 'dispatch'],
  ['side_effect', 'backend', 'approval', 'dispatch'],
  ['unknown', 'backend', 'approval', 'dispatch'],
  ['read', 'client', 'client', 'client'],
  ['side_effect', 'client', 'approval', 'client'],
  ['unknown', 'client', 'approval', 'client'],
  ['read', 'interaction', 'question', 'question'],
  ['side_effect', 'interaction', 'approval', 'question'],
  ['unknown', 'interaction', 'approval', 'question'],
] as const;
for (const [effect, kind, ask, yolo] of matrix) {
  for (const [permissionMode, decision] of [
    ['ask', ask],
    ['yolo', yolo],
  ] as const) {
    it.each([
      [3, 'stale_revision'],
      [4, decision],
      [5, 'stale_revision'],
    ] as const)(
      `${effect}/${kind}/${permissionMode} at revision %s returns %s`,
      (expectedPermissionRevision, expected) => {
        const stored = call({
          effect,
          executionTarget: kind === 'client' ? { kind, clientId: id } : { kind },
        });
        expect(
          evaluateDispatch(stored, stored, {
            ...policy,
            permissionMode,
            expectedPermissionRevision,
          })
        ).toBe(expected);
      }
    );
  }
}
it.each(['ask', 'yolo'] as const)(
  '%s preserves approvals without bypassing access, availability, or denial',
  permissionMode => {
    const approved = call({ approval: { interactionId: id, commandId: id, decision: 'approve' } });
    const current = {
      ...policy,
      permissionMode,
      permissionRevision: 8,
      expectedPermissionRevision: 8,
    };
    expect(evaluateDispatch(approved, approved, current)).toBe('dispatch');
    expect(evaluateDispatch(approved, approved, { ...current, authorized: false })).toBe(
      'access_revoked'
    );
    expect(evaluateDispatch(approved, approved, { ...current, available: false })).toBe(
      'unavailable_tool'
    );
    const denied = call({ approval: { interactionId: id, commandId: id, decision: 'deny' } });
    expect(evaluateDispatch(denied, denied, current)).toBe('denied');
    const unapproved = call();
    expect(evaluateDispatch(unapproved, approved, { ...current, permissionMode: 'ask' })).toBe(
      'approval'
    );
  }
);
it.each([
  { id: other },
  { runId: other },
  { name: 'kilo.sessions.stop' },
  { definitionVersion: '2' },
  { arguments: { recipient: 'another@example.com', role: 'member' } },
  { context: { type: 'organization', organizationId: other } },
  { effect: 'read' },
  { executionTarget: { kind: 'client', clientId: other } },
])('requires a new call for material change %# even with approval and YOLO', change => {
  const stored = call({
    context: { type: 'organization', organizationId: id },
    executionTarget: { kind: 'client', clientId: id },
    approval: { interactionId: id, commandId: id, decision: 'approve' },
  });
  expect(
    evaluateDispatch(stored, call({ ...stored, ...change }), { ...policy, permissionMode: 'yolo' })
  ).toBe('new_call_required');
});
it.each(['executing', 'settled'])('does not redispatch %s calls after a mode change', state => {
  const stored = call({
    state,
    result: state === 'settled' ? { status: 'outcome_unknown', reason: 'Lost reply' } : null,
  });
  expect(evaluateDispatch(stored, stored, policy)).toBe('already_dispatched');
});
it('requires trusted reads, real answers, and device readiness', () => {
  const read = call({ effect: 'read' });
  expect(evaluateDispatch(read, read, { ...policy, trustedRead: false })).toBe('approval');
  const device = call({ effect: 'read', executionTarget: { kind: 'client', clientId: id } });
  expect(evaluateDispatch(device, device, { ...policy, clientReady: true })).toBe('dispatch');
  const questionCall = call({ effect: 'read', executionTarget: { kind: 'interaction' } });
  expect(evaluateDispatch(questionCall, questionCall, { ...policy, questionAnswered: true })).toBe(
    'dispatch'
  );
});
it.each(['ask', 'yolo'] as const)(
  'admits only direct, current %s mode changes and current sends',
  permissionMode => {
    const mode = CommandSchema.parse({
      ...envelope,
      type: 'setPermissionMode',
      conversationId: id,
      permissionMode,
      expectedPermissionRevision: 4,
      acknowledgePendingActions: true,
    });
    const send = CommandSchema.parse({
      ...envelope,
      type: 'sendMessage',
      conversationId: id,
      text: 'Hello',
      modelId: 'm',
      permissionRevision: 4,
    });
    expect(commandAdmission(mode, 4, 'agent')).toBe('denied');
    for (const command of [mode, send]) {
      expect(commandAdmission(command, 4, 'user')).toBe('accept');
      expect(commandAdmission(command, 3, 'user')).toBe('stale_revision');
      expect(commandAdmission(command, 5, 'user')).toBe('stale_revision');
    }
    expect(
      commandAdmission(CommandSchema.parse({ ...envelope, type: 'revokeClient' }), 9, 'user')
    ).toBe('accept');
  }
);

const session = { sessionId: 'session-1' };
const resource = { id, name: 'Example' };
const page = { url: 'https://example.com', title: 'Source', text: 'Text', untrusted: true };
const remote = {
  serverId: 'server',
  configurationVersion: '1',
  name: 'remote',
  definitionVersion: '1',
};
const preference = { name: 'showToolDetails', value: true };
const screen = { screen: 'preferences' };
const tools = {
  'kilo.organizations': [{}, [resource], 'dispatch', 'dispatch'],
  'kilo.members': [
    {},
    [{ id: 'user', email: 'a@example.com', role: 'member' }],
    'dispatch',
    'dispatch',
  ],
  'kilo.usage': [{}, { costUsd: 1 }, 'dispatch', 'dispatch'],
  'kilo.repositories': [{}, [resource], 'dispatch', 'dispatch'],
  'kilo.invite': [
    { recipient: 'a@example.com', role: 'member' },
    { invitationId: id, emailQueued: true },
    'approval',
    'dispatch',
  ],
  'kilo.sessions.search': [
    { query: 'test' },
    [{ ...session, title: 'Test' }],
    'dispatch',
    'dispatch',
  ],
  'kilo.sessions.attach': [
    session,
    { ...session, messages: [{ role: 'user', content: 'Hello' }], untrusted: true },
    'dispatch',
    'dispatch',
  ],
  'kilo.sessions.start': [{ prompt: 'Fix', modelId: 'model' }, session, 'approval', 'dispatch'],
  'kilo.sessions.continue': [{ ...session, message: 'Continue' }, session, 'approval', 'dispatch'],
  'kilo.sessions.stop': [session, session, 'approval', 'dispatch'],
  'kilo.sessions.progress': [session, { ...session, status: 'running' }, 'dispatch', 'dispatch'],
  'mcp.discover': [
    {},
    [{ ...remote, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }],
    'dispatch',
    'dispatch',
  ],
  'mcp.call': [
    { ...remote, arguments: { query: 'test' } },
    { content: [{ type: 'text', text: 'Remote' }] },
    'approval',
    'dispatch',
  ],
  'web.search': [{ query: 'test', limit: 5 }, [page], 'dispatch', 'dispatch'],
  'web.retrieve': [{ url: page.url }, page, 'dispatch', 'dispatch'],
  'app.currentScreen': [{}, { destination: screen, data: {} }, 'client', 'client'],
  'app.openScreen': [screen, screen, 'approval', 'client'],
  'app.setPreference': [preference, preference, 'approval', 'client'],
  'app.notifications': [{}, { permission: 'denied' }, 'approval', 'client'],
  'app.openSettings': [{}, { opened: false }, 'approval', 'client'],
  'question.ask': [question, answer, 'question', 'question'],
} satisfies Record<ToolName, [Record<string, unknown>, unknown, string, string]>;
it.each(toolDefinitions)('$name validates requests/results and gates both modes', definition => {
  const [input, output, ask, yolo] = tools[definition.name];
  expect(ToolRequestSchema.parse({ name: definition.name, arguments: input })).toEqual({
    name: definition.name,
    arguments: input,
  });
  expect(definition.outputSchema.parse(output)).toEqual(output);
  expect(definition.outputSchema.safeParse(null).success).toBe(false);
  for (const field of ['actorUserId', 'organizationId']) {
    expect(
      ToolRequestSchema.safeParse({ name: definition.name, arguments: { ...input, [field]: id } })
        .success
    ).toBe(false);
  }
  const stored = call({
    name: definition.name,
    arguments: input,
    effect: definition.effect,
    definitionVersion: definition.version,
    executionTarget:
      definition.executorKind === 'client'
        ? { kind: 'client', clientId: id }
        : { kind: definition.executorKind },
  });
  expect(evaluateDispatch(stored, stored, policy)).toBe(ask);
  expect(evaluateDispatch(stored, stored, { ...policy, permissionMode: 'yolo' })).toBe(yolo);
});
it.each(['setPermissionMode', 'callEndpoint', 'app.eval', 'app.tap', 'unknown'])(
  'rejects unnamed tool %s',
  name => {
    expect(ToolRequestSchema.safeParse({ name, arguments: {} }).success).toBe(false);
  }
);
it.each([
  ['kilo.invite', { recipient: 'invalid', role: 'member' }],
  ['kilo.invite', { recipient: 'a@example.com' }],
  ['web.retrieve', { url: 'file:///private' }],
  ['web.search', { query: 'test', limit: 6 }],
  ['app.openScreen', { screen: 'arbitrary', url: 'https://example.com' }],
  ['app.setPreference', { name: 'permissionMode', value: true }],
  ['mcp.call', { ...remote, definitionVersion: undefined, arguments: {} }],
])('rejects invalid %s arguments', (name, input) => {
  expect(ToolRequestSchema.safeParse({ name, arguments: input }).success).toBe(false);
});
it.each([
  { choices: [], minSelections: 0, maxSelections: 0, allowCancellation: false },
  { minSelections: 2 },
  { maxSelections: 3 },
  { choices: [question.choices[0], question.choices[0]] },
  { minSelections: -1 },
  { maxSelections: 0.5 },
  { questionId: '' },
  { prompt: '' },
  { choices: [{ id: '', label: 'Empty' }] },
])('rejects invalid question definition %#', change => {
  const invalid = { ...question, ...change };
  expect(QuestionSchema.safeParse(invalid).success).toBe(false);
  expect(validQuestionResponse(invalid, answer)).toBe(false);
});
it.each([
  { choiceIds: [] },
  { choiceIds: ['First'] },
  { choiceIds: ['c1', 'c1'] },
  { choiceIds: ['c1', 'c2'] },
  { text: 'Not allowed' },
  { questionId: 'q2' },
  { kind: 'cancelled' },
  { choiceIds: null },
])('rejects invalid question answer %#', change => {
  expect(validQuestionResponse(question, { ...answer, ...change })).toBe(false);
});
it('uses stable IDs across translated labels and supports free text and explicit cancellation', () => {
  expect(
    validQuestionResponse({ ...question, choices: [{ id: 'c1', label: 'Translated' }] }, answer)
  ).toBe(true);
  expect(validQuestionResponse(question, { kind: 'dismiss', questionId: 'q1' })).toBe(true);
  const freeText = {
    ...question,
    choices: [],
    minSelections: 0,
    maxSelections: 0,
    allowFreeText: true,
  };
  expect(validQuestionResponse(freeText, { ...answer, choiceIds: [], text: 'Other' })).toBe(true);
  expect(validQuestionResponse(freeText, { ...answer, choiceIds: [] })).toBe(false);
  expect(validQuestionResponse(freeText, { ...answer, choiceIds: [], text: ' ' })).toBe(false);
  expect(validQuestionResponse(question, null)).toBe(false);
});
it.each(['', ' ', '\n'])('rejects blank questions and messages: %j', text => {
  expect(QuestionSchema.safeParse({ ...question, prompt: text }).success).toBe(false);
  expect(
    CommandSchema.safeParse({
      ...envelope,
      type: 'sendMessage',
      conversationId: id,
      text,
      modelId: 'model',
      permissionRevision: 4,
    }).success
  ).toBe(false);
});
it('fingerprints protocol, command identity, actor, and null registration scope with SHA-256', async () => {
  const input = { ...envelope, type: 'revokeClient' };
  const expected = sha256(
    `{"actorUserId":"auth0|owner","command":{"clientId":"${id}","commandId":"${id}","protocolVersion":1,"type":"revokeClient"},"conversationId":null}`
  );
  expect(await fingerprintCommand({ ...scope, conversationId: null }, input, sha256)).toBe(
    expected
  );
  expect(
    await fingerprintCommand(
      { ...scope, conversationId: null },
      { ...input, commandId: other },
      sha256
    )
  ).not.toBe(expected);
  await expect(
    fingerprintCommand(scope, { ...input, protocolVersion: 2 }, sha256)
  ).rejects.toThrow();
});
it('keeps exact-call approval when only object key order and mutable state change', () => {
  const stored = call({ approval: { interactionId: id, commandId: id, decision: 'approve' } });
  const proposed = call({
    ...stored,
    state: 'pending',
    arguments: { role: 'member', recipient: 'a@example.com' },
  });
  expect(evaluateDispatch(stored, proposed, policy)).toBe('dispatch');
});
it('permits cancellation-only questions but never fabricates their answer', () => {
  const cancellationOnly = { ...question, choices: [], minSelections: 0, maxSelections: 0 };
  expect(validQuestionResponse(cancellationOnly, { kind: 'dismiss', questionId: 'q1' })).toBe(true);
  expect(validQuestionResponse(cancellationOnly, { ...answer, choiceIds: [] })).toBe(false);
  expect(
    validQuestionResponse(
      { ...question, allowCancellation: false },
      { kind: 'dismiss', questionId: 'q1' }
    )
  ).toBe(false);
  expect(validQuestionResponse(question, { kind: 'dismiss', questionId: 'q2' })).toBe(false);
});
it('honors zero-selection bounds and optional text without bypassing required choices', () => {
  expect(
    validQuestionResponse({ ...question, minSelections: 0 }, { ...answer, choiceIds: [] })
  ).toBe(true);
  expect(
    validQuestionResponse({ ...question, allowFreeText: true }, { ...answer, text: 'Notes' })
  ).toBe(true);
  expect(
    validQuestionResponse(
      { ...question, allowFreeText: true },
      { ...answer, choiceIds: [], text: 'Notes' }
    )
  ).toBe(false);
});
it('fingerprints advertised client versions without coupling registration to the current executor', async () => {
  const authority = { ...scope, conversationId: null };
  const input = {
    ...envelope,
    type: 'registerClient',
    kind: 'mobile',
    supportedTools: [{ name: 'app.notifications', version: 'older' }],
  };
  const fingerprint = await fingerprintCommand(authority, input, sha256);
  expect(await fingerprintCommand(authority, input, sha256)).toBe(fingerprint);
  expect(
    commandReplayDecision(
      fingerprint,
      await fingerprintCommand(
        authority,
        {
          ...input,
          supportedTools: [{ name: 'app.notifications', version: '1' }],
        },
        sha256
      )
    )
  ).toBe('command_conflict');
});
