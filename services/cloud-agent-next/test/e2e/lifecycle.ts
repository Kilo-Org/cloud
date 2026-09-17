/**
 * Lifecycle scenarios. Each scenario composes the client + sandbox primitives
 * to drive the wrapper boot / reuse / kill paths. The conversation dimension
 * (echo, slow, gate, hang, ...) is handled by the fake LLM gateway via the
 * directive embedded in the prompt.
 */

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createKiloClient, type Message, type Part } from '@kilocode/sdk/v2';
import {
  answerQuestion,
  collectUntilTerminal,
  createWorktreeChat,
  deleteSession,
  fakeDirective,
  fetchFakeRequests,
  fetchFakeScenarioStatus,
  fetchFakeWaiters,
  getMessageResult,
  getSessionSnapshot,
  hasPreparationForMessage,
  interruptSession,
  isMessageCompleted,
  messageIdFromEvent,
  openConnectedStream,
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
import {
  readWorktreeOwnership,
  requireWorktreeSessionIdentity,
  requireWorktreeGate,
  waitForOwnedCompletion,
} from './worktree-support.js';
import {
  addCleanupReport,
  lifecycleColdResume,
  lifecycleLongSession,
  lifecycleMultiSessionCollab,
  type CleanupResult,
} from './lifecycle-file-state.js';
import { CONTINUITY_SCENARIOS } from './lifecycle-continuity.js';
import { runSharedScenario, type ScenarioEnvironment } from './scenario-capabilities.js';
import { SHARED_SCENARIOS } from './scenarios-shared.js';
import { createMessageId } from '../../src/session/message-id.js';
import { generateKiloSessionId } from '../../src/utils/kilo-session-id.js';
import {
  controlPlaneKiloRootExists,
  findControlPlaneKiloRuntime,
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
  waitForControlPlaneKiloCompletion,
  waitForControlPlaneKiloRuntime,
  waitForSandboxFamilyGone,
  type DockerCommandExecutor,
  type SandboxContainer,
} from './sandbox-control.js';

/**
 * Lifecycle scenarios that accept `--timeout-ms` and need a body budget beyond
 * the default 120s. Enrolled the same way as `long-session` /
 * `recover-same-session`: `run.ts` spreads this map into its long-running
 * allowlist and passes the default through `LifecycleArgs.timeoutMs`.
 */
export const LIFECYCLE_SCENARIO_TIMEOUT_MS: Record<string, number> = {
  'external-kill': 12 * 60_000,
  'kill-mid-flight': 12 * 60_000,
};

/**
 * Upper bound for a post-kill message that must await replacement recovery.
 * The DO's prepare path can legitimately spend the full create-settle window
 * before a replacement is ready, so a fixed 120s is too short; this caps each
 * such wait below the whole scenario deadline. Local-docker replacement
 * recovery has been observed at ~230s with variance past 300s (the wrapper
 * readiness deadline is re-armed per prepare attempt), so 5 min was flaky;
 * 8 min keeps a bound while leaving headroom under the 12 min scenario
 * deadline.
 */
export const RECOVERY_BUDGET_MS = 8 * 60_000;

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type ConversationScenario = string; // e.g. "echo:hi", "tools:3", "hang"

export type LifecycleResult = {
  name: string;
  conversation: string;
  ok: boolean;
  /** Set only by the shared-scenario gate for a declared-but-absent capability. */
  unsupported?: boolean;
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
  /**
   * Injected profile capabilities for a shared scenario. Runners always set
   * this; a shared scenario invoked without it fails loudly in
   * `runSharedScenario` instead of silently dropping its assertions.
   */
  env?: ScenarioEnvironment;
};

/**
 * Presence probe for a control-plane primary. Root presence is NOT exclusive
 * ownership: the wrapper restore paths no longer emit `session.attach ready
 * directory=`, so discovery now goes through the live Kilo root. Callers that
 * need exclusivity (kill, pause) must use the `exclusive` operation instead.
 */
async function sandboxOwnsSession(
  containerId: string,
  sessionId: string,
  kiloSessionId?: string
): Promise<boolean> {
  if (sessionId.startsWith('workspace_') && kiloSessionId !== undefined) {
    const runtime = await findControlPlaneKiloRuntime(kiloSessionId).catch(() => null);
    return runtime?.container.id === containerId;
  }
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

async function findOwnedSandboxes(
  sessionId: string,
  kiloSessionId: string | undefined,
  knownIds: Set<string>
) {
  const candidates = sessionId.startsWith('workspace_')
    ? await listSandboxContainers()
    : await listSandboxesForAgentSession(sessionId);
  const matches: SandboxContainer[] = [];
  for (const container of candidates) {
    if (container.isProxy || knownIds.has(container.id)) continue;
    if (await sandboxOwnsSession(container.id, sessionId, kiloSessionId)) matches.push(container);
  }
  return matches;
}

export async function waitForOwnedSandbox(
  sessionId: string,
  kiloSessionId: string,
  knownIds: Set<string>,
  timeoutMs: number
): Promise<SandboxContainer | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = await findOwnedSandboxes(sessionId, kiloSessionId, knownIds);
    if (matches.length > 1) {
      throw new Error(`Multiple containers match ${sessionId}; refusing ambiguous ownership`);
    }
    if (matches[0]) return matches[0];
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}

/**
 * Single-shot owned-container discovery for the current session, used by the
 * `sessionSandbox.currentContainer` capability. Unlike `waitForOwnedSandbox` it
 * excludes nothing, because it observes a container that is expected to already
 * exist; it still refuses ambiguous ownership.
 */
export async function currentOwnedSandbox(
  sessionId: string,
  kiloSessionId: string
): Promise<SandboxContainer | null> {
  const matches = await findOwnedSandboxes(sessionId, kiloSessionId, new Set());
  if (matches.length > 1) {
    throw new Error(`Multiple containers match ${sessionId}; refusing ambiguous ownership`);
  }
  return matches[0] ?? null;
}

export type StopOwnedSandboxFamilyOptions = {
  executeDocker?: DockerCommandExecutor;
  familyGoneTimeoutMs?: number;
  /**
   * Worktree directories the scenario created for this root's prior
   * incarnations, captured while each was exclusively owned. Passing them lets
   * cleanup stop a live replacement whose parent also holds the retired
   * worktree, without weakening the exclusive-ownership proof.
   */
  allowedDirectories?: readonly string[];
};

export async function stopOwnedSandboxFamily(
  sandbox: SandboxContainer,
  sessionId: string,
  kiloSessionId?: string,
  options: StopOwnedSandboxFamilyOptions = {}
) {
  const { executeDocker, allowedDirectories = [] } = options;
  const familyGoneTimeoutMs = options.familyGoneTimeoutMs ?? 30_000;
  const current = (await listSandboxContainers(executeDocker)).find(
    container => container.name === sandbox.name
  );
  if (current && current.id !== sandbox.id)
    throw new Error(`Container identity changed for ${sandbox.name}`);
  let killed: string[];
  if (current && sessionId.startsWith('workspace_') && kiloSessionId !== undefined) {
    // Root presence is not exclusive ownership; the control-plane stop proves
    // the `exclusive` operation before it kills. The proof can fail merely
    // because the runtime was retired or replaced while the container was
    // winding down, so re-check the family before treating that as failure.
    try {
      killed = await stopOwnedControlPlaneSandbox(
        sandbox,
        kiloSessionId,
        executeDocker,
        allowedDirectories
      );
    } catch (error) {
      if (!(await waitForSandboxFamilyGone(sandbox, familyGoneTimeoutMs, executeDocker)))
        throw error;
      return [];
    }
  } else {
    if (current) {
      const owned = await sandboxOwnsSession(current.id, sessionId, kiloSessionId);
      if (!owned) throw new Error(`Cannot prove exclusive ownership of ${sandbox.name}`);
    }
    killed = await killSandboxFamily(sandbox, executeDocker);
  }
  if (!(await waitForSandboxFamilyGone(sandbox, familyGoneTimeoutMs, executeDocker))) {
    throw new Error(`Owned sandbox family ${sandbox.name} is still running after cleanup`);
  }
  return killed;
}

/** Only tear down sandboxes whose exclusive session ownership can be proven. */
export async function stopOwnedSessionSandboxes(sessionId: string): Promise<void> {
  for (const sandbox of await findOwnedSandboxes(sessionId, undefined, new Set())) {
    await stopOwnedSandboxFamily(sandbox, sessionId);
  }
}

/**
 * Discover and stop every sandbox this scenario owns without letting a cleanup
 * failure replace the scenario result. The exclusive-ownership proof in
 * `stopOwnedSandboxFamily` is unchanged; a discovery or stop failure is
 * collected so the caller can report it beside the scenario outcome instead of
 * throwing over it.
 */
async function cleanupOwnedSandboxFamilies(input: {
  config: DriverConfig;
  sessionId: string;
  kiloSessionId: string;
  knownSandboxIds: Set<string>;
  ownedFamilies: Map<string, SandboxContainer>;
  allowedDirectories: readonly string[];
}): Promise<CleanupResult> {
  const failures: string[] = [];
  await interruptSession(input.config, input.sessionId).catch(() => {});
  try {
    for (const sandbox of await findOwnedSandboxes(
      input.sessionId,
      input.kiloSessionId,
      input.knownSandboxIds
    )) {
      input.ownedFamilies.set(sandboxFamilyKey(sandbox), sandbox);
    }
  } catch (error) {
    failures.push(
      `discover-owned-sandboxes: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  for (const sandbox of input.ownedFamilies.values()) {
    try {
      await stopOwnedSandboxFamily(sandbox, input.sessionId, input.kiloSessionId, {
        allowedDirectories: input.allowedDirectories,
      });
    } catch (error) {
      failures.push(
        `stop-owned-sandbox(${sandbox.name}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { failures, uncleanedResource: failures.length > 0 };
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

export async function snapshotSandboxIds(): Promise<Set<string>> {
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

type PublicTranscriptEntry = { info: Message; parts: Part[] };

type PublicKiloClient = ReturnType<typeof createKiloClient>;

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
    const firstOwnership = await readWorktreeOwnership(config, [rootA.cloudAgentSessionId]);
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
    if (writtenFile.unavailable) throw new Error(writtenFile.reason);
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
      rootA.cloudAgentSessionId,
      rootB.cloudAgentSessionId,
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
    const siblingRuntime = await waitForControlPlaneKiloRuntime(
      rootB.kiloSessionId,
      Math.min(timeoutMs, 40_000)
    );
    if (
      !siblingRuntime ||
      siblingRuntime.container.id !== runtime.container.id ||
      siblingRuntime.directory !== runtime.directory ||
      siblingRuntime.processId === runtime.processId ||
      siblingRuntime.home === runtime.home
    ) {
      throw new Error(
        'siblings did not resolve to distinct Kilo processes and homes in one worktree'
      );
    }
    const [gateA, gateB, inspectedA, inspectedB, writerStatus, readerStatus] = await Promise.all([
      waitForGateEngaged(config, initialTag, 500),
      waitForGateEngaged(config, siblingTag, 500),
      inspectControlPlaneKiloRoot(runtime, rootA.kiloSessionId),
      inspectControlPlaneKiloRoot(siblingRuntime, rootB.kiloSessionId),
      fetchFakeScenarioStatus(config.fakeLlmUrl, initialTag),
      fetchFakeScenarioStatus(config.fakeLlmUrl, siblingTag),
    ]);
    if (
      !gateA ||
      !gateB ||
      inspectedA.processId === inspectedB.processId ||
      inspectedA.processId !== runtime.processId ||
      inspectedA.directory !== inspectedB.directory ||
      inspectedA.home === inspectedB.home ||
      writerStatus.toolCalls.write < 1 ||
      writerStatus.toolResults.write < 1 ||
      readerStatus.toolCalls.read < 1 ||
      readerStatus.toolResults.read < 1 ||
      readerStatus.toolCalls.edit < 1 ||
      readerStatus.toolResults.edit < 1
    ) {
      throw new Error(
        'siblings did not simultaneously execute genuine file tools in isolated Kilo processes'
      );
    }
    const [activeA, activeB, editedFile] = await Promise.all([
      getSessionSnapshot(config, rootA.cloudAgentSessionId),
      getSessionSnapshot(config, rootB.cloudAgentSessionId),
      inspectControlPlaneWorkspaceFile(siblingRuntime, {
        kiloSessionId: rootB.kiloSessionId,
        filePath: filename,
      }),
    ]);
    if (editedFile.unavailable) throw new Error(editedFile.reason);
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
    await waitForOwnedCompletion(siblingRuntime, rootB, siblingMessage.messageId, siblingMarker);
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
      const questionVisibility = await inspectControlPlaneQuestions(siblingRuntime, {
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
        siblingRuntime,
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
    if (finalFile.unavailable) throw new Error(finalFile.reason);
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

export async function lifecycleExternalKill(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const {
    config,
    conversation,
    timeoutMs = LIFECYCLE_SCENARIO_TIMEOUT_MS['external-kill'],
    api = 'unified',
  } = args;
  // The post-kill message is the one that must wait for a replacement to be
  // prepared; warmup/gate/discovery keep the scenario deadline.
  const recoveryBudgetMs = Math.min(timeoutMs, RECOVERY_BUDGET_MS);
  const events: StreamEvent[] = [];
  const streams: ReturnType<typeof openStream>[] = [];
  const ownedFamilies = new Map<string, SandboxContainer>();
  const ownedDirectories = new Set<string>();
  let knownSandboxIds = new Set<string>();
  let sessionId: string | undefined;
  let kiloSessionId: string | undefined;
  let result: LifecycleResult;
  try {
    knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective('echo:warmup') }, api);
    sessionId = session.cloudAgentSessionId;
    kiloSessionId = session.kiloSessionId;
    const firstStream = await openConnectedStream(config, sessionId);
    streams.push(firstStream);
    const firstSandbox = await waitForOwnedSandbox(
      sessionId,
      session.kiloSessionId,
      knownSandboxIds,
      timeoutMs
    );
    if (!firstSandbox) throw new Error('Could not identify an exclusively owned warmup sandbox');
    ownedFamilies.set(sandboxFamilyKey(firstSandbox), firstSandbox);
    const firstRuntime = await findControlPlaneKiloRuntime(session.kiloSessionId);
    if (firstRuntime) ownedDirectories.add(firstRuntime.directory);
    const warmup = await collectUntilTerminal(firstStream, session.messageId, timeoutMs);
    events.push(...warmup.events);
    firstStream.close();
    if (!isMessageCompleted(warmup.terminal, session.messageId)) {
      throw new Error(`Warmup message ${session.messageId} did not complete successfully`);
    }

    const killed = await stopOwnedSandboxFamily(firstSandbox, sessionId, session.kiloSessionId);
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
    const affectedTurn = await collectUntilTerminal(stream, affected.messageId, recoveryBudgetMs);
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
        `Post-kill message ${affected.messageId} has no matching durable terminal outcome within ${recoveryBudgetMs}ms: ` +
          `terminal=${affectedTurn.terminal?.streamEventType ?? 'none'}; durable=${affectedResult.status}`
      );
    }

    const recovery = await sendRecoveryTurn(config, sessionId, api, recoveryBudgetMs);
    events.push(...recovery.events);
    if (
      !isMessageCompleted(recovery.terminal, recovery.messageId) ||
      recovery.status !== 'completed'
    ) {
      throw new Error(
        `Recovery message ${recovery.messageId} did not complete in ${sessionId} within ${recoveryBudgetMs}ms: ` +
          `terminal=${recovery.terminal?.streamEventType ?? 'none'}; durable=${recovery.status}`
      );
    }
    const replacement = await waitForOwnedSandbox(
      sessionId,
      session.kiloSessionId,
      beforeRecovery,
      timeoutMs
    );
    if (!replacement) throw new Error('Could not identify the owned replacement sandbox');
    ownedFamilies.set(sandboxFamilyKey(replacement), replacement);
    if (
      replacement.id === firstSandbox.id ||
      (sessionId.startsWith('workspace_') &&
        sandboxFamilyKey(replacement) === sandboxFamilyKey(firstSandbox))
    ) {
      throw new Error('Recovery reused the retired physical sandbox');
    }
    result = {
      name: 'external-kill',
      conversation,
      ok: true,
      message: `session=${sessionId}; affected=${affected.messageId}/${affectedResult.status}; recovery=${recovery.messageId}/completed; retired family stopped`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    result = {
      name: 'external-kill',
      conversation,
      ok: false,
      message: `threw: ${err instanceof Error ? err.message : String(err)}`,
      events,
      durationMs: Date.now() - start,
    };
  }
  for (const stream of streams) stream.close();
  if (sessionId && kiloSessionId) {
    const cleanup = await cleanupOwnedSandboxFamilies({
      config,
      sessionId,
      kiloSessionId,
      knownSandboxIds,
      ownedFamilies,
      allowedDirectories: [...ownedDirectories],
    });
    result = addCleanupReport(result, cleanup);
  }
  return result;
}

export async function lifecycleKillMidFlight(args: LifecycleArgs): Promise<LifecycleResult> {
  const start = Date.now();
  const {
    config,
    conversation,
    timeoutMs = LIFECYCLE_SCENARIO_TIMEOUT_MS['kill-mid-flight'],
    api = 'unified',
  } = args;
  // The recovery turn is the one that can await a replacement allocation.
  const recoveryBudgetMs = Math.min(timeoutMs, RECOVERY_BUDGET_MS);
  const gateTag = `killmid-${crypto.randomUUID()}`;
  const events: StreamEvent[] = [];
  const ownedFamilies = new Map<string, SandboxContainer>();
  const ownedDirectories = new Set<string>();
  let knownSandboxIds = new Set<string>();
  let sessionId: string | undefined;
  let kiloSessionId: string | undefined;
  let stream: ReturnType<typeof openStream> | undefined;
  let result: LifecycleResult;
  try {
    knownSandboxIds = await snapshotSandboxIds();
    const session = await startSession(config, { prompt: fakeDirective(`gate:${gateTag}`) }, api);
    sessionId = session.cloudAgentSessionId;
    kiloSessionId = session.kiloSessionId;
    stream = await openConnectedStream(config, sessionId);
    const sandbox = await waitForOwnedSandbox(
      sessionId,
      session.kiloSessionId,
      knownSandboxIds,
      timeoutMs
    );
    if (!sandbox) throw new Error('Could not identify an exclusively owned active sandbox');
    ownedFamilies.set(sandboxFamilyKey(sandbox), sandbox);
    const firstRuntime = await findControlPlaneKiloRuntime(session.kiloSessionId);
    if (firstRuntime) ownedDirectories.add(firstRuntime.directory);
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

    const killed = await stopOwnedSandboxFamily(sandbox, sessionId, session.kiloSessionId);
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
    const recovery = await sendRecoveryTurn(config, sessionId, api, recoveryBudgetMs);
    events.push(...recovery.events);
    if (
      !isMessageCompleted(recovery.terminal, recovery.messageId) ||
      recovery.status !== 'completed'
    ) {
      throw new Error(
        `Recovery message ${recovery.messageId} did not complete in ${sessionId} within ${recoveryBudgetMs}ms: ` +
          `terminal=${recovery.terminal?.streamEventType ?? 'none'}; durable=${recovery.status}`
      );
    }
    const replacement = await waitForOwnedSandbox(
      sessionId,
      session.kiloSessionId,
      beforeRecovery,
      timeoutMs
    );
    if (!replacement) throw new Error('Could not identify the owned replacement sandbox');
    ownedFamilies.set(sandboxFamilyKey(replacement), replacement);
    if (
      replacement.id === sandbox.id ||
      (sessionId.startsWith('workspace_') &&
        sandboxFamilyKey(replacement) === sandboxFamilyKey(sandbox))
    ) {
      throw new Error('Recovery reused the retired physical sandbox');
    }
    result = {
      name: 'kill-mid-flight',
      conversation,
      ok: true,
      message: `session=${sessionId}; affected=${session.messageId}/${affected.status}; recovery=${recovery.messageId}/completed; retired family stopped`,
      events,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    result = {
      name: 'kill-mid-flight',
      conversation,
      ok: false,
      message: `threw: ${err instanceof Error ? err.message : String(err)}`,
      events: events.length ? events : [...(stream?.events ?? [])],
      durationMs: Date.now() - start,
    };
  }
  stream?.close();
  await releaseGate(config.fakeLlmUrl, gateTag).catch(() => {});
  if (sessionId && kiloSessionId) {
    const cleanup = await cleanupOwnedSandboxFamilies({
      config,
      sessionId,
      kiloSessionId,
      knownSandboxIds,
      ownedFamilies,
      allowedDirectories: [...ownedDirectories],
    });
    result = addCleanupReport(result, cleanup);
  }
  return result;
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
  'long-session': lifecycleLongSession,
  'cold-resume': lifecycleColdResume,
  'multi-session-collab': lifecycleMultiSessionCollab,
  cold: args => runSharedScenario(SHARED_SCENARIOS['cold'], args),
  hot: args => runSharedScenario(SHARED_SCENARIOS['hot'], args),
  followup: args => runSharedScenario(SHARED_SCENARIOS['followup'], args),
  'cold-hot': args => runSharedScenario(SHARED_SCENARIOS['cold-hot'], args),
  'external-kill': lifecycleExternalKill,
  'kill-mid-flight': lifecycleKillMidFlight,
  'queue-while-busy': args => runSharedScenario(SHARED_SCENARIOS['queue-while-busy'], args),
  'queue-rapid-fire-no-gate': args =>
    runSharedScenario(SHARED_SCENARIOS['queue-rapid-fire-no-gate'], args),
  'queue-overflow': args => runSharedScenario(SHARED_SCENARIOS['queue-overflow'], args),
  'queue-interrupt-clears': args =>
    runSharedScenario(SHARED_SCENARIOS['queue-interrupt-clears'], args),
  'llm-error': args => runSharedScenario(SHARED_SCENARIOS['llm-error'], args),
  'chunked-streaming': args => runSharedScenario(SHARED_SCENARIOS['chunked-streaming'], args),
  'empty-response': args => runSharedScenario(SHARED_SCENARIOS['empty-response'], args),
  'interrupt-mid-stream': args => runSharedScenario(SHARED_SCENARIOS['interrupt-mid-stream'], args),
  'unknown-model': args => runSharedScenario(SHARED_SCENARIOS['unknown-model'], args),
  'auth-reject': args => runSharedScenario(SHARED_SCENARIOS['auth-reject'], args),
  'waiters-clean': args => runSharedScenario(SHARED_SCENARIOS['waiters-clean'], args),
  'callback-completion': args => runSharedScenario(SHARED_SCENARIOS['callback-completion'], args),
  'callback-batch-followup': args =>
    runSharedScenario(SHARED_SCENARIOS['callback-batch-followup'], args),
  'callback-interrupt': args => runSharedScenario(SHARED_SCENARIOS['callback-interrupt'], args),
  'interrupt-then-continue': args =>
    runSharedScenario(SHARED_SCENARIOS['interrupt-then-continue'], args),
  ...CONTINUITY_SCENARIOS,
};
