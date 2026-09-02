/**
 * Lifecycle scenarios. Each scenario composes the client + sandbox primitives
 * to drive the wrapper boot / reuse / kill paths. The conversation dimension
 * (echo, slow, gate, hang, ...) is handled by the fake LLM gateway via the
 * directive embedded in the prompt.
 */

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  and,
  cli_sessions_v2,
  computeDatabaseUrl,
  createDrizzleClient,
  eq,
  inArray,
} from '@kilocode/db';
import { createKiloClient, type Message, type Part } from '@kilocode/sdk/v2';
import {
  answerQuestion,
  createWorktreeChat,
  deleteSession,
  fetchFakeRequests,
  fetchFakeScenarioStatus,
  fetchFakeWaiters,
  getMessageResult,
  getSessionSnapshot,
  interruptSession,
  isMessageCompleted,
  messageIdFromEvent,
  openStream,
  prepareBrowserSession,
  releaseGate,
  sendMessage,
  startSession,
  waitForGateEngaged,
  type ApiVersion,
  type DriverConfig,
  type StreamConnection,
  type StreamEvent,
  type WorktreeSessionResult,
} from './client.js';
import { mintApiToken } from './auth.js';
import { startCallbackServer, type CallbackServerHandle } from './callback-server.js';
import { createMessageId } from '../../src/session/message-id.js';
import { generateKiloSessionId } from '../../src/utils/kilo-session-id.js';
import {
  controlPlaneKiloRootExists,
  importControlPlaneKiloRoot,
  inspectControlPlaneKiloRoot,
  inspectControlPlaneQuestions,
  inspectControlPlaneWorkspaceFile,
  killSandboxFamily,
  listSandboxContainers,
  listSandboxesForAgentSession,
  promptControlPlaneKiloRoot,
  sandboxFamilyKey,
  stopOwnedControlPlaneSandbox,
  readKiloCliLog,
  readWrapperLog,
  tailLines,
  waitForControlPlaneKiloCompletion,
  waitForControlPlaneKiloRuntime,
  waitForNewSandboxPresent,
  waitForSandboxFamilyGone,
  type ControlPlaneKiloRuntime,
  type SandboxContainer,
} from './sandbox-control.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type ConversationScenario = string; // e.g. "echo:hi", "tools:3", "hang"

export type LifecycleResult = {
  name: string;
  conversation: string;
  ok: boolean;
  message: string;
  events: StreamEvent[];
  durationMs: number;
};

export type LifecycleArgs = {
  config: DriverConfig;
  conversation: ConversationScenario;
  /**
   * Which tRPC API surface to exercise. Defaults to the current unified
   * `start` / `send` procedures. Pass `'legacy'` to drive the
   * `prepareSession` + `initiateFromKilocodeSessionV2` + `sendMessageV2`
   * surface the web UI still uses.
   */
  api?: ApiVersion;
  /**
   * Overall per-scenario timeout. Conservative default for cold-boot paths.
   * 120s gives margin over the wrapper startup path (3 attempts × 30s
   * waitForPort) plus ensureSessionReady, which can collectively approach 90s
   * under Docker contention.
   */
  timeoutMs?: number;
};

function fakeDirective(conversation: ConversationScenario): string {
  return `__fake__:${conversation}`;
}

async function collectUntilTerminal(
  stream: ReturnType<typeof openStream>,
  messageId: string,
  timeoutMs: number
): Promise<{ terminal: StreamEvent | null; events: StreamEvent[] }> {
  const terminal = await stream.waitForTerminal(timeoutMs, messageId);
  return { terminal, events: [...stream.events] };
}

function hasPreparationForMessage(events: StreamEvent[], messageId: string): boolean {
  return events.some(
    event => event.streamEventType === 'preparing' && event.data.triggerMessageId === messageId
  );
}

async function openConnectedStream(config: DriverConfig, sessionId: string, replay = true) {
  const stream = openStream(config, sessionId, { replay });
  const connected = await stream.waitFor(event => event.streamEventType === 'connected', 10_000);
  if (!connected) {
    stream.close();
    throw new Error(`Stream did not connect for ${sessionId}`);
  }
  return stream;
}

