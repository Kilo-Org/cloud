import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createKiloClient,
  type GlobalEvent,
  type Message,
  type Part,
  type Session,
} from '@kilocode/sdk/v2';
import {
  DRIVER_USER_EMAIL_SUFFIX,
  ensureTestUser,
  loadDevVars,
  loadRepoEnvFiles,
  mintApiToken,
} from './auth.js';
import {
  DEFAULT_CONFIG,
  openStream,
  releaseGate,
  startSession,
  waitForGateEngaged,
  type DriverConfig,
} from './client.js';
import { createMessageId } from '../../src/session/message-id.js';
import {
  killSandboxFamily,
  listSandboxesForAgentSession,
  sandboxFamilyKey,
  waitForSandboxFamilyGone,
  waitForSandboxForAgentSession,
  type SandboxContainer,
} from './sandbox-control.js';

const SERVICE_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const READ_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 90_000;
const PUBLIC_DIRECTORY_PREFIX = '/cloud-agent/sessions/';

type MessageEntry = {
  info: Message;
  parts: Part[];
};

type SdkResult<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};

function requireData<T>(result: SdkResult<T>, action: string): T {
  assert.equal(
    result.error,
    undefined,
    `${action} returned an SDK error: ${JSON.stringify(result.error)}`
  );
  if (result.data === undefined) {
    throw new Error(`${action} returned no data`);
  }
  return result.data;
}

function publicDirectory(sessionID: string): string {
  return `${PUBLIC_DIRECTORY_PREFIX}${sessionID}`;
}

function assertSafeProjection(value: unknown, action: string): void {
  const encoded = JSON.stringify(value);
  assert.equal(encoded.includes('/workspace/'), false, `${action} leaked /workspace/ path state`);
  assert.equal(encoded.includes('/home/agent_'), false, `${action} leaked sandbox home path state`);
}

function assertProjectedSession(session: Session, sessionID: string, action: string): void {
  assert.equal(session.id, sessionID, `${action} returned an unexpected root session`);
  assert.equal(
    session.directory,
    publicDirectory(sessionID),
    `${action} returned private directory state`
  );
  assert.equal(session.path, undefined, `${action} returned an optional private Session.path`);
  assertSafeProjection(session, action);
}

function textFromParts(parts: Part[]): string {
  return parts
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('');
}

function findAssistantWithText(
  messages: MessageEntry[],
  expectedText: string
): MessageEntry | undefined {
  return messages.find(
    entry => entry.info.role === 'assistant' && textFromParts(entry.parts).includes(expectedText)
  );
}

function assertProjectedAssistant(entry: MessageEntry, directory: string, action: string): void {
  assert.equal(entry.info.role, 'assistant', `${action} did not return an assistant message`);
  if (entry.info.role !== 'assistant') return;
  assert.equal(entry.info.path.cwd, directory, `${action} exposed assistant cwd`);
  assert.equal(entry.info.path.root, directory, `${action} exposed assistant root`);
  assertSafeProjection(entry, action);
}

