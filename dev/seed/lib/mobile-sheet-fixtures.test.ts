import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import {
  kiloSdkMessageSchema,
  kiloSdkPartSchema,
  kiloSdkSessionInfoSchema,
} from '@kilocode/session-ingest-contracts';

import {
  buildChildIngestItems,
  buildChildPerformanceFixtures,
  buildEmptyIngestItems,
  buildMobileSheetFixtureResult,
  buildRootIngestItems,
  buildUnsupportedIngestItems,
  CHILD_ASSISTANT_MESSAGE_ID,
  CHILD_BASH_PART_ID,
  CHILD_SESSION_ID,
  CHILD_SESSION_TITLE,
  CHILD_USER_MESSAGE_ID,
  EMPTY_CHILD_SESSION_ID,
  EMPTY_SESSION_ID,
  EMPTY_SESSION_TITLE,
  expectedPartIdsFor,
  fixtureCleanupSessionIds,
  fixtureSessionIds,
  NESTED_CHILD_SESSION_ID,
  parseSessionIngestServiceStatus,
  PERFORMANCE_ROOT_SESSION_ID,
  pollForChildPerformanceFixture,
  ROOT_ASSISTANT_MESSAGE_ID,
  ROOT_FILE_PART_ID,
  ROOT_READ_PART_ID,
  ROOT_SESSION_ID,
  ROOT_SESSION_TITLE,
  ROOT_TASK_PART_ID,
  ROOT_USER_MESSAGE_ID,
  SELECTED_CHILD_SESSION_ID,
  UNSUPPORTED_SESSION_ID,
  UNSUPPORTED_SESSION_TITLE,
  UNSUPPORTED_USER_MESSAGE_ID,
  type ChildPerformanceFixture,
  type SessionIngestItem,
} from './mobile-sheet-fixtures';

function itemsOfType(items: SessionIngestItem[], type: string): SessionIngestItem[] {
  return items.filter(item => item.type === type);
}

function singleItemOfType(items: SessionIngestItem[], type: string): SessionIngestItem {
  const found = itemsOfType(items, type);
  assert.equal(found.length, 1, `expected exactly one ${type} item`);
  return found[0];
}