async function sandboxOwnsSession(containerId: string, sessionId: string): Promise<boolean> {
  const probe = `
    const fs = require('node:fs');
    const sessionId = process.argv.at(-1);
    if (!sessionId.startsWith('workspace_')) {
      const logs = fs.readdirSync('/tmp').filter(name => /^kilocode-wrapper-agent_.+\\.log$/.test(name));
      process.exit(logs.length > 0 && logs.every(name =>
        name.startsWith('kilocode-wrapper-' + sessionId + '-')
      ) ? 0 : 1);
    }
    const log = fs.readFileSync('/tmp/kilocode-control-wrapper.log', 'utf8');
    const directories = [...log.matchAll(/session\\.attach ready directory=([^\\n]+)/g)];
    process.exit(directories.length > 0 && directories.every(match =>
      match[1].trim().split('/').at(-1) === sessionId
    ) ? 0 : 1);
  `;
  try {
    await execFileAsync('docker', ['exec', containerId, 'bun', '-e', probe, sessionId], {
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function findOwnedSandboxes(sessionId: string, knownIds: Set<string>) {
  const candidates = sessionId.startsWith('workspace_')
    ? await listSandboxContainers()
    : await listSandboxesForAgentSession(sessionId);
  const matches: SandboxContainer[] = [];
  for (const container of candidates) {
    if (container.isProxy || knownIds.has(container.id)) continue;
    if (await sandboxOwnsSession(container.id, sessionId)) matches.push(container);
  }
  return matches;
}

async function waitForOwnedSandbox(
  sessionId: string,
  knownIds: Set<string>,
  timeoutMs: number
): Promise<SandboxContainer | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = await findOwnedSandboxes(sessionId, knownIds);
    if (matches.length > 1) {
      throw new Error(`Multiple containers match ${sessionId}; refusing ambiguous ownership`);
    }
    if (matches[0]) return matches[0];
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}

async function stopOwnedSandboxFamily(sandbox: SandboxContainer, sessionId: string) {
  const current = (await listSandboxContainers()).find(
    container => container.name === sandbox.name
  );
  if (current) {
    if (current.id !== sandbox.id)
      throw new Error(`Container identity changed for ${sandbox.name}`);
    const owned = await sandboxOwnsSession(current.id, sessionId);
    if (!owned) throw new Error(`Cannot prove exclusive ownership of ${sandbox.name}`);
  }
  const killed = await killSandboxFamily(sandbox);
  if (!(await waitForSandboxFamilyGone(sandbox, 30_000))) {
    throw new Error(`Owned sandbox family ${sandbox.name} is still running after cleanup`);
  }
  return killed;
}

async function sendRecoveryTurn(
  config: DriverConfig,
  sessionId: string,
  api: ApiVersion,
  timeoutMs: number
) {
  const stream = await openConnectedStream(config, sessionId, false);
  try {
    const sent = await sendMessage(
      config,
      { cloudAgentSessionId: sessionId, prompt: fakeDirective('echo:recovered') },
      api
    );
    const collected = await collectUntilTerminal(stream, sent.messageId, timeoutMs);
    const result = await getMessageResult(config, sessionId, sent.messageId);
    return { ...sent, ...collected, status: result.status };
  } finally {
    stream.close();
  }
}

async function snapshotSandboxIds(): Promise<Set<string>> {
  const containers = await listSandboxContainers();
  return new Set(containers.map(container => container.id));
}

export async function lifecycleGateZero(args: LifecycleArgs): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  const kiloConfig = { ...config, model: config.model.replace(/^kilo\//, '') };
  const runId = randomUUID();
  const rootAGate = `root-a-${runId}`;
  const rootBGate = `root-b-${runId}`;
  let session: Awaited<ReturnType<typeof startSession>> | undefined;
  let stream: ReturnType<typeof openStream> | undefined;
  let ownedSandbox: SandboxContainer | undefined;
  let finished = false;

  try {
    if (api !== 'unified') {
      throw new Error('Gate 0 requires the unified control-plane session creation boundary');
    }

    session = await startSession(kiloConfig, { prompt: fakeDirective(`gate:${rootAGate}`) }, api);
    if (!/^workspace_[0-9a-f-]{36}$/i.test(session.cloudAgentSessionId)) {
      throw new Error(
        `expected a control-plane workspace_* session, got ${session.cloudAgentSessionId}; enroll the driver owner in CONTROL_PLANE_IDS`
      );
    }
    if (!/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(session.kiloSessionId)) {
      throw new Error(`expected a generated root ses_* ID, got ${session.kiloSessionId}`);
    }

    stream = openStream(config, session.cloudAgentSessionId, { replay: false });
    const [locatedRuntime, rootAEngaged] = await Promise.all([
      waitForControlPlaneKiloRuntime(session.kiloSessionId, timeoutMs, sandbox => {
        ownedSandbox = sandbox;
      }),
      waitForGateEngaged(config, rootAGate, timeoutMs),
    ]);
    if (!locatedRuntime) {
      throw new Error('no per-directory Kilo listener proved ownership of root A');
    }
    if (!rootAEngaged) {
      throw new Error(`root A gate ${rootAGate} did not engage`);
    }

    const rootA = await inspectControlPlaneKiloRoot(locatedRuntime, session.kiloSessionId);
    if (
      rootA.processId !== locatedRuntime.processId ||
      rootA.directory !== locatedRuntime.directory
    ) {
      throw new Error('root A did not resolve to its discovered prepared Kilo runtime');
    }

    const rootBId = generateKiloSessionId();
    if (rootBId === rootA.id) {
      throw new Error('Gate 0 generated the same Kilo session ID for both roots');
    }
    const rootB = await importControlPlaneKiloRoot(locatedRuntime, rootBId);
    if (rootB.processId !== rootA.processId || rootB.directory !== rootA.directory) {
      throw new Error('imported root B did not resolve to root A’s Kilo process and directory');
    }

    const rootBMessageId = createMessageId();
    await promptControlPlaneKiloRoot(locatedRuntime, {
      kiloSessionId: rootB.id,
      messageId: rootBMessageId,
      gateTag: rootBGate,
      model: kiloConfig.model,
    });
    if (!(await waitForGateEngaged(config, rootBGate, Math.min(timeoutMs, 40_000)))) {
      throw new Error(`root B gate ${rootBGate} did not engage while root A remained parked`);
    }

    const [rootAGateEngaged, rootBGateEngaged, confirmedRootA, confirmedRootB] = await Promise.all([
      waitForGateEngaged(config, rootAGate, 1_000),
      waitForGateEngaged(config, rootBGate, 1_000),
      inspectControlPlaneKiloRoot(locatedRuntime, rootA.id),
      inspectControlPlaneKiloRoot(locatedRuntime, rootB.id),
    ]);
    if (!rootAGateEngaged || !rootBGateEngaged) {
      throw new Error(
        `gates were not engaged simultaneously: rootA=${rootAGateEngaged}, rootB=${rootBGateEngaged}`
      );
    }
    if (
      confirmedRootA.processId !== confirmedRootB.processId ||
      confirmedRootA.processId !== locatedRuntime.processId ||
      confirmedRootA.directory !== confirmedRootB.directory ||
      confirmedRootA.directory !== locatedRuntime.directory
    ) {
      throw new Error('simultaneously running roots did not share one Kilo process and directory');
    }

    await releaseGate(config.fakeLlmUrl, rootBGate);
    const rootBCompletion = await waitForControlPlaneKiloCompletion(locatedRuntime, {
      kiloSessionId: rootB.id,
      messageId: rootBMessageId,
      timeoutMs: Math.min(timeoutMs, 25_000),
    });
    const rootAEngagedAfterB = await waitForGateEngaged(config, rootAGate, 1_000);
    if (!rootAEngagedAfterB) {
      throw new Error('root A stopped running when only root B was released');
    }

    await releaseGate(config.fakeLlmUrl, rootAGate);
    const rootACompletion = await waitForControlPlaneKiloCompletion(locatedRuntime, {
      kiloSessionId: rootA.id,
      messageId: session.messageId,
      timeoutMs: Math.min(timeoutMs, 25_000),
    });
    const [finalRootA, finalRootB, waiters] = await Promise.all([
      inspectControlPlaneKiloRoot(locatedRuntime, rootA.id),
      inspectControlPlaneKiloRoot(locatedRuntime, rootB.id),
      fetchFakeWaiters(config.fakeLlmUrl),
    ]);
    if (
      finalRootA.processId !== finalRootB.processId ||
      finalRootA.processId !== locatedRuntime.processId ||
      finalRootA.directory !== finalRootB.directory
    ) {
      throw new Error(
        'completed roots no longer resolve to the original Kilo process and directory'
      );
    }
    const ownedWaiters = waiters.tags.filter(
      waiter => (waiter.tag === rootAGate || waiter.tag === rootBGate) && waiter.count > 0
    );
    if (ownedWaiters.length > 0) {
      throw new Error('Gate 0 left an owned fake-model gate engaged after completion');
    }

    finished = true;
    const directoryFingerprint = createHash('sha256')
      .update(locatedRuntime.directory)
      .digest('hex')
      .slice(0, 16);
    return {
      name: 'gate-0',
      conversation,
      ok: true,
      message: [
        `workspace=${session.cloudAgentSessionId}`,
        `rootA=${rootA.id}`,
        `rootB=${rootB.id}`,
        `container=${locatedRuntime.container.id}`,
        `kiloPid=${locatedRuntime.processId}`,
        `directoryFingerprint=${directoryFingerprint}`,
        ...(locatedRuntime.logPath ? [`controlLog=${locatedRuntime.logPath}`] : []),
        `simultaneousGates=${rootAGateEngaged}/${rootBGateEngaged}`,
        `rootAEngagedAfterB=${rootAEngagedAfterB}`,
        `completedB=${rootBCompletion.assistantMessageId}`,
        `completedA=${rootACompletion.assistantMessageId}`,
      ].join('; '),
      events: [...stream.events],
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: 'gate-0',
      conversation,
      ok: false,
      message: session
        ? `threw: ${message}; workspace=${session.cloudAgentSessionId}; rootA=${session.kiloSessionId}`
        : `threw: ${message}`,
      events: stream ? [...stream.events] : [],
      durationMs: Date.now() - startedAt,
    };
  } finally {
    stream?.close();
    await Promise.all([
      releaseGate(config.fakeLlmUrl, rootAGate).catch(() => undefined),
      releaseGate(config.fakeLlmUrl, rootBGate).catch(() => undefined),
    ]);
    if (!finished && session) {
      await interruptSession(config, session.cloudAgentSessionId).catch(() => undefined);
    }
    if (ownedSandbox && session) {
      const sandbox = ownedSandbox;
      await stopOwnedControlPlaneSandbox(sandbox, session.kiloSessionId).catch(error => {
        const message = error instanceof Error ? error.message : 'unknown Docker error';
        console.warn(`gate-0 owned sandbox cleanup failed (${sandbox.id}): ${message}`);
      });
    }
  }
}

type WorktreeOwnershipRow = {
  sessionId: string;
  userId: string;
  organizationId: string | null;
  parentSessionId: string | null;
  cloudAgentSessionId: string | null;
  cloudAgentSessionScopeId: string | null;
  worktreeId: string | null;
};

type PublicTranscriptEntry = { info: Message; parts: Part[] };

type PublicKiloClient = ReturnType<typeof createKiloClient>;

async function readWorktreeOwnership(
  config: DriverConfig,
  kiloSessionIds: string[]
): Promise<WorktreeOwnershipRow[]> {
  const driver = createDrizzleClient({
    connectionString: process.env.DATABASE_URL ?? computeDatabaseUrl(),
    poolConfig: { application_name: 'cloud-agent-next-worktree-e2e', max: 1 },
  });
  try {
    return await driver.db
      .select({
        sessionId: cli_sessions_v2.session_id,
        userId: cli_sessions_v2.kilo_user_id,
        organizationId: cli_sessions_v2.organization_id,
        parentSessionId: cli_sessions_v2.parent_session_id,
        cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
        cloudAgentSessionScopeId: cli_sessions_v2.cloud_agent_session_scope_id,
        worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
      })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, config.user.id),
          inArray(cli_sessions_v2.session_id, kiloSessionIds)
        )
      );
  } finally {
    await driver.pool.end();
  }
}

function requireWorktreeSessionIdentity(session: WorktreeSessionResult, label: string): void {
  if (!/^workspace_[0-9a-f-]{36}$/i.test(session.cloudAgentSessionId)) {
    throw new Error(`${label} did not receive a control-plane workspace_* identity`);
  }
  if (!/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(session.kiloSessionId)) {
    throw new Error(`${label} did not receive a valid root ses_* identity`);
  }
}

async function requireWorktreeGate(
  config: DriverConfig,
  tag: string,
  timeoutMs: number,
  stream?: StreamConnection
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const firstEvent = stream?.events.length ?? 0;
  while (Date.now() < deadline) {
    const [engaged, status] = await Promise.all([
      waitForGateEngaged(config, tag, 200, 50),
      fetchFakeScenarioStatus(config.fakeLlmUrl, tag),
    ]);
    if (status.unsupportedToolSchema) {
      throw new Error(`unsupported real Kilo tool schema for fake directive ${tag}`);
    }
    if (engaged) return;
    const failure = stream?.events
      .slice(firstEvent)
      .find(event =>
        ['error', 'interrupted', 'cloud.message.failed'].includes(event.streamEventType)
      );
    if (failure) {
      throw new Error(
        `fake directive ${tag} terminated as ${failure.streamEventType} before gating`
      );
    }
  }
  const status = await fetchFakeScenarioStatus(config.fakeLlmUrl, tag);
  if (status.requests > 0 && Object.values(status.toolCalls).every(count => count === 0)) {
    throw new Error(`required real Kilo tool schema was not advertised for fake directive ${tag}`);
  }
  throw new Error(
    `fake directive ${tag} did not engage within ${timeoutMs}ms; requests=${status.requests}; toolCalls=${JSON.stringify(status.toolCalls)}; toolResults=${JSON.stringify(status.toolResults)}`
  );
}

async function requirePublicSessionProjection(
  client: PublicKiloClient,
  kiloSessionId: string,
  privateDirectory: string
): Promise<string> {
  const result = await client.session.get({ sessionID: kiloSessionId });
  if (result.error !== undefined || result.data === undefined) {
    throw new Error(`public SDK session ${kiloSessionId} returned HTTP ${result.response.status}`);
  }
  const expectedDirectory = `/cloud-agent/sessions/${kiloSessionId}`;
  if (result.data.id !== kiloSessionId || result.data.directory !== expectedDirectory) {
    throw new Error(`public SDK session ${kiloSessionId} did not expose its synthetic directory`);
  }
  const serialized = JSON.stringify(result.data);
  if (serialized.includes(privateDirectory) || result.data.path !== undefined) {
    throw new Error(`public SDK session ${kiloSessionId} exposed private checkout data`);
  }
  return expectedDirectory;
}

function publicAssistantText(entry: PublicTranscriptEntry): string {
  return entry.parts
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('');
}

async function waitForPublicTranscript(
  client: PublicKiloClient,
  kiloSessionId: string,
  marker: string,
  timeoutMs: number
): Promise<PublicTranscriptEntry[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.session.messages({ sessionID: kiloSessionId, limit: 100 });
    if (result.error === undefined && result.data !== undefined) {
      const entries = result.data;
      if (
        entries.some(
          entry =>
            entry.info.role === 'assistant' &&
            entry.info.sessionID === kiloSessionId &&
            publicAssistantText(entry).includes(marker)
        )
      ) {
        return entries;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`persisted transcript ${kiloSessionId} did not contain its completion marker`);
}

function questionFromEvent(
  event: StreamEvent,
  kiloSessionId: string
): { id: string; sessionId: string } | null {
  if (event.streamEventType !== 'kilocode') return null;
  const data = event.data;
  if (data.type !== 'question.asked' && data.event !== 'question.asked') return null;
  const properties = data.properties;
  if (typeof properties !== 'object' || properties === null) return null;
  if (!('id' in properties) || !('sessionID' in properties)) return null;
  if (typeof properties.id !== 'string' || properties.sessionID !== kiloSessionId) return null;
  return { id: properties.id, sessionId: kiloSessionId };
}

async function waitForWorktreeQuestion(
  config: DriverConfig,
  stream: StreamConnection,
  kiloSessionId: string,
  tag: string,
  timeoutMs: number
): Promise<{ id: string; sessionId: string } | 'unsupported'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const existing = stream.events
      .map(event => questionFromEvent(event, kiloSessionId))
      .find(question => question !== null);
    if (existing) return existing;
    const status = await fetchFakeScenarioStatus(config.fakeLlmUrl, tag);
    if (status.unsupportedToolSchema) return 'unsupported';
    const matching = await stream.waitFor(
      event => questionFromEvent(event, kiloSessionId) !== null,
      Math.min(250, deadline - Date.now())
    );
    if (matching) {
      const question = questionFromEvent(matching, kiloSessionId);
      if (question) return question;
    }
  }
  const status = await fetchFakeScenarioStatus(config.fakeLlmUrl, tag);
  if (status.toolCalls.question === 0) return 'unsupported';
  throw new Error(`root-scoped question ${tag} did not reach its owning stream`);
}

async function waitForOwnedCompletion(
  runtime: ControlPlaneKiloRuntime,
  session: WorktreeSessionResult,
  messageId: string,
  marker: string,
  timeoutMs = 15_000
): Promise<void> {
  await waitForControlPlaneKiloCompletion(runtime, {
    kiloSessionId: session.kiloSessionId,
    messageId,
    expectedText: marker,
    timeoutMs,
  });
}