async function pollFor<T>(
  action: () => Promise<T | undefined>,
  label: string,
  timeoutMs = TURN_TIMEOUT_MS
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await action();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${label} did not become available within ${timeoutMs}ms`);
}

async function nextEvent<T>(
  stream: AsyncGenerator<T, unknown, unknown>,
  label: string,
  timeoutMs = READ_TIMEOUT_MS
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      stream.next(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
    if (result.done) throw new Error(`${label} closed before yielding an event`);
    return result.value;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForEvent<T>(
  stream: AsyncGenerator<T, unknown, unknown>,
  label: string,
  predicate: (event: T) => boolean,
  timeoutMs = TURN_TIMEOUT_MS
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = await nextEvent(stream, label, deadline - Date.now());
    if (predicate(event)) return event;
  }
  throw new Error(`${label} did not yield a matching event within ${timeoutMs}ms`);
}

function isCloudAgentQueuedExtensionEvent(
  event: unknown,
  sessionID: string,
  messageID: string
): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const candidate = event as { type?: unknown; properties?: unknown };
  if (candidate.type !== 'cloud.message.queued') return false;
  if (typeof candidate.properties !== 'object' || candidate.properties === null) return false;
  const properties = candidate.properties as { sessionID?: unknown; messageId?: unknown };
  return properties.sessionID === sessionID && properties.messageId === messageID;
}

function isCorrelatedAssistantWakeEvent(
  event: GlobalEvent['payload'],
  sessionID: string,
  messageID: string
): boolean {
  if (event.type !== 'message.updated') return false;
  return (
    event.properties.sessionID === sessionID &&
    event.properties.info.role === 'assistant' &&
    event.properties.info.parentID === messageID
  );
}

function isProjectedGlobalWakeEvent(
  event: GlobalEvent,
  sessionID: string,
  messageID: string
): boolean {
  if (event.directory !== publicDirectory(sessionID)) return false;
  return isCorrelatedAssistantWakeEvent(event.payload, sessionID, messageID);
}

function assertProjectedWakeEvent(
  event: GlobalEvent['payload'],
  sessionID: string,
  action: string
): void {
  assert.equal(event.type, 'message.updated', `${action} did not carry an assistant wake event`);
  if (event.type !== 'message.updated') return;
  assert.equal(event.properties.sessionID, sessionID, `${action} returned an unexpected session`);
  assert.equal(
    event.properties.info.role,
    'assistant',
    `${action} did not return an assistant message`
  );
}

function trackSandboxFamily(
  ownedSandboxFamilies: Map<string, SandboxContainer>,
  sandbox: SandboxContainer
): void {
  ownedSandboxFamilies.set(sandboxFamilyKey(sandbox), sandbox);
}

async function discoverOwnedSandboxFamilies(
  cloudAgentSessionID: string,
  ownedSandboxFamilies: Map<string, SandboxContainer>
): Promise<void> {
  const sandboxes = await listSandboxesForAgentSession(cloudAgentSessionID);
  for (const sandbox of sandboxes) trackSandboxFamily(ownedSandboxFamilies, sandbox);
}

async function stopOwnedSandboxFamilies(
  cloudAgentSessionID: string | undefined,
  ownedSandboxFamilies: Map<string, SandboxContainer>
): Promise<void> {
  if (cloudAgentSessionID) {
    await discoverOwnedSandboxFamilies(cloudAgentSessionID, ownedSandboxFamilies);
  }
  for (const [key, sandbox] of ownedSandboxFamilies) {
    await killSandboxFamily(sandbox);
    assert.equal(
      await waitForSandboxFamilyGone(sandbox, READ_TIMEOUT_MS),
      true,
      `sandbox family ${key} did not stop`
    );
    ownedSandboxFamilies.delete(key);
  }
}

async function main(): Promise<void> {
  loadRepoEnvFiles(SERVICE_PACKAGE_DIR);
  const devVars = loadDevVars(SERVICE_PACKAGE_DIR);
  const email = `kilo-sdk-basic-chat-${Date.now()}${DRIVER_USER_EMAIL_SUFFIX}`;
  const user = await ensureTestUser(process.env.DATABASE_URL, email, { funded: true });
  const config: DriverConfig = {
    ...DEFAULT_CONFIG,
    user,
    nextAuthSecret: devVars.NEXTAUTH_SECRET ?? '',
    workerUrl: process.env.WORKER_URL ?? DEFAULT_CONFIG.workerUrl,
    gitUrl: process.env.E2E_GIT_URL ?? DEFAULT_CONFIG.gitUrl,
    model: process.env.E2E_MODEL ?? DEFAULT_CONFIG.model,
  };
  const bearer = mintApiToken(user, config.nextAuthSecret);
  const client = createKiloClient({
    baseUrl: `${config.workerUrl.replace(/\/$/, '')}/kilo`,
    headers: { Authorization: `Bearer ${bearer}` },
  });
  const ownedSandboxFamilies = new Map<string, SandboxContainer>();
  const gateTag = `sdk-abort-${randomUUID()}`;
  const rejectedDirectoryMessageID = createMessageId();
  const rejectedWorkspaceMessageID = createMessageId();
  let cloudAgentSessionID: string | undefined;
  let sessionID: string | undefined;
  let directory: string | undefined;
  const scopedAbort = new AbortController();
  const globalAbort = new AbortController();

  try {
    const lifecycleStreamPromise = (async () => {
      const created = await startSession(config, { prompt: '__fake__:echo:bootstrap' });
      cloudAgentSessionID = created.cloudAgentSessionId;
      sessionID = created.kiloSessionId;
      directory = publicDirectory(created.kiloSessionId);
      const stream = openStream(config, created.cloudAgentSessionId);
      const terminal = await stream.waitForTerminal(TURN_TIMEOUT_MS);
      stream.close();
      assert.notEqual(terminal, null, 'lifecycle setup turn did not terminalize');
      return created;
    })();
    const root = await lifecycleStreamPromise;
    const initialSandbox = await waitForSandboxForAgentSession(
      root.cloudAgentSessionId,
      TURN_TIMEOUT_MS
    );
    assert.notEqual(initialSandbox, null, 'lifecycle setup did not start an owned sandbox');
    if (initialSandbox) trackSandboxFamily(ownedSandboxFamilies, initialSandbox);
    assert.notEqual(sessionID, undefined);
    assert.notEqual(directory, undefined);
    if (!sessionID || !directory) throw new Error('lifecycle setup did not provide root identity');
    const rootSessionID = sessionID;
    const rootDirectory = directory;

    const listedRoot = await pollFor(async () => {
      const result = await client.session.list({ limit: 10 });
      const sessions = requireData(result, 'session.list()');
      return sessions.find(session => session.id === rootSessionID);
    }, 'materialized root session list row');
    assertProjectedSession(listedRoot, rootSessionID, 'session.list()');

    const warmSession = requireData(
      await client.session.get({ sessionID: rootSessionID }),
      'warm session.get()'
    );
    assertProjectedSession(warmSession, rootSessionID, 'warm session.get()');

    const warmBootstrapMessages = await pollFor(async () => {
      const messages = requireData(
        await client.session.messages({ sessionID: rootSessionID, limit: 20 }),
        'warm session.messages()'
      );
      return findAssistantWithText(messages, 'bootstrap') ? messages : undefined;
    }, 'warm bootstrap transcript');
    const warmBootstrapAssistant = findAssistantWithText(warmBootstrapMessages, 'bootstrap');
    assert.notEqual(warmBootstrapAssistant, undefined);
    if (warmBootstrapAssistant) {
      assertProjectedAssistant(warmBootstrapAssistant, rootDirectory, 'warm session.messages()');
    }

    await stopOwnedSandboxFamilies(root.cloudAgentSessionId, ownedSandboxFamilies);

    const coldSession = requireData(
      await client.session.get({ sessionID: rootSessionID }),
      'cold session.get()'
    );
    assertProjectedSession(coldSession, rootSessionID, 'cold session.get()');
    const coldBootstrapMessages = requireData(
      await client.session.messages({ sessionID: rootSessionID, limit: 20 }),
      'cold session.messages()'
    );
    const coldBootstrapAssistant = findAssistantWithText(coldBootstrapMessages, 'bootstrap');
    assert.notEqual(
      coldBootstrapAssistant,
      undefined,
      'cold transcript omitted bootstrap response'
    );
    if (coldBootstrapAssistant) {
      assertProjectedAssistant(coldBootstrapAssistant, rootDirectory, 'cold session.messages()');
    }

    const scopedEvents = await client.event.subscribe(
      { directory: rootDirectory },
      { signal: scopedAbort.signal }
    );
    const globalEvents = await client.global.event({ signal: globalAbort.signal });
    const scopedConnected = await nextEvent(scopedEvents.stream, 'scoped event connection');
    const globalConnected = await nextEvent(globalEvents.stream, 'global event connection');
    assert.equal(scopedConnected.type, 'server.connected');
    assert.equal(globalConnected.payload.type, 'server.connected');
    assert.equal(globalConnected.directory, '/cloud-agent');

    const asyncMessageID = createMessageId();
    const scopedQueuedEvent = waitForEvent(
      scopedEvents.stream,
      'scoped Cloud Agent queued extension stream',
      event => isCloudAgentQueuedExtensionEvent(event, rootSessionID, asyncMessageID)
    );
    const globalQueuedEvent = waitForEvent(
      globalEvents.stream,
      'global Cloud Agent queued extension stream',
      event =>
        event.directory === rootDirectory &&
        isCloudAgentQueuedExtensionEvent(event.payload, rootSessionID, asyncMessageID)
    );
    const asyncAdmission = await client.session.promptAsync({
      sessionID: rootSessionID,
      directory: rootDirectory,
      messageID: asyncMessageID,
      parts: [{ type: 'text', text: '__fake__:echo:async-result' }],
    });
    assert.equal(asyncAdmission.response.status, 204, 'promptAsync() was not accepted');
    assert.equal(asyncAdmission.error, undefined, 'promptAsync() returned an SDK error');
    await Promise.all([scopedQueuedEvent, globalQueuedEvent]);
    const scopedWakeEvent = waitForEvent(scopedEvents.stream, 'scoped event wake stream', event =>
      isCorrelatedAssistantWakeEvent(event, rootSessionID, asyncMessageID)
    );
    const globalWakeEvent = waitForEvent(globalEvents.stream, 'global event wake stream', event =>
      isProjectedGlobalWakeEvent(event, rootSessionID, asyncMessageID)
    );
    const [scopedProjectedEvent, globalProjectedEvent] = await Promise.all([
      scopedWakeEvent,
      globalWakeEvent,
    ]);
    assertProjectedWakeEvent(scopedProjectedEvent, rootSessionID, 'scoped wake event');
    assertProjectedWakeEvent(globalProjectedEvent.payload, rootSessionID, 'global wake event');

    const asyncMessages = await pollFor(async () => {
      const messages = requireData(
        await client.session.messages({ sessionID: rootSessionID, limit: 20 }),
        'promptAsync result messages()'
      );
      return findAssistantWithText(messages, 'async-result') ? messages : undefined;
    }, 'promptAsync assistant result');
    const asyncAssistant = findAssistantWithText(asyncMessages, 'async-result');
    assert.notEqual(asyncAssistant, undefined);
    if (asyncAssistant) {
      assert.equal(asyncAssistant.info.role, 'assistant');
      if (asyncAssistant.info.role === 'assistant') {
        assert.equal(
          asyncAssistant.info.parentID,
          asyncMessageID,
          'promptAsync transcript lost correlation'
        );
      }
      assertProjectedAssistant(asyncAssistant, rootDirectory, 'promptAsync result');
    }

    const unsupportedSyncMessageID = createMessageId();
    const unsupportedSyncPrompt = await client.session.prompt({
      sessionID: rootSessionID,
      messageID: unsupportedSyncMessageID,
      parts: [{ type: 'text', text: '__fake__:echo:unsupported-sync-result' }],
    });
    assert.equal(
      unsupportedSyncPrompt.response.status,
      501,
      'blocking prompt() was not rejected as unsupported'
    );
    assert.notEqual(
      unsupportedSyncPrompt.error,
      undefined,
      'blocking prompt() did not return an SDK error'
    );
    const afterUnsupportedSync = requireData(
      await client.session.messages({ sessionID: rootSessionID, limit: 20 }),
      'messages after unsupported blocking prompt()'
    );
    assert.equal(
      findAssistantWithText(afterUnsupportedSync, 'unsupported-sync-result'),
      undefined,
      'blocking prompt() unexpectedly produced a reply'
    );
    assert.equal(
      afterUnsupportedSync.some(message => message.info.id === unsupportedSyncMessageID),
      false,
      'blocking prompt() unexpectedly admitted its user message'
    );

    const warmFirstPageResult = await client.session.messages({
      sessionID: rootSessionID,
      limit: 2,
    });
    const warmFirstPage = requireData(warmFirstPageResult, 'warm first messages page');
    const nextCursor = warmFirstPageResult.response.headers.get('x-next-cursor');
    assert.notEqual(nextCursor, null, 'warm first page did not expose a continuation cursor');
    const warmSecondPage = requireData(
      await client.session.messages({
        sessionID: rootSessionID,
        limit: 2,
        before: nextCursor ?? undefined,
      }),
      'warm second messages page'
    );
    const warmPageIDs = [...warmFirstPage, ...warmSecondPage].map(entry => entry.info.id);

    await stopOwnedSandboxFamilies(root.cloudAgentSessionId, ownedSandboxFamilies);
    const coldFirstPageResult = await client.session.messages({
      sessionID: rootSessionID,
      limit: 2,
    });
    const coldFirstPage = requireData(coldFirstPageResult, 'cold first messages page');
    const coldCursor = coldFirstPageResult.response.headers.get('x-next-cursor');
    assert.equal(coldCursor, nextCursor, 'cold first page returned a different cursor');
    const coldSecondPage = requireData(
      await client.session.messages({
        sessionID: rootSessionID,
        limit: 2,
        before: coldCursor ?? undefined,
      }),
      'cold second messages page'
    );
    assert.deepEqual(
      [...coldFirstPage, ...coldSecondPage].map(entry => entry.info.id),
      warmPageIDs,
      'cold pagination returned a different message chronology'
    );

    const matchingSelectorRead = requireData(
      await client.session.get({ sessionID: rootSessionID, directory: rootDirectory }),
      'matching directory session.get()'
    );
    assertProjectedSession(matchingSelectorRead, rootSessionID, 'matching directory session.get()');

    const rejectedDirectory = await client.session.promptAsync({
      sessionID: rootSessionID,
      directory: `${PUBLIC_DIRECTORY_PREFIX}ses_not_the_owned_root`,
      messageID: rejectedDirectoryMessageID,
      parts: [{ type: 'text', text: '__fake__:echo:must-not-run' }],
    });
    assert.equal(
      rejectedDirectory.response.status,
      400,
      'mismatching directory prompt did not fail'
    );
    assert.notEqual(
      rejectedDirectory.error,
      undefined,
      'mismatching directory prompt had no SDK error'
    );
    const rejectedWorkspace = await client.session.promptAsync({
      sessionID: rootSessionID,
      workspace: 'private-workspace',
      messageID: rejectedWorkspaceMessageID,
      parts: [{ type: 'text', text: '__fake__:echo:must-not-run' }],
    });
    assert.equal(rejectedWorkspace.response.status, 400, 'workspace prompt did not fail');
    assert.notEqual(rejectedWorkspace.error, undefined, 'workspace prompt had no SDK error');

    const gateMessageID = createMessageId();
    const gateAdmission = await client.session.promptAsync({
      sessionID: rootSessionID,
      directory: rootDirectory,
      messageID: gateMessageID,
      parts: [{ type: 'text', text: `__fake__:gate:${gateTag}` }],
    });
    assert.equal(gateAdmission.response.status, 204, 'gated prompt was not accepted');
    assert.equal(
      await waitForGateEngaged(config, gateTag, TURN_TIMEOUT_MS),
      true,
      'gated prompt did not become active'
    );
    const rejectedAbort = await client.session.abort({
      sessionID: rootSessionID,
      workspace: 'private-workspace',
    });
    assert.equal(rejectedAbort.response.status, 400, 'mismatching workspace abort did not fail');
    assert.equal(
      await waitForGateEngaged(config, gateTag, 2_000),
      true,
      'mismatching abort interrupted the active turn'
    );
    const aborted = requireData(
      await client.session.abort({ sessionID: rootSessionID, directory: rootDirectory }),
      'matching directory abort()'
    );
    assert.equal(aborted, true, 'abort() did not report successful interruption');

    const finalMessages = await pollFor(async () => {
      const messages = requireData(
        await client.session.messages({ sessionID: rootSessionID, limit: 100 }),
        'final session.messages()'
      );
      return messages.some(entry => entry.info.id === gateMessageID) ? messages : undefined;
    }, 'aborted turn transcript visibility');
    assert.equal(
      finalMessages.some(entry => entry.info.id === rejectedDirectoryMessageID),
      false,
      'mismatching directory prompt mutated the transcript'
    );
    assert.equal(
      finalMessages.some(entry => entry.info.id === rejectedWorkspaceMessageID),
      false,
      'workspace prompt mutated the transcript'
    );

    console.log(`sdk-basic-chat: passed for ${root.kiloSessionId} (${user.email})`);
  } finally {
    scopedAbort.abort();
    globalAbort.abort();
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
    if (sessionID && directory) {
      await client.session.abort({ sessionID, directory }).catch(() => undefined);
    }
    await stopOwnedSandboxFamilies(cloudAgentSessionID, ownedSandboxFamilies).catch(error => {
      console.warn(`sdk-basic-chat: sandbox cleanup failed: ${String(error)}`);
    });
  }
}

main().catch(error => {
  console.error('sdk-basic-chat failed:', error);
  process.exit(1);
});