function parseSessionData(data: SessionIngestItem['data']) {
  const parsed = kiloSdkSessionInfoSchema.safeParse(data);
  if (!parsed.success) {
    assert.fail(`session item failed schema validation: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

function parseMessageData(data: SessionIngestItem['data']) {
  const parsed = kiloSdkMessageSchema.safeParse(data);
  if (!parsed.success) {
    assert.fail(`message item failed schema validation: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

function parsePartData(data: SessionIngestItem['data']) {
  const parsed = kiloSdkPartSchema.safeParse(data);
  if (!parsed.success) {
    assert.fail(`part item failed schema validation: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

void test('cleanup scope is exactly the four fixture session IDs', () => {
  assert.deepEqual(fixtureSessionIds(), [
    ROOT_SESSION_ID,
    CHILD_SESSION_ID,
    UNSUPPORTED_SESSION_ID,
    EMPTY_SESSION_ID,
  ]);
  for (const id of fixtureSessionIds()) {
    assert.match(id, /^ses_/);
    assert.equal(id.length, 30);
  }
});

void test('root fixture items match the session-ingest schemas', () => {
  const items = buildRootIngestItems();
  assert.equal(items.length, 7);

  const session = parseSessionData(singleItemOfType(items, 'session').data);
  assert.equal(session.id, ROOT_SESSION_ID);
  assert.equal(session.slug, 'mobile-sheet-fixtures');
  assert.equal(session.projectID, 'fixture');
  assert.equal(session.directory, '/workspace');
  assert.equal(session.title, ROOT_SESSION_TITLE);
  assert.equal(session.version, '1');
  assert.equal(session.parentID, undefined);

  const messages = itemsOfType(items, 'message').map(item => parseMessageData(item.data));
  assert.equal(messages.length, 2);

  const userMessage = messages.find(message => message.role === 'user');
  assert.ok(userMessage);
  assert.equal(userMessage.id, ROOT_USER_MESSAGE_ID);
  assert.equal(userMessage.sessionID, ROOT_SESSION_ID);
  assert.equal(userMessage.agent, 'build');
  assert.deepEqual(userMessage.model, {
    providerID: 'kilo',
    modelID: 'anthropic/claude-sonnet-4',
  });

  const assistantMessage = messages.find(message => message.role === 'assistant');
  assert.ok(assistantMessage);
  assert.equal(assistantMessage.id, ROOT_ASSISTANT_MESSAGE_ID);
  assert.equal(assistantMessage.parentID, ROOT_USER_MESSAGE_ID);
  assert.equal(assistantMessage.modelID, 'anthropic/claude-sonnet-4');
  assert.equal(assistantMessage.providerID, 'kilo');
  assert.equal(assistantMessage.mode, 'code');
  assert.equal(assistantMessage.agent, 'build');
  assert.deepEqual(assistantMessage.path, { cwd: '/workspace', root: '/workspace' });
  assert.equal(assistantMessage.cost, 0.01);
  assert.deepEqual(assistantMessage.tokens, {
    total: 1375,
    input: 1000,
    output: 200,
    reasoning: 100,
    cache: { read: 50, write: 25 },
  });

  const parts = itemsOfType(items, 'part').map(item => parsePartData(item.data));
  assert.equal(parts.length, 3);

  const readPart = parts.find(part => part.id === ROOT_READ_PART_ID);
  assert.ok(readPart);
  assert.equal(readPart.type, 'tool');
  if (readPart.type === 'tool') {
    assert.equal(readPart.tool, 'read');
    assert.equal(readPart.messageID, ROOT_ASSISTANT_MESSAGE_ID);
    assert.equal(readPart.state.status, 'completed');
    assert.deepEqual(readPart.state.input, { filePath: '/workspace/direct-fixture.txt' });
    assert.equal(readPart.state.output, 'direct fixture output');
  }

  const taskPart = parts.find(part => part.id === ROOT_TASK_PART_ID);
  assert.ok(taskPart);
  assert.equal(taskPart.type, 'tool');
  if (taskPart.type === 'tool') {
    assert.equal(taskPart.tool, 'task');
    assert.equal(taskPart.messageID, ROOT_ASSISTANT_MESSAGE_ID);
    assert.equal(taskPart.state.status, 'completed');
    assert.deepEqual(taskPart.state.input, {
      subagent_type: 'Explorer',
      description: 'Inspect child fixture',
    });
    assert.deepEqual(taskPart.state.metadata, { sessionId: CHILD_SESSION_ID });
  }

  const filePart = parts.find(part => part.id === ROOT_FILE_PART_ID);
  assert.ok(filePart);
  assert.equal(filePart.type, 'file');
  if (filePart.type === 'file') {
    assert.equal(filePart.messageID, ROOT_ASSISTANT_MESSAGE_ID);
    assert.equal(filePart.mime, 'text/plain');
    assert.equal(filePart.filename, 'fixture-notes.txt');
    assert.equal(filePart.url, 'data:text/plain;base64,Zml4dHVyZSBub3RlcyBjb250ZW50');
  }

  const sessionDiff = singleItemOfType(items, 'session_diff');
  assert.equal(sessionDiff.type, 'session_diff');
  assert.ok(Array.isArray(sessionDiff.data));
  assert.deepEqual(sessionDiff.data, [{ file: 'direct-fixture.txt', additions: 1, deletions: 0 }]);
});

void test('child fixture items match the session-ingest schemas', () => {
  const items = buildChildIngestItems();
  assert.equal(items.length, 4);

  const session = parseSessionData(singleItemOfType(items, 'session').data);
  assert.equal(session.id, CHILD_SESSION_ID);
  assert.equal(session.parentID, ROOT_SESSION_ID);
  assert.equal(session.slug, 'inspect-child-fixture');
  assert.equal(session.projectID, 'fixture');
  assert.equal(session.directory, '/workspace');
  assert.equal(session.title, CHILD_SESSION_TITLE);
  assert.equal(session.version, '1');

  const messages = itemsOfType(items, 'message').map(item => parseMessageData(item.data));
  assert.equal(messages.length, 2);

  const userMessage = messages.find(message => message.role === 'user');
  assert.ok(userMessage);
  assert.equal(userMessage.id, CHILD_USER_MESSAGE_ID);
  assert.equal(userMessage.sessionID, CHILD_SESSION_ID);
  assert.equal(userMessage.agent, 'build');
  assert.deepEqual(userMessage.model, {
    providerID: 'kilo',
    modelID: 'anthropic/claude-sonnet-4',
  });

  const assistantMessage = messages.find(message => message.role === 'assistant');
  assert.ok(assistantMessage);
  assert.equal(assistantMessage.id, CHILD_ASSISTANT_MESSAGE_ID);
  assert.equal(assistantMessage.parentID, CHILD_USER_MESSAGE_ID);
  assert.equal(assistantMessage.modelID, 'anthropic/claude-sonnet-4');
  assert.equal(assistantMessage.providerID, 'kilo');
  assert.equal(assistantMessage.mode, 'code');
  assert.equal(assistantMessage.agent, 'build');
  assert.deepEqual(assistantMessage.path, { cwd: '/workspace', root: '/workspace' });
  assert.ok(assistantMessage.cost > 0);
  assert.ok(assistantMessage.tokens.total > 0);
  assert.ok(assistantMessage.tokens.input > 0);
  assert.ok(assistantMessage.tokens.output > 0);
  assert.ok(assistantMessage.tokens.reasoning > 0);

  const parts = itemsOfType(items, 'part').map(item => parsePartData(item.data));
  assert.equal(parts.length, 1);
  const bashPart = parts[0];
  assert.equal(bashPart.id, CHILD_BASH_PART_ID);
  assert.equal(bashPart.type, 'tool');
  if (bashPart.type === 'tool') {
    assert.equal(bashPart.tool, 'bash');
    assert.equal(bashPart.messageID, CHILD_ASSISTANT_MESSAGE_ID);
    assert.equal(bashPart.state.status, 'completed');
    assert.deepEqual(bashPart.state.input, { command: 'printf child-fixture' });
    assert.equal(bashPart.state.output, 'child fixture output');
  }

  assert.deepEqual(expectedPartIdsFor(ROOT_SESSION_ID), [
    ROOT_READ_PART_ID,
    ROOT_TASK_PART_ID,
    ROOT_FILE_PART_ID,
  ]);
  assert.deepEqual(expectedPartIdsFor(CHILD_SESSION_ID), [CHILD_BASH_PART_ID]);
  assert.throws(() => expectedPartIdsFor('ses_unknown'), /Unknown fixture session id/);
});

void test('unsupported fixture items match the session-ingest schemas', () => {
  const items = buildUnsupportedIngestItems();
  assert.equal(items.length, 2);

  const session = parseSessionData(singleItemOfType(items, 'session').data);
  assert.equal(session.id, UNSUPPORTED_SESSION_ID);
  assert.equal(session.slug, 'unsupported-repository-fixture');
  assert.equal(session.projectID, 'fixture');
  assert.equal(session.directory, '/workspace');
  assert.equal(session.title, UNSUPPORTED_SESSION_TITLE);
  assert.equal(session.version, '1');
  assert.equal(session.parentID, undefined);

  const messages = itemsOfType(items, 'message').map(item => parseMessageData(item.data));
  assert.equal(messages.length, 1);
  const userMessage = messages[0];
  assert.equal(userMessage.role, 'user');
  assert.equal(userMessage.id, UNSUPPORTED_USER_MESSAGE_ID);
  assert.equal(userMessage.sessionID, UNSUPPORTED_SESSION_ID);
  assert.equal(userMessage.agent, 'build');
  assert.deepEqual(userMessage.model, {
    providerID: 'kilo',
    modelID: 'anthropic/claude-sonnet-4',
  });

  assert.deepEqual(expectedPartIdsFor(UNSUPPORTED_SESSION_ID), []);
});

void test('empty fixture items match the session-ingest schemas', () => {
  const items = buildEmptyIngestItems();
  assert.equal(items.length, 1);

  const session = parseSessionData(singleItemOfType(items, 'session').data);
  assert.equal(session.id, EMPTY_SESSION_ID);
  assert.equal(session.slug, 'empty-session-fixture');
  assert.equal(session.projectID, 'fixture');
  assert.equal(session.directory, '/workspace');
  assert.equal(session.title, EMPTY_SESSION_TITLE);
  assert.equal(session.version, '1');
  assert.equal(session.parentID, undefined);

  assert.equal(itemsOfType(items, 'message').length, 0);

  assert.deepEqual(expectedPartIdsFor(EMPTY_SESSION_ID), []);
});

void test('status JSON parsing extracts the session-ingest service', () => {
  const up = parseSessionIngestServiceStatus(
    JSON.stringify({
      session: 'kilo-dev',
      portOffset: 0,
      services: [
        { name: 'postgres', status: 'up', port: 5432, group: 'infra' },
        { name: 'cloudflare-session-ingest', status: 'up', port: 8787, group: 'cloud-agent' },
      ],
    })
  );
  assert.deepEqual(up, { name: 'cloudflare-session-ingest', status: 'up', port: 8787 });

  const down = parseSessionIngestServiceStatus(
    JSON.stringify({
      session: 'kilo-dev',
      portOffset: 0,
      services: [
        { name: 'cloudflare-session-ingest', status: 'down', port: 8787, group: 'cloud-agent' },
      ],
    })
  );
  assert.deepEqual(down, { name: 'cloudflare-session-ingest', status: 'down', port: 8787 });

  assert.throws(
    () =>
      parseSessionIngestServiceStatus(
        JSON.stringify({ session: 'kilo-dev', portOffset: 0, services: [] })
      ),
    /did not report the cloudflare-session-ingest service/
  );

  assert.throws(() => parseSessionIngestServiceStatus('not json'), /did not return valid JSON/);
});

function performanceFixture(sessionId: string): ChildPerformanceFixture {
  const fixture = buildChildPerformanceFixtures().find(value => value.sessionId === sessionId);
  assert.ok(fixture);
  return fixture;
}

function storedMessages(fixture: ChildPerformanceFixture) {
  const parts = itemsOfType(fixture.items, 'part').map(item => parsePartData(item.data));
  return itemsOfType(fixture.items, 'message').map(item => {
    const info = parseMessageData(item.data);
    return { info, parts: parts.filter(part => part.messageID === info.id) };
  });
}

function historyResponse(fixture: ChildPerformanceFixture, history: unknown): Response {
  return Response.json({ success: true, kiloSessionId: fixture.sessionId, history });
}

void test('performance fixtures keep deterministic identities, sizes, links, and ingestion order', () => {
  const fixtures = buildChildPerformanceFixtures();
  assert.deepEqual(buildChildPerformanceFixtures(), fixtures);
  assert.equal(fixtures.length, 26);
  assert.equal(
    fixtures.filter(fixture => fixture.parentId === PERFORMANCE_ROOT_SESSION_ID).length,
    24
  );
  assert.equal(performanceFixture(NESTED_CHILD_SESSION_ID).parentId, SELECTED_CHILD_SESSION_ID);
  assert.equal(performanceFixture(EMPTY_CHILD_SESSION_ID).items.length, 1);

  const ids = new Set<string>();
  const sizes: Record<number, number> = {};
  for (const fixture of fixtures) {
    const messages = storedMessages(fixture);
    sizes[messages.length] = (sizes[messages.length] ?? 0) + 1;
    const session = parseSessionData(singleItemOfType(fixture.items, 'session').data);
    assert.equal(session.id, fixture.sessionId);
    assert.equal(session.parentID, fixture.parentId);
    if (fixture.parentId) {
      assert.ok(
        fixtures.findIndex(parent => parent.sessionId === fixture.parentId) <
          fixtures.indexOf(fixture)
      );
    }
    assert.equal(messages.length, fixture.messageCount);
    const messageIds = messages.map(message => message.info.id);
    assert.deepEqual(messageIds, [...messageIds].sort());
    for (const [index, message] of messages.entries()) {
      assert.equal(message.info.sessionID, fixture.sessionId);
      assert.ok(
        message.parts.some(part => part.type === 'text' && part.text.includes('Synthetic'))
      );
      if (index > 0) assert.ok(message.info.time.created > messages[index - 1].info.time.created);
      if (message.info.role === 'assistant') {
        assert.equal(message.info.parentID, messages[index - 1].info.id);
        assert.equal(messages[index - 1].info.role, 'user');
      }
    }

    let stage = 0;
    const ingestedMessages = new Set<string>();
    for (const item of fixture.items) {
      assert.notEqual(item.type, 'session_diff');
      if (item.type === 'session_diff') assert.fail('unexpected session diff');
      assert.equal(typeof item.data.id, 'string');
      if (typeof item.data.id !== 'string') assert.fail('missing fixture identity');
      assert.ok(!ids.has(item.data.id), `duplicate fixture identity: ${item.data.id}`);
      ids.add(item.data.id);
      const nextStage = item.type === 'session' ? 0 : item.type === 'message' ? 1 : 2;
      assert.ok(nextStage >= stage, 'session, messages, and parts must arrive in order');
      stage = nextStage;
      if (item.type === 'message') ingestedMessages.add(item.data.id);
      if (item.type === 'part') {
        const part = parsePartData(item.data);
        assert.equal(part.sessionID, fixture.sessionId);
        assert.ok(ingestedMessages.has(part.messageID));
      }
    }
  }
  assert.deepEqual(sizes, { 0: 1, 2: 1, 12: 22, 120: 2 });
  const selected = storedMessages(performanceFixture(SELECTED_CHILD_SESSION_ID));
  assert.equal(selected[0].info.id, 'msg000000000007ChildPerf000010001');
  assert.equal(selected[119].info.id, 'msg000000000007ChildPerf000010120');
});

void test('task metadata links every direct and nested child with useful mixed states', () => {
  const fixtures = buildChildPerformanceFixtures();
  const linked = new Set<string>();
  const rootStates: Record<string, number> = {};
  for (const fixture of fixtures) {
    for (const item of itemsOfType(fixture.items, 'part')) {
      const part = parsePartData(item.data);
      if (part.type !== 'tool' || part.tool !== 'task') continue;
      assert.notEqual(part.state.status, 'pending');
      if (part.state.status === 'pending') assert.fail('pending task');
      const childSessionId = part.state.metadata?.sessionId;
      const child = fixtures.find(value => value.sessionId === childSessionId);
      assert.ok(child);
      assert.equal(child.parentId, fixture.sessionId);
      assert.equal(part.state.input.description, child.title);
      assert.equal(part.state.input.subagent_type, 'Explorer');
      assert.equal(part.state.input.prompt, `Inspect synthetic fixture ${child.sessionId}.`);
      assert.ok(!linked.has(child.sessionId));
      linked.add(child.sessionId);
      if (part.state.status === 'error') {
        assert.ok(part.state.error.includes('Synthetic'));
      } else {
        assert.equal(part.state.title, child.title);
      }
      if (part.state.status === 'running') {
        assert.ok(!('end' in part.state.time));
        assert.ok(!('output' in part.state));
      } else {
        assert.ok(part.state.time.end > part.state.time.start);
      }
      if (fixture.sessionId === PERFORMANCE_ROOT_SESSION_ID) {
        rootStates[part.state.status] = (rootStates[part.state.status] ?? 0) + 1;
      }
    }
  }
  assert.equal(linked.size, 25);
  assert.ok(linked.has(NESTED_CHILD_SESSION_ID));
  assert.ok(linked.has(EMPTY_CHILD_SESSION_ID));
  assert.deepEqual(rootStates, { completed: 9, running: 8, error: 7 });
});

void test('cleanup owns exactly the selected fixtures and deletes descendants first', () => {
  assert.deepEqual(fixtureCleanupSessionIds(), [
    CHILD_SESSION_ID,
    ROOT_SESSION_ID,
    UNSUPPORTED_SESSION_ID,
    EMPTY_SESSION_ID,
  ]);
  const fixtures = buildChildPerformanceFixtures();
  const cleanup = fixtureCleanupSessionIds(true);
  assert.equal(cleanup.length, 30);
  assert.equal(new Set(cleanup).size, 30);
  assert.deepEqual(
    new Set(cleanup),
    new Set([...fixtureSessionIds(), ...fixtures.map(fixture => fixture.sessionId)])
  );
  assert.deepEqual(new Set(fixtureSessionIds(true)), new Set(cleanup));
  for (const fixture of fixtures) {
    assert.ok(!fixtureSessionIds().includes(fixture.sessionId));
    if (fixture.parentId) {
      assert.ok(cleanup.indexOf(fixture.sessionId) < cleanup.indexOf(fixture.parentId));
    }
  }
});

void test('default JSON stays unchanged and opt-in JSON preserves every existing field', () => {
  const context = {
    userId: 'fixture-user',
    email: 'fixture@example.com',
    usedRepository: 'fixture-owner/fixture-repo',
    sessionIngestPort: 12345,
    sessionIngestUrl: 'http://localhost:12345',
  };
  const expected = {
    userId: 'fixture-user',
    email: 'fixture@example.com',
    rootSessionId: 'ses_000000000001RootFixture001',
    childSessionId: 'ses_000000000002ChildFixture01',
    unsupportedSessionId: 'ses_000000000003Unsupported001',
    emptySessionId: 'ses_000000000004EmptyFixture01',
    usedRepository: 'fixture-owner/fixture-repo',
    sessionIngestPort: 12345,
    sessionIngestUrl: 'http://localhost:12345',
  };
  assert.equal(JSON.stringify(buildMobileSheetFixtureResult(context)), JSON.stringify(expected));
  assert.deepEqual(buildMobileSheetFixtureResult(context, false), expected);
  const result = buildMobileSheetFixtureResult(context, true);
  for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value);
  assert.equal(Object.keys(result).length, 17);
  assert.equal(typeof result.performanceChildSessionIds, 'string');
  if (typeof result.performanceChildSessionIds !== 'string') assert.fail('missing child IDs');
  const fixtures = buildChildPerformanceFixtures();
  const directChildren = fixtures.filter(
    fixture => fixture.parentId === result.performanceRootSessionId
  );
  assert.deepEqual(
    result.performanceChildSessionIds.split(','),
    directChildren.map(fixture => fixture.sessionId)
  );
  assert.equal(result.performanceChildCount, directChildren.length);
  assert.equal(
    result.pagedChildMessageCount,
    storedMessages(performanceFixture(String(result.selectedChildSessionId))).length
  );
  assert.equal(
    result.pagedChildMessageCount,
    storedMessages(performanceFixture(String(result.nestedChildSessionId))).length
  );
  assert.equal(storedMessages(performanceFixture(String(result.emptyChildSessionId))).length, 0);
  assert.equal(result.ordinaryChildMessageCount, storedMessages(directChildren[1]).length);
  assert.deepEqual(buildMobileSheetFixtureResult(context), expected);
});

void test('materialization follows independent older cursors for both paged children', async t => {
  const fixtures = [
    performanceFixture(SELECTED_CHILD_SESSION_ID),
    performanceFixture(NESTED_CHILD_SESSION_ID),
  ];
  let now = 0;
  t.mock.method(Date, 'now', () => (now += 30_000));
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const fixture = fixtures.find(
      value => url.pathname === `/api/session/${value.sessionId}/messages`
    );
    assert.ok(fixture);
    const messages = storedMessages(fixture);
    const cursor = url.searchParams.get('before');
    if (url.searchParams.get('limit') !== '50')
      return historyResponse(fixture, { kind: 'invalid_data' });
    if (cursor === null) {
      return historyResponse(fixture, {
        messages: messages.slice(70),
        nextCursor: `${fixture.sessionId}:70/+`,
      });
    }
    if (cursor === `${fixture.sessionId}:70/+`) {
      return historyResponse(fixture, {
        messages: messages.slice(20, 70),
        nextCursor: `${fixture.sessionId}:20/+`,
      });
    }
    if (cursor === `${fixture.sessionId}:20/+`) {
      return historyResponse(fixture, { messages: messages.slice(0, 20), nextCursor: null });
    }
    return historyResponse(fixture, { kind: 'invalid_data' });
  });
  for (const fixture of fixtures) {
    await assert.doesNotReject(
      pollForChildPerformanceFixture('http://fixture.invalid', 'synthetic-token', fixture)
    );
  }
});

for (const sessionId of [SELECTED_CHILD_SESSION_ID, NESTED_CHILD_SESSION_ID]) {
  void test(`materialization rejects a paged child without an older cursor: ${sessionId}`, async t => {
    const fixture = performanceFixture(sessionId);
    let now = 0;
    t.mock.method(Date, 'now', () => (now += 30_000));
    t.mock.method(globalThis, 'fetch', async () =>
      historyResponse(fixture, {
        messages: storedMessages(fixture),
        nextCursor: null,
      })
    );
    await assert.rejects(
      pollForChildPerformanceFixture('http://fixture.invalid', 'synthetic-token', fixture),
      /Timed out/
    );
  });
}

void test('materialization waits through pending, retryable failure, and missing parts', async t => {
  const fixture = buildChildPerformanceFixtures()[2];
  const messages = storedMessages(fixture);
  const histories = [
    null,
    { kind: 'retryable_failure', phase: 'page_parts' },
    { messages: messages.map(message => ({ ...message, parts: [] })), nextCursor: null },
    { messages, nextCursor: null },
  ];
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  t.mock.method(globalThis, 'fetch', async () => historyResponse(fixture, histories.shift()));
  let outcome: unknown = 'pending';
  const polling = pollForChildPerformanceFixture(
    'http://fixture.invalid',
    'synthetic-token',
    fixture
  ).then(
    () => {
      outcome = 'ready';
    },
    error => {
      outcome = error;
    }
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await setImmediate();
    assert.equal(outcome, 'pending');
    t.mock.timers.tick(500);
  }
  await polling;
  assert.equal(outcome, 'ready');
});

void test('empty child readiness requires a successful empty history, not null staging', async t => {
  const fixture = performanceFixture(EMPTY_CHILD_SESSION_ID);
  let materialized = false;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  t.mock.method(globalThis, 'fetch', async () =>
    historyResponse(
      fixture,
      materialized ? { messages: [], nextCursor: null, omittedItemCount: 0 } : null
    )
  );
  let outcome: unknown = 'pending';
  const polling = pollForChildPerformanceFixture(
    'http://fixture.invalid',
    'synthetic-token',
    fixture
  ).then(
    () => {
      outcome = 'ready';
    },
    error => {
      outcome = error;
    }
  );
  await setImmediate();
  assert.equal(outcome, 'pending');
  materialized = true;
  t.mock.timers.tick(500);
  await polling;
  assert.equal(outcome, 'ready');
});

void test('materialization rejects unusable responses and incomplete or corrupt histories', async t => {
  const fixture = buildChildPerformanceFixtures()[2];
  const messages = storedMessages(fixture);
  const page = { messages, nextCursor: null };
  const cases = [
    {
      name: 'HTTP denial',
      response: () => new Response(null, { status: 403 }),
      error: /failed \(403\)/,
    },
    {
      name: 'wrong content type',
      response: () => new Response('<html>not history</html>'),
      error: /application\/json/,
    },
    {
      name: 'invalid JSON',
      response: () => new Response('{', { headers: { 'content-type': 'application/json' } }),
      error: /JSON/,
    },
    {
      name: 'wrong session',
      response: () =>
        Response.json({ success: true, kiloSessionId: ROOT_SESSION_ID, history: page }),
      error: /unexpected shape/,
    },
    {
      name: 'invalid history shape',
      response: () => historyResponse(fixture, { messages: 'not messages', nextCursor: null }),
      error: /unexpected history shape/,
    },
    {
      name: 'terminal invalid data',
      response: () => historyResponse(fixture, { kind: 'invalid_data' }),
      error: /invalid_data/,
    },
    {
      name: 'terminal oversized data',
      response: () =>
        historyResponse(fixture, { kind: 'too_large', maximumBytes: 1, phase: 'page_parts' }),
      error: /too_large/,
    },
    {
      name: 'omitted items',
      response: () => historyResponse(fixture, { ...page, omittedItemCount: 1 }),
      error: /omitted/,
    },
    {
      name: 'missing messages',
      response: () => historyResponse(fixture, { ...page, messages: messages.slice(1) }),
      error: /Timed out/,
    },
    {
      name: 'missing parts',
      response: () =>
        historyResponse(fixture, {
          ...page,
          messages: messages.map(message => ({ ...message, parts: [] })),
        }),
      error: /Timed out/,
    },
    {
      name: 'wrong message owner',
      response: () =>
        historyResponse(fixture, {
          ...page,
          messages: messages.map(message => ({
            ...message,
            info: { ...message.info, sessionID: ROOT_SESSION_ID },
          })),
        }),
      error: /Unexpected or duplicate message/,
    },
    {
      name: 'duplicate message',
      response: () => historyResponse(fixture, { ...page, messages: [...messages, messages[0]] }),
      error: /duplicate message/,
    },
    {
      name: 'wrong part parent',
      response: () =>
        historyResponse(fixture, {
          ...page,
          messages: messages.map(message => ({
            ...message,
            parts: message.parts.map(part => ({ ...part, messageID: 'msgWrongParent' })),
          })),
        }),
      error: /part relationship/,
    },
    {
      name: 'repeated cursor',
      response: () => historyResponse(fixture, { messages: [], nextCursor: 'repeated' }),
      error: /repeated history cursor/,
    },
  ];
  let now = 0;
  t.mock.method(Date, 'now', () => (now += 30_000));
  for (const scenario of cases) {
    t.mock.method(globalThis, 'fetch', async () => scenario.response());
    await assert.rejects(
      pollForChildPerformanceFixture('http://fixture.invalid', 'synthetic-token', fixture),
      scenario.error,
      scenario.name
    );
  }
});
