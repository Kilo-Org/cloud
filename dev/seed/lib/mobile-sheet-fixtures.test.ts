import assert from 'node:assert/strict';
import test from 'node:test';

import {
  kiloSdkMessageSchema,
  kiloSdkPartSchema,
  kiloSdkSessionInfoSchema,
} from '@kilocode/session-ingest-contracts';

import {
  buildChildIngestItems,
  buildRootIngestItems,
  CHILD_ASSISTANT_MESSAGE_ID,
  CHILD_BASH_PART_ID,
  CHILD_SESSION_ID,
  CHILD_SESSION_TITLE,
  CHILD_USER_MESSAGE_ID,
  expectedPartIdsFor,
  fixtureSessionIds,
  parseSessionIngestServiceStatus,
  ROOT_ASSISTANT_MESSAGE_ID,
  ROOT_FILE_PART_ID,
  ROOT_READ_PART_ID,
  ROOT_SESSION_ID,
  ROOT_SESSION_TITLE,
  ROOT_TASK_PART_ID,
  ROOT_USER_MESSAGE_ID,
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

void test('cleanup scope is exactly the two fixture session IDs', () => {
  assert.deepEqual(fixtureSessionIds(), [ROOT_SESSION_ID, CHILD_SESSION_ID]);
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