export async function lifecycleWorktreeShared(args: LifecycleArgs): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, api = 'unified', timeoutMs = 120_000 } = args;
  const kiloConfig = { ...config, model: config.model.replace(/^kilo\//, '') };
  const runId = randomUUID();
  const ownerTags = new Set<string>();
  const events: StreamEvent[] = [];
  const streams = new Set<StreamConnection>();
  const initialTag = `a-share-${runId}`;
  const siblingTag = `b-share-${runId}`;
  const filename = `worktree-e2e-${runId}.txt`;
  const originalContents = `original-${runId}`;
  const replacementContents = `edited-${runId}`;
  const initialMarker = `done-${initialTag}`;
  const siblingMarker = `done-${siblingTag}`;
  let rootA: WorktreeSessionResult | undefined;
  let rootB: WorktreeSessionResult | undefined;
  let ownedSandbox: SandboxContainer | undefined;

  function connect(sessionId: string): StreamConnection {
    const stream = openStream(config, sessionId, { onEvent: event => events.push(event) });
    streams.add(stream);
    return stream;
  }

  async function releaseOwned(tag: string): Promise<void> {
    await releaseGate(config.fakeLlmUrl, tag);
    ownerTags.delete(tag);
  }

  try {
    if (api !== 'unified') {
      throw new Error('worktree-shared requires the trusted browser-equivalent creation boundary');
    }

    const createOperationKey = randomUUID();
    const bootstrapMarker = `bootstrap-${runId}`;
    const bootstrapPrompt = fakeDirective(`echo:${bootstrapMarker}`);
    rootA = await prepareBrowserSession(kiloConfig, {
      prompt: bootstrapPrompt,
      operationKey: createOperationKey,
      autoCommit: false,
    });
    requireWorktreeSessionIdentity(rootA, 'first chat');
    const streamA = connect(rootA.cloudAgentSessionId);
    const runtime = await waitForControlPlaneKiloRuntime(
      rootA.kiloSessionId,
      Math.min(timeoutMs, 75_000),
      sandbox => {
        ownedSandbox = sandbox;
      }
    );
    if (!runtime) {
      throw new Error('first chat did not resolve to its owned prepared control-plane sandbox');
    }

    const firstMetadata = await getSessionSnapshot(config, rootA.cloudAgentSessionId);
    const initialMessageId = firstMetadata.initialMessageId;
    if (
      firstMetadata.userId !== config.user.id ||
      firstMetadata.kiloSessionId !== rootA.kiloSessionId ||
      firstMetadata.autoCommit !== false ||
      typeof initialMessageId !== 'string'
    ) {
      throw new Error('first chat did not preserve ownership and authoritative auto-commit policy');
    }
    await waitForOwnedCompletion(runtime, rootA, initialMessageId, bootstrapMarker, 20_000);
    const replayedFirstChat = await prepareBrowserSession(kiloConfig, {
      prompt: bootstrapPrompt,
      operationKey: createOperationKey,
      autoCommit: false,
    });
    if (
      replayedFirstChat.cloudAgentSessionId !== rootA.cloudAgentSessionId ||
      replayedFirstChat.kiloSessionId !== rootA.kiloSessionId
    ) {
      throw new Error(
        'same-key browser creation did not replay its canonical first-chat identities'
      );
    }
    const firstOwnership = await readWorktreeOwnership(config, [rootA.kiloSessionId]);
    const sourceRow = firstOwnership[0];
    if (
      firstOwnership.length !== 1 ||
      !sourceRow ||
      sourceRow.worktreeId !== rootA.cloudAgentSessionId.replace(/^workspace_/, 'worktree_') ||
      sourceRow.parentSessionId !== null ||
      sourceRow.cloudAgentSessionScopeId !== rootA.cloudAgentSessionId ||
      !runtime.directory.endsWith(`/worktrees/${sourceRow.worktreeId}`)
    ) {
      throw new Error('first chat did not persist one canonical root ownership/worktree record');
    }
    ownerTags.add(initialTag);
    const firstSharedMessage = await sendMessage(kiloConfig, {
      cloudAgentSessionId: rootA.cloudAgentSessionId,
      prompt: fakeDirective(`write-then-gate:${initialTag}:${filename}:${originalContents}`),
    });
    await requireWorktreeGate(config, initialTag, 20_000, streamA);
    const writtenFile = await inspectControlPlaneWorkspaceFile(runtime, {
      kiloSessionId: rootA.kiloSessionId,
      filePath: filename,
    });
    if (!writtenFile.exists || writtenFile.contents !== originalContents || !writtenFile.dirty) {
      throw new Error('first chat did not create the dirty shared file through its real Kilo tool');
    }

    const requestsBeforeSibling = await fetchFakeRequests(config.fakeLlmUrl);
    const siblingOperationKey = randomUUID();
    rootB = await createWorktreeChat(kiloConfig, {
      sourceKiloSessionId: rootA.kiloSessionId,
      sourceCloudAgentSessionId: rootA.cloudAgentSessionId,
      operationKey: siblingOperationKey,
    });
    requireWorktreeSessionIdentity(rootB, 'sibling chat');
    if (
      rootB.cloudAgentSessionId === rootA.cloudAgentSessionId ||
      rootB.kiloSessionId === rootA.kiloSessionId ||
      rootB.worktreeId !== sourceRow.worktreeId
    ) {
      throw new Error('sibling chat did not receive distinct identities in the source worktree');
    }
    const requestsAfterSibling = await fetchFakeRequests(config.fakeLlmUrl);
    if (requestsAfterSibling.chatCompletions !== requestsBeforeSibling.chatCompletions) {
      throw new Error('lazy sibling creation unexpectedly invoked the model');
    }
    if (await controlPlaneKiloRootExists(runtime, rootB.kiloSessionId)) {
      throw new Error('lazy sibling creation unexpectedly attached its Kilo root');
    }
    if (!(await waitForGateEngaged(config, initialTag, 500))) {
      throw new Error('sibling creation interrupted the active first chat');
    }

    const siblingReplay = await createWorktreeChat(kiloConfig, {
      sourceKiloSessionId: rootA.kiloSessionId,
      sourceCloudAgentSessionId: rootA.cloudAgentSessionId,
      operationKey: siblingOperationKey,
    });
    if (
      siblingReplay.cloudAgentSessionId !== rootB.cloudAgentSessionId ||
      siblingReplay.kiloSessionId !== rootB.kiloSessionId ||
      siblingReplay.worktreeId !== rootB.worktreeId
    ) {
      throw new Error('same-key sibling creation did not replay its canonical identities');
    }

    const ownership = await readWorktreeOwnership(config, [
      rootA.kiloSessionId,
      rootB.kiloSessionId,
    ]);
    const siblingRow = ownership.find(row => row.sessionId === rootB?.kiloSessionId);
    if (
      ownership.length !== 2 ||
      !siblingRow ||
      siblingRow.userId !== sourceRow.userId ||
      siblingRow.organizationId !== sourceRow.organizationId ||
      siblingRow.worktreeId !== sourceRow.worktreeId ||
      siblingRow.parentSessionId !== null ||
      siblingRow.cloudAgentSessionId !== rootB.cloudAgentSessionId ||
      siblingRow.cloudAgentSessionScopeId !== rootB.cloudAgentSessionId ||
      siblingRow.cloudAgentSessionScopeId === sourceRow.cloudAgentSessionScopeId
    ) {
      throw new Error(
        'siblings did not retain independent root ownership and authorization scopes'
      );
    }
    const siblingMetadata = await getSessionSnapshot(config, rootB.cloudAgentSessionId);
    if (
      !firstMetadata.sandboxId ||
      siblingMetadata.sandboxId !== firstMetadata.sandboxId ||
      siblingMetadata.userId !== firstMetadata.userId ||
      siblingMetadata.orgId !== firstMetadata.orgId ||
      siblingMetadata.gitUrl !== firstMetadata.gitUrl ||
      siblingMetadata.githubRepo !== firstMetadata.githubRepo ||
      siblingMetadata.platform !== firstMetadata.platform ||
      siblingMetadata.upstreamBranch !== firstMetadata.upstreamBranch ||
      siblingMetadata.autoCommit !== false
    ) {
      throw new Error(
        'sibling runtime metadata did not preserve the source physical route and policy'
      );
    }

    const publicClient = createKiloClient({
      baseUrl: `${config.workerUrl.replace(/\/$/, '')}/kilo`,
      headers: { Authorization: `Bearer ${mintApiToken(config.user, config.nextAuthSecret)}` },
    });
    const [publicDirectoryA, publicDirectoryB] = await Promise.all([
      requirePublicSessionProjection(publicClient, rootA.kiloSessionId, runtime.directory),
      requirePublicSessionProjection(publicClient, rootB.kiloSessionId, runtime.directory),
    ]);
    if (publicDirectoryA === publicDirectoryB) {
      throw new Error('sibling public SDK directory projections were not independently scoped');
    }

    let streamB = connect(rootB.cloudAgentSessionId);
    ownerTags.add(siblingTag);
    const siblingMessage = await sendMessage(kiloConfig, {
      cloudAgentSessionId: rootB.cloudAgentSessionId,
      prompt: fakeDirective(`read-edit-then-gate:${siblingTag}:${filename}:${replacementContents}`),
    });
    await requireWorktreeGate(config, siblingTag, 40_000, streamB);
    const [gateA, gateB, inspectedA, inspectedB, writerStatus, readerStatus] = await Promise.all([
      waitForGateEngaged(config, initialTag, 500),
      waitForGateEngaged(config, siblingTag, 500),
      inspectControlPlaneKiloRoot(runtime, rootA.kiloSessionId),
      inspectControlPlaneKiloRoot(runtime, rootB.kiloSessionId),
      fetchFakeScenarioStatus(config.fakeLlmUrl, initialTag),
      fetchFakeScenarioStatus(config.fakeLlmUrl, siblingTag),
    ]);
    if (
      !gateA ||
      !gateB ||
      inspectedA.processId !== inspectedB.processId ||
      inspectedA.processId !== runtime.processId ||
      inspectedA.directory !== inspectedB.directory ||
      writerStatus.toolCalls.write < 1 ||
      writerStatus.toolResults.write < 1 ||
      readerStatus.toolCalls.read < 1 ||
      readerStatus.toolResults.read < 1 ||
      readerStatus.toolCalls.edit < 1 ||
      readerStatus.toolResults.edit < 1
    ) {
      throw new Error(
        'siblings did not simultaneously execute genuine file tools in one Kilo process'
      );
    }
    const [activeA, activeB, editedFile] = await Promise.all([
      getSessionSnapshot(config, rootA.cloudAgentSessionId),
      getSessionSnapshot(config, rootB.cloudAgentSessionId),
      inspectControlPlaneWorkspaceFile(runtime, {
        kiloSessionId: rootB.kiloSessionId,
        filePath: filename,
      }),
    ]);
    if (
      activeA.execution?.status !== 'running' ||
      activeB.execution?.status !== 'running' ||
      editedFile.contents !== replacementContents ||
      !editedFile.dirty ||
      editedFile.head !== writtenFile.head
    ) {
      throw new Error('shared file/runtime state did not show two active uncommitted root turns');
    }

    await releaseOwned(siblingTag);
    await waitForOwnedCompletion(runtime, rootB, siblingMessage.messageId, siblingMarker);
    if (!(await waitForGateEngaged(config, initialTag, 500))) {
      throw new Error('completing the sibling unexpectedly interrupted the first chat');
    }
    await releaseOwned(initialTag);
    await waitForOwnedCompletion(runtime, rootA, firstSharedMessage.messageId, initialMarker);

    const [transcriptA, transcriptB] = await Promise.all([
      waitForPublicTranscript(publicClient, rootA.kiloSessionId, initialMarker, 15_000),
      waitForPublicTranscript(publicClient, rootB.kiloSessionId, siblingMarker, 15_000),
    ]);
    if (
      transcriptA.some(entry => publicAssistantText(entry).includes(siblingMarker)) ||
      transcriptB.some(entry => publicAssistantText(entry).includes(initialMarker)) ||
      JSON.stringify(transcriptA).includes(runtime.directory) ||
      JSON.stringify(transcriptB).includes(runtime.directory) ||
      transcriptA.some(
        entry =>
          entry.info.role === 'assistant' &&
          (entry.info.path.cwd !== publicDirectoryA || entry.info.path.root !== publicDirectoryA)
      ) ||
      transcriptB.some(
        entry =>
          entry.info.role === 'assistant' &&
          (entry.info.path.cwd !== publicDirectoryB || entry.info.path.root !== publicDirectoryB)
      ) ||
      !transcriptA.some(entry =>
        entry.parts.some(part => part.type === 'tool' && part.state.status === 'completed')
      ) ||
      !transcriptB.some(entry =>
        entry.parts.some(part => part.type === 'tool' && part.state.status === 'completed')
      )
    ) {
      throw new Error(
        'durable sibling transcripts leaked attribution or omitted completed real tools'
      );
    }

    const questionGate = `a-question-${runId}`;
    const questionTag = `b-question-${runId}`;
    const questionMarker = `done-${questionTag}`;
    ownerTags.add(questionGate);
    const gatedQuestion = await sendMessage(kiloConfig, {
      cloudAgentSessionId: rootA.cloudAgentSessionId,
      prompt: fakeDirective(`gate:${questionGate}:done-${questionGate}`),
    });
    await requireWorktreeGate(config, questionGate, 12_000, streamA);
    const questionMessage = await sendMessage(kiloConfig, {
      cloudAgentSessionId: rootB.cloudAgentSessionId,
      prompt: fakeDirective(`question:${questionTag}:Choose the isolated sibling answer`),
    });
    const pendingQuestion = await waitForWorktreeQuestion(
      config,
      streamB,
      rootB.kiloSessionId,
      questionTag,
      12_000
    );
    let questionCoverage = 'unsupported-tool-schema';
    let questionRefresh = 'unsupported';
    if (pendingQuestion !== 'unsupported') {
      const questionVisibility = await inspectControlPlaneQuestions(runtime, {
        kiloSessionId: rootB.kiloSessionId,
        questionId: pendingQuestion.id,
      });
      if (!questionVisibility.scoped.matchingQuestion) {
        throw new Error(
          `owning Kilo question is not visible in its checkout; unscoped=${questionVisibility.unscoped.count}; scoped=${questionVisibility.scoped.count}`
        );
      }
      if (
        streamA.events.some(event => questionFromEvent(event, rootB?.kiloSessionId ?? '') !== null)
      ) {
        throw new Error('the sibling question appeared on the first root stream');
      }
      let wrongRootRejected = false;
      try {
        const result = await answerQuestion(config, rootA.cloudAgentSessionId, pendingQuestion.id, [
          ['Continue'],
        ]);
        wrongRootRejected = result.success !== true;
      } catch {
        wrongRootRejected = true;
      }
      if (!wrongRootRejected) {
        throw new Error('the first root was allowed to answer the sibling question');
      }

      const requestsBeforeRefresh = await fetchFakeScenarioStatus(config.fakeLlmUrl, questionTag);
      streamB.close();
      streams.delete(streamB);
      streamB = connect(rootB.cloudAgentSessionId);
      const refreshed = await streamB.waitFor(
        event => questionFromEvent(event, rootB?.kiloSessionId ?? '')?.id === pendingQuestion.id,
        4_000
      );
      const requestsAfterRefresh = await fetchFakeScenarioStatus(config.fakeLlmUrl, questionTag);
      if (requestsAfterRefresh.requests !== requestsBeforeRefresh.requests) {
        throw new Error(
          'reconnecting the sibling question unexpectedly started another model turn'
        );
      }
      if (!refreshed) {
        throw new Error('the owning root did not replay its still-open question after refresh');
      }
      questionRefresh = 'replayed';
      const answer = await answerQuestion(config, rootB.cloudAgentSessionId, pendingQuestion.id, [
        ['Continue'],
      ]);
      if (!answer.success) {
        throw new Error('the owning sibling could not resolve its real Kilo question');
      }
      await waitForOwnedCompletion(
        runtime,
        rootB,
        questionMessage.messageId,
        questionMarker,
        10_000
      );
      questionCoverage = 'isolated';
    } else {
      throw new Error('the real Kilo question tool is unavailable or its schema is unsupported');
    }
    if (!(await waitForGateEngaged(config, questionGate, 500))) {
      throw new Error('sibling question handling unexpectedly settled the first root');
    }
    await releaseOwned(questionGate);
    await waitForOwnedCompletion(runtime, rootA, gatedQuestion.messageId, `done-${questionGate}`);

    const cancellationGateA = `a-cancel-${runId}`;
    const cancellationGateB = `b-cancel-${runId}`;
    ownerTags.add(cancellationGateA);
    ownerTags.add(cancellationGateB);
    const cancelTurnA = await sendMessage(kiloConfig, {
      cloudAgentSessionId: rootA.cloudAgentSessionId,
      prompt: fakeDirective(`gate:${cancellationGateA}:done-${cancellationGateA}`),
    });
    await requireWorktreeGate(config, cancellationGateA, 12_000, streamA);
    await sendMessage(kiloConfig, {
      cloudAgentSessionId: rootB.cloudAgentSessionId,
      prompt: fakeDirective(`gate:${cancellationGateB}:done-${cancellationGateB}`),
    });
    await requireWorktreeGate(config, cancellationGateB, 12_000, streamB);
    if (!(await waitForGateEngaged(config, cancellationGateA, 500))) {
      throw new Error('cancellation gates did not engage simultaneously');
    }
    const cancellationEventStart = streamB.events.length;
    const interruptedPromise = streamB.waitFor(
      event =>
        streamB.events.indexOf(event) >= cancellationEventStart &&
        ['interrupted', 'cloud.message.failed'].includes(event.streamEventType),
      5_000
    );
    const interruption = await interruptSession(config, rootB.cloudAgentSessionId);
    if (!interruption.success) {
      throw new Error('targeted sibling cancellation was not accepted');
    }
    const interrupted = await interruptedPromise;
    if (!interrupted || !(await waitForGateEngaged(config, cancellationGateA, 500))) {
      throw new Error('targeted cancellation did not preserve the active first root');
    }
    await releaseOwned(cancellationGateA);
    await waitForOwnedCompletion(
      runtime,
      rootA,
      cancelTurnA.messageId,
      `done-${cancellationGateA}`
    );

    const [persistedA, persistedB] = await Promise.all([
      getSessionSnapshot(config, rootA.cloudAgentSessionId),
      getSessionSnapshot(config, rootB.cloudAgentSessionId),
    ]);
    if (
      typeof persistedA.latestEventId !== 'number' ||
      typeof persistedB.latestEventId !== 'number' ||
      persistedA.latestEventId < 1 ||
      persistedB.latestEventId < 1
    ) {
      throw new Error(
        'sibling Durable Objects did not expose independent persisted event watermarks'
      );
    }

    const deletionGate = `a-delete-${runId}`;
    ownerTags.add(deletionGate);
    const deleteTurn = await sendMessage(kiloConfig, {
      cloudAgentSessionId: rootA.cloudAgentSessionId,
      prompt: fakeDirective(`gate:${deletionGate}:done-${deletionGate}`),
    });
    await requireWorktreeGate(config, deletionGate, 12_000, streamA);
    const deleted = await deleteSession(config, rootB.cloudAgentSessionId);
    if (!deleted.success) {
      throw new Error('targeted sibling runtime deletion returned success: false');
    }
    let deletedMetadataRejected = false;
    try {
      await getSessionSnapshot(config, rootB.cloudAgentSessionId);
    } catch {
      deletedMetadataRejected = true;
    }
    if (!deletedMetadataRejected || !(await waitForGateEngaged(config, deletionGate, 500))) {
      throw new Error('sibling deletion removed the first root or left sibling runtime metadata');
    }
    const survivingRoot = await inspectControlPlaneKiloRoot(runtime, rootA.kiloSessionId);
    if (survivingRoot.processId !== runtime.processId) {
      throw new Error('sibling deletion replaced or detached the surviving Kilo runtime');
    }
    await releaseOwned(deletionGate);
    await waitForOwnedCompletion(runtime, rootA, deleteTurn.messageId, `done-${deletionGate}`);
    const afterDelete = await sendMessage(kiloConfig, {
      cloudAgentSessionId: rootA.cloudAgentSessionId,
      prompt: fakeDirective(`echo:survived-${runId}`),
    });
    await waitForOwnedCompletion(runtime, rootA, afterDelete.messageId, `survived-${runId}`);
    const finalFile = await inspectControlPlaneWorkspaceFile(runtime, {
      kiloSessionId: rootA.kiloSessionId,
      filePath: filename,
    });
    if (
      finalFile.contents !== replacementContents ||
      !finalFile.dirty ||
      finalFile.head !== writtenFile.head
    ) {
      throw new Error('grouped turns committed or lost the shared agent-edited checkout file');
    }

    const directoryFingerprint = createHash('sha256')
      .update(runtime.directory)
      .digest('hex')
      .slice(0, 16);
    return {
      name: 'worktree-shared',
      conversation,
      ok: true,
      message: [
        `worktree=${sourceRow.worktreeId}`,
        `workspaceA=${rootA.cloudAgentSessionId}`,
        `workspaceB=${rootB.cloudAgentSessionId}`,
        `rootA=${rootA.kiloSessionId}`,
        `rootB=${rootB.kiloSessionId}`,
        `sandbox=${firstMetadata.sandboxId}`,
        `container=${runtime.container.id}`,
        `kiloPid=${runtime.processId}`,
        `directoryFingerprint=${directoryFingerprint}`,
        `file=${filename}`,
        'lazySibling=true',
        'simultaneousGates=true',
        'realFileTools=true',
        `question=${questionCoverage}`,
        `questionRefresh=${questionRefresh}`,
        'targetedCancellation=true',
        'targetedRuntimeDeletion=true',
        `eventWatermarks=${persistedA.latestEventId}/${persistedB.latestEventId}`,
        'publicDirectories=isolated',
        'autoCommit=explicit-false',
      ].join('; '),
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: 'worktree-shared',
      conversation,
      ok: false,
      message: `threw: ${message}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    for (const stream of streams) stream.close();
    await Promise.all(
      [...ownerTags].map(tag => releaseGate(config.fakeLlmUrl, tag).catch(() => undefined))
    );
    if (rootB) {
      await interruptSession(config, rootB.cloudAgentSessionId).catch(() => undefined);
    }
    if (rootA) {
      await interruptSession(config, rootA.cloudAgentSessionId).catch(() => undefined);
    }
    if (ownedSandbox && rootA) {
      await stopOwnedControlPlaneSandbox(ownedSandbox, rootA.kiloSessionId).catch(error => {
        const message = error instanceof Error ? error.message : 'unknown Docker error';
        console.warn(`worktree-shared owned sandbox cleanup failed: ${message}`);
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * Cold start: fresh sessionId with a newly-created per-session sandbox. Send first prompt.
 * Asserts: a sandbox container appears; the conversation completes (for
 * non-hang scenarios); driver observes prepare / queue events before the
 * first `kilocode` event.
 */
export async function lifecycleCold(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const sessionResult = await startSession(config, { prompt: fakeDirective(conversation) }, api);
    const stream = await openConnectedStream(config, sessionResult.cloudAgentSessionId);
    const sandbox = await waitForOwnedSandbox(
      sessionResult.cloudAgentSessionId,
      knownSandboxIds,
      timeoutMs
    );
    if (!sandbox) {
      stream.close();
      return {
        name: 'cold',
        conversation,
        ok: false,
        message: `could not identify an exclusively owned sandbox within ${timeoutMs}ms`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const { terminal, events } = await collectUntilTerminal(
      stream,
      sessionResult.messageId,
      timeoutMs
    );
    const stillConnected = stream.isOpen;
    stream.close();

    if (conversation === 'hang') {
      // Hang scenario: we expect NO terminal event. If we got one, fail.
      if (terminal || !stillConnected) {
        return {
          name: 'cold',
          conversation,
          ok: false,
          message: `hang scenario ended unexpectedly: ${terminal?.streamEventType ?? 'stream closed'}`,
          events,
          durationMs: Date.now() - start,
        };
      }
      return {
        name: 'cold',
        conversation,
        ok: true,
        message: `sandbox came up; no terminal event as expected (received ${events.length} events)`,
        events,
        durationMs: Date.now() - start,
      };
    }

    if (!terminal) {
      return {
        name: 'cold',
        conversation,
        ok: false,
        message: `no terminal event within ${timeoutMs}ms`,
        events,
        durationMs: Date.now() - start,
      };
    }
    if (terminal.streamEventType !== 'complete') {
      return {
        name: 'cold',
        conversation,
        ok: false,
        message: `cold start terminated without completion: ${terminal.streamEventType}`,
        events,
        durationMs: Date.now() - start,
      };
    }

    return {
      name: 'cold',
      conversation,
      ok: isMessageCompleted(terminal, sessionResult.messageId),
      message: `session=${sessionResult.cloudAgentSessionId}, message=${sessionResult.messageId}, terminal=${terminal.streamEventType}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'cold',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Hot start: run a cold echo first to warm up, then send the real
 * conversation's prompt on the SAME session. No new container, no prepare.
 */
export async function lifecycleHot(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 60_000, api = 'unified' } = args;
  try {
    // Warm-up: cold echo.
    const knownSandboxIds = await snapshotSandboxIds();
    const warmupPrompt = fakeDirective('echo:warmup');
    const session = await startSession(config, { prompt: warmupPrompt }, api);
    const warmupStream = await openConnectedStream(config, session.cloudAgentSessionId);
    const warmupSandbox = await waitForOwnedSandbox(
      session.cloudAgentSessionId,
      knownSandboxIds,
      timeoutMs
    );
    if (!warmupSandbox) {
      warmupStream.close();
      return {
        name: 'hot',
        conversation,
        ok: false,
        message: 'warmup: sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }
    const warmupTerminal = await warmupStream.waitForTerminal(timeoutMs, session.messageId);
    warmupStream.close();
    if (!isMessageCompleted(warmupTerminal, session.messageId)) {
      return {
        name: 'hot',
        conversation,
        ok: false,
        message: `warmup ${session.messageId}: expected successful message completion`,
        events: [...warmupStream.events],
        durationMs: Date.now() - start,
      };
    }

    // Send follow-up prompt. Should land on the same (hot) sandbox.
    const sandboxIdsBeforeFollowup = await snapshotSandboxIds();
    const followPrompt = fakeDirective(conversation);
    const stream = await openConnectedStream(config, session.cloudAgentSessionId, false);
    const sent = await sendMessage(
      config,
      {
        cloudAgentSessionId: session.cloudAgentSessionId,
        prompt: followPrompt,
      },
      api
    );

    const firstKilocodeStart = Date.now();
    const firstKilocode = await stream.waitFor(e => e.streamEventType === 'kilocode', 10_000);
    const firstKilocodeLatency = Date.now() - firstKilocodeStart;

    const { terminal, events } = await collectUntilTerminal(stream, sent.messageId, timeoutMs);
    const stillConnected = stream.isOpen;
    stream.close();

    const sandboxesAfter = await listSandboxContainers();
    const noPrepare = !hasPreparationForMessage(events, sent.messageId);

    const sameContainers =
      sandboxesAfter.some(sandbox => sandbox.id === warmupSandbox.id) &&
      sandboxesAfter.every(sandbox => sandboxIdsBeforeFollowup.has(sandbox.id));

    const terminalName = terminal?.streamEventType ?? 'none';
    const ok =
      (conversation === 'hang'
        ? !terminal && stillConnected
        : isMessageCompleted(terminal, sent.messageId)) &&
      noPrepare &&
      sameContainers;
    return {
      name: 'hot',
      conversation,
      ok,
      message: `terminal=${terminalName}, firstKilocode=${firstKilocode ? `${firstKilocodeLatency}ms` : 'none'}, noPrepare=${noPrepare}, sameContainers=${sameContainers}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'hot',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Followup: like hot, but the warmup + follow-up both target the same kilo
 * session. Asserts the wrapper logs `verified existing kilo session` (we
 * can't easily check wrapper logs from here without a container exec, so
 * we simply assert the second turn completes on the same container).
 */
export async function lifecycleFollowup(args: LifecycleArgs): Promise<LifecycleResult> {
  // At the public API level, `send` always keeps the same kilo session —
  // there's no user-facing distinction between "hot" and "followup" beyond
  // whether the first turn used `start`. Keep the scenario for parity with
  // the plan so future work can split them as the resume path matures.
  const result = await lifecycleHot(args);
  return { ...result, name: 'followup' };
}

/**
 * cold-hot: one real cold turn followed by several same-session hot turns.
 * This mirrors normal usage better than booting fresh sandboxes for separate
 * smoke rows while still asserting hot turns avoid new sandbox preparation.
 */
export async function lifecycleColdHot(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  const coldDirective = conversation && conversation !== '_' ? conversation : 'echo:hi';
  const hotDirectives = ['echo:hot', 'slow:3:50', 'echo:followup'];
  const events: StreamEvent[] = [];

  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective(coldDirective) }, api);
    const coldStream = await openConnectedStream(config, session.cloudAgentSessionId);
    const sandbox = await waitForOwnedSandbox(
      session.cloudAgentSessionId,
      knownSandboxIds,
      timeoutMs
    );
    if (!sandbox) {
      coldStream.close();
      return {
        name: 'cold-hot',
        conversation,
        ok: false,
        message: `cold turn: could not identify an exclusively owned sandbox within ${timeoutMs}ms`,
        events: [...coldStream.events],
        durationMs: Date.now() - start,
      };
    }

    const coldResult = await collectUntilTerminal(coldStream, session.messageId, timeoutMs);
    events.push(...coldResult.events);
    coldStream.close();
    if (!isMessageCompleted(coldResult.terminal, session.messageId)) {
      return {
        name: 'cold-hot',
        conversation,
        ok: false,
        message: `cold turn: expected complete terminal, got ${coldResult.terminal?.streamEventType ?? 'none'}`,
        events,
        durationMs: Date.now() - start,
      };
    }

    const hotSummaries: string[] = [];
    for (const directive of hotDirectives) {
      const sandboxIdsBeforeFollowup = await snapshotSandboxIds();
      const stream = await openConnectedStream(config, session.cloudAgentSessionId, false);
      const sent = await sendMessage(
        config,
        { cloudAgentSessionId: session.cloudAgentSessionId, prompt: fakeDirective(directive) },
        api
      );

      const firstKilocodeStart = Date.now();
      const firstKilocode = await stream.waitFor(e => e.streamEventType === 'kilocode', 10_000);
      const firstKilocodeLatency = Date.now() - firstKilocodeStart;
      const hotResult = await collectUntilTerminal(stream, sent.messageId, timeoutMs);
      events.push(...hotResult.events);
      stream.close();

      const sandboxesAfter = await listSandboxContainers();
      const completed = isMessageCompleted(hotResult.terminal, sent.messageId);
      const noPrepare = !hasPreparationForMessage(hotResult.events, sent.messageId);
      const sameContainers =
        sandboxesAfter.some(candidate => candidate.id === sandbox.id) &&
        sandboxesAfter.every(candidate => sandboxIdsBeforeFollowup.has(candidate.id));
      if (!completed || !noPrepare || !sameContainers) {
        return {
          name: 'cold-hot',
          conversation,
          ok: false,
          message: `${directive}: terminal=${hotResult.terminal?.streamEventType ?? 'none'}, firstKilocode=${firstKilocode ? `${firstKilocodeLatency}ms` : 'none'}, noPrepare=${noPrepare}, sameContainers=${sameContainers}`,
          events,
          durationMs: Date.now() - start,
        };
      }

      hotSummaries.push(
        `${directive}:${hotResult.terminal?.streamEventType ?? 'none'}/${firstKilocode ? `${firstKilocodeLatency}ms` : 'no-kilocode'}`
      );
    }

    return {
      name: 'cold-hot',
      conversation,
      ok: true,
      message: `session=${session.cloudAgentSessionId}; cold=${coldResult.terminal.streamEventType}; hot=${hotSummaries.join(', ')}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'cold-hot',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events,
      durationMs: Date.now() - start,
    };
  }
}

export async function lifecycleExternalKill(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  const events: StreamEvent[] = [];
  const streams: ReturnType<typeof openStream>[] = [];
  const ownedFamilies = new Map<string, SandboxContainer>();
  let knownSandboxIds = new Set<string>();
  let sessionId: string | undefined;
  try {
    knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective('echo:warmup') }, api);
    sessionId = session.cloudAgentSessionId;
    const firstStream = await openConnectedStream(config, sessionId);
    streams.push(firstStream);
    const firstSandbox = await waitForOwnedSandbox(sessionId, knownSandboxIds, timeoutMs);
    if (!firstSandbox) throw new Error('Could not identify an exclusively owned warmup sandbox');
    ownedFamilies.set(sandboxFamilyKey(firstSandbox), firstSandbox);
    const warmup = await collectUntilTerminal(firstStream, session.messageId, timeoutMs);
    events.push(...warmup.events);
    firstStream.close();
    if (!isMessageCompleted(warmup.terminal, session.messageId)) {
      throw new Error(`Warmup message ${session.messageId} did not complete successfully`);
    }

    const killed = await stopOwnedSandboxFamily(firstSandbox, sessionId);
    if (!killed.includes(firstSandbox.name))
      throw new Error('Fault did not kill the owned primary');
    const beforeRecovery = await snapshotSandboxIds();
    const stream = await openConnectedStream(config, sessionId, false);
    streams.push(stream);
    const affected = await sendMessage(
      config,
      { cloudAgentSessionId: sessionId, prompt: fakeDirective(conversation) },
      api
    );
    const affectedTurn = await collectUntilTerminal(stream, affected.messageId, timeoutMs);
    events.push(...affectedTurn.events);
    stream.close();
    const affectedResult = await getMessageResult(config, sessionId, affected.messageId);
    if (
      !affectedTurn.terminal ||
      affectedResult.status === 'queued' ||
      affectedResult.status === 'running' ||
      (affectedResult.status === 'completed') !==
        isMessageCompleted(affectedTurn.terminal, affected.messageId)
    ) {
      throw new Error(
        `Post-kill message ${affected.messageId} has no matching durable terminal outcome`
      );
    }

    const recovery = await sendRecoveryTurn(config, sessionId, api, timeoutMs);
    events.push(...recovery.events);
    if (
      !isMessageCompleted(recovery.terminal, recovery.messageId) ||
      recovery.status !== 'completed'
    ) {
      throw new Error(`Recovery message ${recovery.messageId} did not complete in ${sessionId}`);
    }
    const replacement = await waitForOwnedSandbox(sessionId, beforeRecovery, timeoutMs);
    if (!replacement) throw new Error('Could not identify the owned replacement sandbox');
    ownedFamilies.set(sandboxFamilyKey(replacement), replacement);
    if (
      replacement.id === firstSandbox.id ||
      (sessionId.startsWith('workspace_') &&
        sandboxFamilyKey(replacement) === sandboxFamilyKey(firstSandbox))
    ) {
      throw new Error('Recovery reused the retired physical sandbox');
    }
    return {
      name: 'external-kill',
      conversation,
      ok: true,
      message: `session=${sessionId}; affected=${affected.messageId}/${affectedResult.status}; recovery=${recovery.messageId}/completed; retired family stopped`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name: 'external-kill',
      conversation,
      ok: false,
      message: `threw: ${err instanceof Error ? err.message : String(err)}`,
      events,
      durationMs: Date.now() - start,
    };
  } finally {
    for (const stream of streams) stream.close();
    if (sessionId) {
      await interruptSession(config, sessionId).catch(() => {});
      for (const sandbox of await findOwnedSandboxes(sessionId, knownSandboxIds)) {
        ownedFamilies.set(sandboxFamilyKey(sandbox), sandbox);
      }
      for (const sandbox of ownedFamilies.values())
        await stopOwnedSandboxFamily(sandbox, sessionId);
    }
  }
}

export async function lifecycleKillMidFlight(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  const gateTag = `killmid-${crypto.randomUUID()}`;
  const events: StreamEvent[] = [];
  const ownedFamilies = new Map<string, SandboxContainer>();
  let knownSandboxIds = new Set<string>();
  let sessionId: string | undefined;
  let stream: ReturnType<typeof openStream> | undefined;
  try {
    knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective(`gate:${gateTag}`) }, api);
    sessionId = session.cloudAgentSessionId;
    stream = await openConnectedStream(config, sessionId);
    const sandbox = await waitForOwnedSandbox(sessionId, knownSandboxIds, timeoutMs);
    if (!sandbox) throw new Error('Could not identify an exclusively owned active sandbox');
    ownedFamilies.set(sandboxFamilyKey(sandbox), sandbox);
    if (!(await waitForGateEngaged(config, gateTag, timeoutMs))) {
      throw new Error(`Gate ${gateTag} did not engage before fault injection`);
    }
    const accepted = await stream.waitFor(
      event =>
        event.streamEventType === 'cloud.message.sent' &&
        messageIdFromEvent(event) === session.messageId,
      timeoutMs
    );
    const active = await getMessageResult(config, sessionId, session.messageId);
    if (!accepted || active.status !== 'running')
      throw new Error(`Message ${session.messageId} is not running`);

    const killed = await stopOwnedSandboxFamily(sandbox, sessionId);
    if (!killed.includes(sandbox.name)) throw new Error('Fault did not kill the owned primary');
    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
    events.push(...stream.events);
    stream.close();
    const affected = await getMessageResult(config, sessionId, session.messageId);
    if (
      terminal?.streamEventType !== 'cloud.message.failed' ||
      (affected.status !== 'failed' && affected.status !== 'interrupted')
    ) {
      throw new Error(`Killed message ${session.messageId} has no matching durable failure`);
    }

    const beforeRecovery = await snapshotSandboxIds();
    const recovery = await sendRecoveryTurn(config, sessionId, api, timeoutMs);
    events.push(...recovery.events);
    if (
      !isMessageCompleted(recovery.terminal, recovery.messageId) ||
      recovery.status !== 'completed'
    ) {
      throw new Error(`Recovery message ${recovery.messageId} did not complete in ${sessionId}`);
    }
    const replacement = await waitForOwnedSandbox(sessionId, beforeRecovery, timeoutMs);
    if (!replacement) throw new Error('Could not identify the owned replacement sandbox');
    ownedFamilies.set(sandboxFamilyKey(replacement), replacement);
    if (
      replacement.id === sandbox.id ||
      (sessionId.startsWith('workspace_') &&
        sandboxFamilyKey(replacement) === sandboxFamilyKey(sandbox))
    ) {
      throw new Error('Recovery reused the retired physical sandbox');
    }
    return {
      name: 'kill-mid-flight',
      conversation,
      ok: true,
      message: `session=${sessionId}; affected=${session.messageId}/${affected.status}; recovery=${recovery.messageId}/completed; retired family stopped`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name: 'kill-mid-flight',
      conversation,
      ok: false,
      message: `threw: ${err instanceof Error ? err.message : String(err)}`,
      events: events.length ? events : [...(stream?.events ?? [])],
      durationMs: Date.now() - start,
    };
  } finally {
    stream?.close();
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
    if (sessionId) {
      await interruptSession(config, sessionId).catch(() => {});
      for (const sandbox of await findOwnedSandboxes(sessionId, knownSandboxIds)) {
        ownedFamilies.set(sandboxFamilyKey(sandbox), sandbox);
      }
      for (const sandbox of ownedFamilies.values())
        await stopOwnedSandboxFamily(sandbox, sessionId);
    }
  }
}

// ---------------------------------------------------------------------------
// Queue-focused scenarios
// ---------------------------------------------------------------------------

type QueuedOrCompleted = 'queued' | 'completed' | 'failed';

function messagePhase(event: StreamEvent): QueuedOrCompleted | null {
  switch (event.streamEventType) {
    case 'cloud.message.queued':
      return 'queued';
    case 'cloud.message.completed':
      return 'completed';
    case 'cloud.message.failed':
      return 'failed';
    default:
      return null;
  }
}

function successfulMessageOrder(events: StreamEvent[], messageIds: string[]): boolean {
  const terminal = events.filter(event => {
    const messageId = messageIdFromEvent(event);
    return (
      messageId !== undefined &&
      messageIds.includes(messageId) &&
      (messagePhase(event) === 'completed' || messagePhase(event) === 'failed')
    );
  });
  return (
    terminal.length === messageIds.length &&
    terminal.every((event, index) => isMessageCompleted(event, messageIds[index]))
  );
}

/**
 * Pull the wrapper + kilo CLI logs from a running sandbox container and
 * render them (tailed) inline in a failure message so triage doesn't require
 * a manual `docker exec`. Used by queue scenarios to surface the root cause
 * when the test hits its timeout.
 */
async function dumpSandboxLogsForFailure(containerId: string): Promise<string> {
  try {
    const [wrapper, kilo] = await Promise.all([
      readWrapperLog(containerId).catch(() => null),
      readKiloCliLog(containerId).catch(() => null),
    ]);
    return [
      '',
      '--- wrapper log (tail) ---',
      tailLines(wrapper, 200),
      '--- kilo CLI log (tail) ---',
      tailLines(kilo, 200),
      '--- end ---',
    ].join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `\n--- log dump failed: ${msg} ---`;
  }
}

/**
 * queue-while-busy: enqueue two messages behind an actively-blocking turn,
 * release the gate, assert FIFO delivery.
 *
 * 1. Start session with `__fake__:gate:<tag>` — the fake LLM accepts the
 *    request and holds the SSE stream open, so kilo's turn stays mid-stream.
 * 2. Poll `GET /test/gate-status?tag=<tag>` until `engaged: true` — proves
 *    kilo has dialed the fake LLM and msg1 is active on the wrapper.
 * 3. `send` two echoes — both must be acked with `delivery: 'queued'`.
 * 4. `POST /test/release?tag=<tag>` so msg1 drains.
 * 5. Assert `cloud.message.completed` arrives for msg1, then msg2, then msg3
 *    in that exact order.
 */
export async function lifecycleQueueWhileBusy(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  const scenarioName = 'queue-while-busy';
  const gateTag = `${conversation || 'gate1'}-${crypto.randomUUID()}`;
  let cleanupSessionId: string | undefined;
  let terminalized = false;
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const gate = await startSession(config, { prompt: fakeDirective(`gate:${gateTag}`) }, api);
    cleanupSessionId = gate.cloudAgentSessionId;
    const stream = await openConnectedStream(config, gate.cloudAgentSessionId);
    const sandbox = await waitForOwnedSandbox(gate.cloudAgentSessionId, knownSandboxIds, timeoutMs);
    if (!sandbox) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'sandbox did not appear within 60s',
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const engaged = await waitForGateEngaged(config, gateTag, 120_000);
    if (!engaged) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: `gate:${gateTag} did not engage on fake LLM within 90s`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const second = await sendMessage(
      config,
      { cloudAgentSessionId: gate.cloudAgentSessionId, prompt: fakeDirective('echo:second') },
      api
    );
    const third = await sendMessage(
      config,
      { cloudAgentSessionId: gate.cloudAgentSessionId, prompt: fakeDirective('echo:third') },
      api
    );

    if (second.delivery !== 'queued' || third.delivery !== 'queued') {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: `expected delivery=queued for both follow-ups; got second=${second.delivery}, third=${third.delivery}`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    // Release the gate so the queue drains.
    await releaseGate(config.fakeLlmUrl, gateTag);

    // Wait for the last queued message to terminate; by then the earlier two
    // must have terminated too (queue is strict FIFO). Filter out the
    // initial `cloud.message.queued` event for the same messageId — that
    // one arrives immediately on send and isn't a terminal state.
    const thirdTerminal = await stream.waitFor(
      e =>
        messagePhase(e) !== null &&
        messagePhase(e) !== 'queued' &&
        messageIdFromEvent(e) === third.messageId,
      timeoutMs
    );
    if (!thirdTerminal) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: `third message ${third.messageId} did not terminate within ${timeoutMs}ms; owned container=${sandbox.id}`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const events = [...stream.events];
    stream.close();

    const expectedOrder = [gate.messageId, second.messageId, third.messageId];
    const fifoOk = successfulMessageOrder(events, expectedOrder);
    terminalized = fifoOk;

    return {
      name: scenarioName,
      conversation,
      ok: fifoOk,
      message: fifoOk
        ? `session=${gate.cloudAgentSessionId}; successful FIFO: ${expectedOrder.join(' -> ')}`
        : `expected successful FIFO completion for ${expectedOrder.join(' -> ')}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  } finally {
    if (!terminalized && cleanupSessionId) {
      await interruptSession(config, cleanupSessionId).catch(() => {});
    }
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
  }
}

/**
 * queue-rapid-fire-no-gate: minimal reproducer for queue-while-busy without
 * any gate machinery. Start a session with `echo:first`, immediately send
 * `echo:second` and `echo:third` back-to-back, then wait for the third
 * message's terminal phase. If FIFO holds we have a regression test; if it
 * hangs, dump the wrapper + kilo CLI logs inline for triage.
 *
 * This is the scenario to point kilo maintainers at if the bug turns out to
 * be kilo-side.
 */
export async function lifecycleQueueRapidFireNoGate(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  const scenarioName = 'queue-rapid-fire-no-gate';
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const first = await startSession(config, { prompt: fakeDirective('echo:first') }, api);
    const stream = openStream(config, first.cloudAgentSessionId, { replay: false });

    // Rapid-fire the follow-ups without waiting for any terminal signal; if
    // the DO happens to be mid-init, these will land in the pending queue
    // with delivery=queued. Either way, FIFO must hold.
    const second = await sendMessage(
      config,
      { cloudAgentSessionId: first.cloudAgentSessionId, prompt: fakeDirective('echo:second') },
      api
    );
    const third = await sendMessage(
      config,
      { cloudAgentSessionId: first.cloudAgentSessionId, prompt: fakeDirective('echo:third') },
      api
    );

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'new sandbox did not appear within 60s',
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const thirdTerminal = await stream.waitFor(
      e =>
        messagePhase(e) !== null &&
        messagePhase(e) !== 'queued' &&
        messageIdFromEvent(e) === third.messageId,
      timeoutMs
    );
    if (!thirdTerminal) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: `third message ${third.messageId} did not terminate within ${timeoutMs}ms (first=${first.messageId} second=${second.messageId})`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const events = [...stream.events];
    stream.close();

    const expectedOrder = [first.messageId, second.messageId, third.messageId];
    const fifoOk = successfulMessageOrder(events, expectedOrder);

    return {
      name: scenarioName,
      conversation,
      ok: fifoOk,
      message: fifoOk
        ? `session=${first.cloudAgentSessionId}; successful FIFO: ${expectedOrder.join(' -> ')}`
        : `expected successful FIFO completion for ${expectedOrder.join(' -> ')}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * queue-overflow: drive the pending queue up to `PENDING_SESSION_MESSAGE_LIMIT`
 * (10) and assert the next enqueue fails with HTTP 429 (TOO_MANY_REQUESTS).
 *
 * Strategy: block the first message with `gate:overflow` so it stays
 * active-but-busy in the wrapper, freeing the pending slot. Then enqueue 10
 * echoes (pending → capacity=10), and assert the 11th is rejected.
 */
export async function lifecycleQueueOverflow(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  const scenarioName = 'queue-overflow';
  const gateTag = 'overflow';
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const gate = await startSession(config, { prompt: fakeDirective(`gate:${gateTag}`) }, api);
    const stream = openStream(config, gate.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const engaged = await waitForGateEngaged(config, gateTag, 120_000);
    if (!engaged) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: `gate:${gateTag} did not engage on fake LLM — queue slot remained occupied`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    // Fill the queue until enqueue starts failing with 429. The limit is
    // server-enforced (PENDING_SESSION_MESSAGE_LIMIT); the exact boundary
    // depends on whether the gate counts toward it, so we just drain until
    // we hit the wall rather than guessing the count.
    const queuedIds: string[] = [];
    let overflowOk = false;
    let overflowMessage = 'no 429 within 20 attempts';
    for (let i = 0; i < 20; i++) {
      try {
        const ack = await sendMessage(
          config,
          {
            cloudAgentSessionId: gate.cloudAgentSessionId,
            prompt: fakeDirective(`echo:q${i}`),
          },
          api
        );
        if (ack.delivery !== 'queued') {
          stream.close();
          return {
            name: scenarioName,
            conversation,
            ok: false,
            message: `fill-${i}: expected delivery=queued, got ${ack.delivery}`,
            events: [...stream.events],
            durationMs: Date.now() - start,
          };
        }
        queuedIds.push(ack.messageId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const is429 = msg.includes('429') || /TOO_MANY_REQUESTS|PENDING_QUEUE_FULL/.test(msg);
        if (!is429) throw err;
        overflowOk = true;
        overflowMessage = `filled ${queuedIds.length} before rejection: ${msg.split('—').slice(-1)[0]?.trim() ?? '429'}`;
        break;
      }
    }

    // Interrupt after proving capacity. Draining the overflow queue naturally can
    // outlive this row and keep sandbox retry work active while later smoke cases
    // are cold-starting. The interrupt path is already responsible for clearing
    // queued messages, so wait for those durable failure events before returning.
    await interruptSession(config, gate.cloudAgentSessionId);
    const queuedFailures = await Promise.all(
      queuedIds.map(messageId =>
        stream.waitFor(
          event =>
            event.streamEventType === 'cloud.message.failed' &&
            messageIdFromEvent(event) === messageId,
          timeoutMs
        )
      )
    );
    const queueCleared = queuedFailures.every(event => event !== null);
    const events = [...stream.events];
    stream.close();

    return {
      name: scenarioName,
      conversation,
      ok: overflowOk && queueCleared,
      message: overflowOk
        ? `${overflowMessage}; cleanup=${queueCleared ? 'cleared' : 'timed out'}`
        : `expected queue rejection within 20 attempts; got: ${overflowMessage}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  } finally {
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
  }
}

/**
 * queue-interrupt-clears: enqueue messages behind an active turn, fire
 * `interruptSession`, assert all queued messages surface
 * `cloud.message.failed` with `reason: 'interrupted'` and `delivery: 'queued'`.
 *
 * The gate is not released directly — the interrupt itself terminates the
 * gated turn on the wrapper side. A best-effort cleanup release runs in the
 * `finally` block in case the fake's gated request is still parked.
 */
export async function lifecycleQueueInterruptClears(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 60_000, api = 'unified' } = args;
  const scenarioName = 'queue-interrupt-clears';
  const gateTag = 'intgate';
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const gate = await startSession(config, { prompt: fakeDirective(`gate:${gateTag}`) }, api);
    const stream = openStream(config, gate.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const engaged = await waitForGateEngaged(config, gateTag, 120_000);
    if (!engaged) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: `gate:${gateTag} did not engage on fake LLM`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    const second = await sendMessage(
      config,
      { cloudAgentSessionId: gate.cloudAgentSessionId, prompt: fakeDirective('echo:second') },
      api
    );
    const third = await sendMessage(
      config,
      { cloudAgentSessionId: gate.cloudAgentSessionId, prompt: fakeDirective('echo:third') },
      api
    );

    await interruptSession(config, gate.cloudAgentSessionId);

    // Expect cloud.message.failed for both queued follow-ups.
    const secondFailed = await stream.waitFor(
      e =>
        e.streamEventType === 'cloud.message.failed' && messageIdFromEvent(e) === second.messageId,
      timeoutMs
    );
    const thirdFailed = await stream.waitFor(
      e =>
        e.streamEventType === 'cloud.message.failed' && messageIdFromEvent(e) === third.messageId,
      timeoutMs
    );

    const events = [...stream.events];
    stream.close();

    function failedWithReasonInterrupted(event: StreamEvent | null): boolean {
      if (!event) return false;
      const data = event.data as
        | { reason?: string; delivery?: string; payload?: { reason?: string; delivery?: string } }
        | undefined;
      const reason = data?.reason ?? data?.payload?.reason;
      const delivery = data?.delivery ?? data?.payload?.delivery;
      return reason === 'interrupted' && delivery === 'queued';
    }

    const secondOk = failedWithReasonInterrupted(secondFailed);
    const thirdOk = failedWithReasonInterrupted(thirdFailed);

    return {
      name: scenarioName,
      conversation,
      ok: secondOk && thirdOk,
      message: `second=${secondOk ? 'ok' : 'fail'}, third=${thirdOk ? 'ok' : 'fail'}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  } finally {
    // Best-effort cleanup: if the fake's gated request is still parked after
    // the interrupt, release it so the server isn't holding a zombie stream.
    // 404 is fine — means the gate already went away with the interrupt.
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Single-turn scenarios driving specific fake-LLM directives
// ---------------------------------------------------------------------------

/**
 * llm-error: drives `__fake__:error:<msg>` so the fake returns HTTP 402 with
 * an OpenAI-shape error body. Assert the worker terminalizes with a failure
 * (not `complete`), and the sandbox doesn't hang indefinitely.
 *
 * Conversation arg is the error message (e.g. `llm-error boom`).
 */
export async function lifecycleLlmError(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 60_000, api = 'unified' } = args;
  const errorMsg = conversation || 'simulated-error';
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective(`error:${errorMsg}`) }, api);
    const stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: 'llm-error',
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
    const events = [...stream.events];
    stream.close();

    const isFailure =
      terminal?.streamEventType === 'cloud.message.failed' || terminal?.streamEventType === 'error';

    return {
      name: 'llm-error',
      conversation,
      ok: !!terminal && isFailure,
      message: terminal
        ? `terminal=${terminal.streamEventType}${isFailure ? '' : ' (expected failure)'}`
        : `no terminal event within ${timeoutMs}ms`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'llm-error',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * chunked-streaming: drives `__fake__:slow:<n>:<ms>` (defaults 5:50). The fake
 * emits <n> assistant content chunks separated by <ms>ms delays. Assert
 * (a) the turn completes, and (b) multiple `message.part.delta` events are
 * observed downstream — proving SSE chunks aren't coalesced into one event.
 */
export async function lifecycleChunkedStreaming(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 60_000, api = 'unified' } = args;
  const directive = conversation && conversation !== '_' ? conversation : 'slow:5:50';
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective(directive) }, api);
    const stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: 'chunked-streaming',
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
    const events = [...stream.events];
    stream.close();

    // Count message.part.delta events — these carry streamed content pieces
    // from kilo's SDK. Real streaming should produce multiple; one coalesced
    // event would indicate SSE buffering broke chunking semantics.
    const deltaCount = events.filter(
      e =>
        e.streamEventType === 'kilocode' &&
        (e.data as { type?: string } | undefined)?.type === 'message.part.delta'
    ).length;

    const ok = isMessageCompleted(terminal, session.messageId);

    return {
      name: 'chunked-streaming',
      conversation,
      ok: ok && deltaCount >= 2,
      message: `terminal=${terminal?.streamEventType ?? 'none'}, deltas=${deltaCount}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'chunked-streaming',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * empty-response: drives `__fake__:idle` so the fake emits a single empty
 * assistant chunk + finish + [DONE]. Assert the worker tolerates a
 * zero-content assistant message — session completes cleanly without any
 * `message.part.delta`.
 */
export async function lifecycleEmptyResponse(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 60_000, api = 'unified' } = args;
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective('idle') }, api);
    const stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: 'empty-response',
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
    const events = [...stream.events];
    stream.close();

    const deltaCount = events.filter(
      e =>
        e.streamEventType === 'kilocode' &&
        (e.data as { type?: string } | undefined)?.type === 'message.part.delta'
    ).length;
    const completed = isMessageCompleted(terminal, session.messageId);

    return {
      name: 'empty-response',
      conversation,
      ok: completed && deltaCount === 0,
      message: `terminal=${terminal?.streamEventType ?? 'none'}, deltas=${deltaCount}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'empty-response',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * interrupt-mid-stream: complement to `queue-interrupt-clears`. Here the
 * interrupt fires while a turn is ACTIVELY streaming (not queued). Assert
 * the active message surfaces `cloud.message.failed` with
 * `reason === 'interrupted'` and `delivery !== 'queued'`.
 */
export async function lifecycleInterruptMidStream(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 60_000, api = 'unified' } = args;
  const gateTag = 'intactive';
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective(`gate:${gateTag}`) }, api);
    const stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: 'interrupt-mid-stream',
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const engaged = await waitForGateEngaged(config, gateTag, 120_000);
    if (!engaged) {
      stream.close();
      return {
        name: 'interrupt-mid-stream',
        conversation,
        ok: false,
        message: `gate:${gateTag} did not engage within 90s`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    await interruptSession(config, session.cloudAgentSessionId);

    const failed = await stream.waitFor(
      e =>
        e.streamEventType === 'cloud.message.failed' && messageIdFromEvent(e) === session.messageId,
      timeoutMs
    );
    const events = [...stream.events];
    stream.close();

    if (!failed) {
      return {
        name: 'interrupt-mid-stream',
        conversation,
        ok: false,
        message: `no cloud.message.failed for active message within ${timeoutMs}ms`,
        events,
        durationMs: Date.now() - start,
      };
    }

    const data = failed.data as
      | { reason?: string; delivery?: string; payload?: { reason?: string; delivery?: string } }
      | undefined;
    const reason = data?.reason ?? data?.payload?.reason;
    const delivery = data?.delivery ?? data?.payload?.delivery;
    const ok = reason === 'interrupted' && delivery !== 'queued';

    return {
      name: 'interrupt-mid-stream',
      conversation,
      ok,
      message: `reason=${reason ?? 'none'} delivery=${delivery ?? 'none'}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'interrupt-mid-stream',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  } finally {
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
  }
}

/**
 * unknown-model: request a model the fake LLM validation route rejects
 * (`kilo/does-not-exist`). The mutation must reject before a sandbox or a
 * chat-completion dispatch is created.
 */
export async function lifecycleUnknownModel(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, api = 'unified' } = args;
  const overriddenConfig: DriverConfig = { ...config, model: 'kilo/does-not-exist' };
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const requestsBefore = await fetchFakeRequests(config.fakeLlmUrl);
    try {
      await startSession(overriddenConfig, { prompt: fakeDirective('echo:ignored') }, api);
      return {
        name: 'unknown-model',
        conversation,
        ok: false,
        message: 'invalid model mutation was accepted',
        events: [],
        durationMs: Date.now() - start,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 2_000);
      const requestsAfter = await fetchFakeRequests(config.fakeLlmUrl);
      const rejectedUnavailableModel = /Selected model is not available/i.test(message);
      const noPromptDispatch = requestsAfter.chatCompletions === requestsBefore.chatCompletions;
      const noSandbox = sandbox === null;
      return {
        name: 'unknown-model',
        conversation,
        ok: rejectedUnavailableModel && noPromptDispatch && noSandbox,
        message: `rejected=${rejectedUnavailableModel} sandbox=${noSandbox ? 'none' : 'created'} prompts=${requestsAfter.chatCompletions - requestsBefore.chatCompletions}`,
        events: [],
        durationMs: Date.now() - start,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: 'unknown-model',
      conversation,
      ok: false,
      message: `threw: ${message}`,
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * waiters-clean: cold echo run followed by a `/test/waiters` snapshot.
 * Asserts the fake LLM has no parked waiters after a normal turn completes
 * — catches regressions where kilo's title-model call (or other internal
 * calls) leaks a connection.
 */
export async function lifecycleWaitersClean(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 60_000, api = 'unified' } = args;
  const convo = conversation && conversation !== '_' ? conversation : 'echo:hi';
  try {
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective(convo) }, api);
    const stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: 'waiters-clean',
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
    const events = [...stream.events];
    stream.close();

    if (!terminal) {
      return {
        name: 'waiters-clean',
        conversation,
        ok: false,
        message: `no terminal within ${timeoutMs}ms`,
        events,
        durationMs: Date.now() - start,
      };
    }

    // Give kilo a moment to close its title-model SSE connection.
    await new Promise(r => setTimeout(r, 500));
    const snapshot = await fetchFakeWaiters(config.fakeLlmUrl);
    const waiterCount = snapshot.tags.reduce((sum, t) => sum + t.count, 0);
    const ok =
      isMessageCompleted(terminal, session.messageId) &&
      waiterCount === 0 &&
      snapshot.liveResponses === 0;

    return {
      name: 'waiters-clean',
      conversation,
      ok,
      message: `terminal=${terminal.streamEventType}, waiters=${waiterCount}, liveResponses=${snapshot.liveResponses}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'waiters-clean',
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

// ---------------------------------------------------------------------------
// Callback scenarios
// ---------------------------------------------------------------------------

type CallbackPayload = {
  sessionId?: string;
  cloudAgentSessionId?: string;
  executionId?: string;
  messageId?: string;
  status?: string;
  errorMessage?: string;
  lastAssistantMessageText?: string;
};

function callbackPayload(record: { body: unknown }): CallbackPayload {
  return (record.body ?? {}) as CallbackPayload;
}

function callbackPayloadsForSession(
  sink: CallbackServerHandle,
  cloudAgentSessionId: string
): CallbackPayload[] {
  return sink.received
    .map(callbackPayload)
    .filter(payload => payload.cloudAgentSessionId === cloudAgentSessionId);
}

/**
 * callback-completion: exercise the `callbackTarget` path end-to-end.
 *
 * 1. Spin up a local HTTP sink on an ephemeral port.
 * 2. Start a session with `callbackTarget.url` pointed at the sink.
 * 3. Drive the configured conversation (defaults to `echo:done`).
  * 4. Wait for the stream to complete, then wait for a POST at the sink
  *    whose `messageId` matches the started message.
  * 5. Assert `status === 'completed'` and the last-assistant-message is
  *    echoed back in the payload (confirming the outbound fetch ran with
  *    the settled message's metadata).

 */
export async function lifecycleCallbackCompletion(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, conversation, timeoutMs = 120_000, api = 'unified' } = args;
  const scenarioName = 'callback-completion';
  const directive = conversation || 'echo:done';
  const expectedText = directive.startsWith('echo:') ? directive.slice('echo:'.length) : undefined;
  let sink: CallbackServerHandle | null = null;
  try {
    sink = await startCallbackServer();
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(
      config,
      {
        prompt: fakeDirective(directive),
        callbackTarget: { url: sink.callbackUrl },
      },
      api
    );
    const stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
    const events = [...stream.events];
    stream.close();

    if (!terminal) {
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'stream terminated without a terminal event',
        events,
        durationMs: Date.now() - start,
      };
    }

    const record = await sink.waitFor(
      r => callbackPayload(r).cloudAgentSessionId === session.cloudAgentSessionId,
      20_000
    );
    if (!record) {
      return {
        name: scenarioName,
        conversation,
        ok: false,
        message: 'no callback received within 20s',
        events,
        durationMs: Date.now() - start,
      };
    }

    const payload = callbackPayload(record);
    const statusOk = payload.status === 'completed';
    const messageIdOk = payload.messageId === session.messageId;
    const textOk = expectedText === undefined || payload.lastAssistantMessageText === expectedText;
    const ok = isMessageCompleted(terminal, session.messageId) && statusOk && messageIdOk && textOk;

    return {
      name: scenarioName,
      conversation,
      ok,
      message: ok
        ? `callback status=${payload.status} messageId=${payload.messageId}`
        : `callback mismatch: status=${payload.status} messageIdOk=${messageIdOk} textOk=${textOk} (expected=${JSON.stringify(expectedText)} got=${JSON.stringify(payload.lastAssistantMessageText)})`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  } finally {
    await sink?.close().catch(() => {});
  }
}

/**
 * callback-batch-followup: exercise the callback idle-batch contract through
 * the real Worker + DO + sandbox + wrapper path.
 *
 * Phase 1 blocks the initial message, queues two callback-relevant follow-ups,
 * releases the gate, and expects one callback for the last queued message only.
 * Phase 2 sends a later hot follow-up after that idle batch has settled and
 * expects a fresh second callback for that new batch.
 */
export async function lifecycleCallbackBatchFollowup(
  args: LifecycleArgs
): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, timeoutMs = 120_000, api = 'unified' } = args;
  const scenarioName = 'callback-batch-followup';
  const gateTag = 'callback-batch';
  let sink: CallbackServerHandle | null = null;
  let cleanupSessionId: string | undefined;
  let batchCompleted = false;
  try {
    sink = await startCallbackServer();
    const knownSandboxIds = await snapshotSandboxIds();
    const first = await startSession(
      config,
      {
        prompt: fakeDirective(`gate:${gateTag}`),
        callbackTarget: { url: sink.callbackUrl },
      },
      api
    );
    cleanupSessionId = first.cloudAgentSessionId;
    const stream = openStream(config, first.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const engaged = await waitForGateEngaged(config, gateTag, 120_000);
    if (!engaged) {
      const events = [...stream.events];
      stream.close();
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: `gate:${gateTag} did not engage within 90s`,
        events,
        durationMs: Date.now() - start,
      };
    }

    const second = await sendMessage(
      config,
      {
        cloudAgentSessionId: first.cloudAgentSessionId,
        prompt: fakeDirective('echo:second'),
      },
      api
    );
    const third = await sendMessage(
      config,
      {
        cloudAgentSessionId: first.cloudAgentSessionId,
        prompt: fakeDirective('echo:third'),
      },
      api
    );
    if (second.delivery !== 'queued' || third.delivery !== 'queued') {
      const events = [...stream.events];
      stream.close();
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: `expected queued follow-ups; got second=${second.delivery}, third=${third.delivery}`,
        events,
        durationMs: Date.now() - start,
      };
    }

    await releaseGate(config.fakeLlmUrl, gateTag);
    const thirdTerminal = await stream.waitFor(
      event =>
        messagePhase(event) !== null &&
        messagePhase(event) !== 'queued' &&
        messageIdFromEvent(event) === third.messageId,
      timeoutMs
    );
    if (!thirdTerminal || messagePhase(thirdTerminal) !== 'completed') {
      const logs = await dumpSandboxLogsForFailure(sandbox.id);
      const events = [...stream.events];
      stream.close();
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: `queued batch did not complete on ${third.messageId}${logs}`,
        events,
        durationMs: Date.now() - start,
      };
    }

    const firstCallback = await sink.waitFor(
      record => callbackPayload(record).messageId === third.messageId,
      20_000
    );
    const queuedBatchCallbacks = callbackPayloadsForSession(sink, first.cloudAgentSessionId);
    const queuedBatchCallbackIds = queuedBatchCallbacks.map(payload => payload.messageId);
    const queuedBatchPayload = firstCallback ? callbackPayload(firstCallback) : undefined;
    const batchCallbackOk =
      firstCallback !== null &&
      queuedBatchCallbacks.length === 1 &&
      queuedBatchPayload?.status === 'completed' &&
      queuedBatchPayload.messageId === third.messageId &&
      queuedBatchPayload.lastAssistantMessageText === 'third' &&
      !queuedBatchCallbackIds.includes(first.messageId) &&
      !queuedBatchCallbackIds.includes(second.messageId);
    if (!batchCallbackOk) {
      const events = [...stream.events];
      stream.close();
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: `queued callback batch mismatch: ids=${queuedBatchCallbackIds.join(',') || 'none'} status=${queuedBatchPayload?.status ?? 'missing'} text=${JSON.stringify(queuedBatchPayload?.lastAssistantMessageText)}`,
        events,
        durationMs: Date.now() - start,
      };
    }

    const afterBatch = await sendMessage(
      config,
      {
        cloudAgentSessionId: first.cloudAgentSessionId,
        prompt: fakeDirective('echo:after-batch'),
      },
      api
    );
    const afterBatchTerminal = await stream.waitFor(
      event =>
        messagePhase(event) !== null &&
        messagePhase(event) !== 'queued' &&
        messageIdFromEvent(event) === afterBatch.messageId,
      timeoutMs
    );
    if (!afterBatchTerminal || messagePhase(afterBatchTerminal) !== 'completed') {
      const logs = await dumpSandboxLogsForFailure(sandbox.id);
      const events = [...stream.events];
      stream.close();
      return {
        name: scenarioName,
        conversation: 'echo:after-batch',
        ok: false,
        message: `sequential follow-up did not complete on ${afterBatch.messageId}${logs}`,
        events,
        durationMs: Date.now() - start,
      };
    }

    const secondCallback = await sink.waitFor(
      record => callbackPayload(record).messageId === afterBatch.messageId,
      20_000
    );
    const callbackPayloads = callbackPayloadsForSession(sink, first.cloudAgentSessionId);
    const callbackIds = callbackPayloads.map(payload => payload.messageId);
    const statuses = callbackPayloads.map(payload => payload.status);
    const texts = callbackPayloads.map(payload => payload.lastAssistantMessageText);
    const sequentialOk =
      secondCallback !== null &&
      callbackPayloads.length === 2 &&
      callbackIds[0] === third.messageId &&
      callbackIds[1] === afterBatch.messageId &&
      statuses[0] === 'completed' &&
      statuses[1] === 'completed' &&
      texts[0] === 'third' &&
      texts[1] === 'after-batch';
    if (!sequentialOk) {
      const events = [...stream.events];
      stream.close();
      return {
        name: scenarioName,
        conversation: 'echo:after-batch',
        ok: false,
        message: `sequential callback mismatch: ids=${callbackIds.join(',') || 'none'} statuses=${statuses.join(',') || 'none'} texts=${JSON.stringify(texts)}`,
        events,
        durationMs: Date.now() - start,
      };
    }

    const quietStart = Date.now();
    const extraCallback = await sink.waitFor(
      record =>
        callbackPayload(record).cloudAgentSessionId === first.cloudAgentSessionId &&
        record.receivedAt > quietStart,
      2_000
    );
    const events = [...stream.events];
    stream.close();
    if (extraCallback) {
      const extraPayload = callbackPayload(extraCallback);
      return {
        name: scenarioName,
        conversation: 'echo:after-batch',
        ok: false,
        message: `unexpected extra callback for ${extraPayload.messageId ?? 'unknown message'}`,
        events,
        durationMs: Date.now() - start,
      };
    }

    batchCompleted = true;
    return {
      name: scenarioName,
      conversation: 'gate:callback-batch + echo:after-batch',
      ok: true,
      message: `callbacks=${callbackIds.join(' -> ')}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation: 'gate:callback-batch + echo:after-batch',
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  } finally {
    if (!batchCompleted && cleanupSessionId) {
      await interruptSession(config, cleanupSessionId).catch(() => {});
    }
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
    await sink?.close().catch(() => {});
  }
}

/**
 * callback-interrupt: asserts the callback fires with
 * `status: 'interrupted'` when the driver calls `interruptSession` on an
 * active execution.
 *
 * Uses `gate:<tag>` so the fake LLM proves the request is parked before the
 * interrupt lands. That keeps this active-interrupt path deterministic without
 * a fixed readiness sleep.
 */
export async function lifecycleCallbackInterrupt(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const { config, timeoutMs = 120_000, api = 'unified' } = args;
  const scenarioName = 'callback-interrupt';
  const gateTag = 'callback-interrupt';
  let sink: CallbackServerHandle | null = null;
  try {
    sink = await startCallbackServer();
    const knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(
      config,
      {
        prompt: fakeDirective(`gate:${gateTag}`),
        callbackTarget: { url: sink.callbackUrl },
      },
      api
    );
    const stream = openStream(config, session.cloudAgentSessionId, { replay: false });

    const sandbox = await waitForNewSandboxPresent(knownSandboxIds, 60_000);
    if (!sandbox) {
      stream.close();
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: 'sandbox did not appear',
        events: [],
        durationMs: Date.now() - start,
      };
    }

    const engaged = await waitForGateEngaged(config, gateTag, 120_000);
    if (!engaged) {
      stream.close();
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: `gate:${gateTag} did not engage within 90s`,
        events: [...stream.events],
        durationMs: Date.now() - start,
      };
    }

    await interruptSession(config, session.cloudAgentSessionId);

    const terminal = await stream.waitForTerminal(timeoutMs, session.messageId);
    const events = [...stream.events];
    stream.close();

    if (!terminal) {
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: 'no terminal stream event after interrupt',
        events,
        durationMs: Date.now() - start,
      };
    }

    const record = await sink.waitFor(
      r => callbackPayload(r).cloudAgentSessionId === session.cloudAgentSessionId,
      20_000
    );
    if (!record) {
      return {
        name: scenarioName,
        conversation: `gate:${gateTag}`,
        ok: false,
        message: 'no callback received after interrupt',
        events,
        durationMs: Date.now() - start,
      };
    }

    const payload = callbackPayload(record);
    const interrupted = payload.status === 'interrupted';
    return {
      name: scenarioName,
      conversation: `gate:${gateTag}`,
      ok: interrupted,
      message: `callback status=${payload.status} messageId=${payload.messageId}`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: scenarioName,
      conversation: `gate:${gateTag}`,
      ok: false,
      message: `threw: ${msg}`,
      events: [],
      durationMs: Date.now() - start,
    };
  } finally {
    await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
    await sink?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export const LIFECYCLE_SCENARIOS: Record<
  string,
  (args: LifecycleArgs) => Promise<LifecycleResult>
> = {
  'gate-0': lifecycleGateZero,
  'worktree-shared': lifecycleWorktreeShared,
  cold: lifecycleCold,
  hot: lifecycleHot,
  followup: lifecycleFollowup,
  'cold-hot': lifecycleColdHot,
  'external-kill': lifecycleExternalKill,
  'kill-mid-flight': lifecycleKillMidFlight,
  'queue-while-busy': lifecycleQueueWhileBusy,
  'queue-rapid-fire-no-gate': lifecycleQueueRapidFireNoGate,
  'queue-overflow': lifecycleQueueOverflow,
  'queue-interrupt-clears': lifecycleQueueInterruptClears,
  'llm-error': lifecycleLlmError,
  'chunked-streaming': lifecycleChunkedStreaming,
  'empty-response': lifecycleEmptyResponse,
  'interrupt-mid-stream': lifecycleInterruptMidStream,
  'unknown-model': lifecycleUnknownModel,
  'waiters-clean': lifecycleWaitersClean,
  'callback-completion': lifecycleCallbackCompletion,
  'callback-batch-followup': lifecycleCallbackBatchFollowup,
  'callback-interrupt': lifecycleCallbackInterrupt,
};
