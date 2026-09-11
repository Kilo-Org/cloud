import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import {
  createWorktreeChat,
  fetchFakeScenarioStatus,
  getSessionSnapshot,
  interruptSession,
  prepareBrowserSession,
  releaseGate,
  sendMessage,
  type ApiVersion,
  type DriverConfig,
  type StreamConnection,
  type StreamEvent,
  type WorktreeSessionResult,
} from './client.js';
import {
  findControlPlaneKiloRuntime,
  inspectControlPlaneHistory,
  inspectControlPlaneKiloRoot,
  inspectControlPlaneWorkspaceFile,
  listSandboxContainers,
  sandboxFamilyKey,
  stopOwnedControlPlaneSandbox,
  waitForControlPlaneKiloRuntime,
  waitForSandboxPrimaryGone,
  type ControlPlaneKiloRuntime,
  type SandboxContainer,
} from './sandbox-control.js';
import {
  openConnectedStream,
  readWorktreeOwnership,
  requireWorktreeSessionIdentity,
  requireWorktreeGate,
  waitForOwnedCompletion,
} from './worktree-support.js';
import { readIdleStopEvidence, CLOUD_AGENT_LOG_PATH } from './idle-stop-evidence.js';
import { bestEffortExportDiagnostic } from './session-export-check.js';

export const FILE_STATE_SCENARIO_TIMEOUT_MS = {
  'long-session': 20 * 60_000,
  'cold-resume': 25 * 60_000,
  'multi-session-collab': 20 * 60_000,
} as const;

export const FILE_STATE_SCENARIOS = Object.keys(FILE_STATE_SCENARIO_TIMEOUT_MS);

type LifecycleArgs = {
  config: DriverConfig;
  conversation: string;
  api?: ApiVersion;
  timeoutMs?: number;
};

type LifecycleResult = {
  name: string;
  conversation: string;
  ok: boolean;
  message: string;
  events: StreamEvent[];
  durationMs: number;
};

type ExpectedFile = { path: string; contents: string };
type ExpectedTool = 'write' | 'read-edit' | 'read-then-write';
export type PendingAcquisition = { label: string; operationKey?: string };

export type AcquireTrackedOptions = {
  operationKey?: string;
  uncertainOnFailure?: boolean;
};

export type OperationRole =
  | 'long-session'
  | 'cold-resume'
  | 'cold-resume-admission'
  | 'multi-session-planner'
  | 'multi-session-implementer'
  | 'multi-session-reviewer';

export type ScenarioOperation = { label: string; operationKey: string };

/**
 * Operation keys cross the trusted browser-equivalent boundary, where the
 * server validates them with `z.string().uuid()`. Keep the scenario role name
 * in the diagnostic label only; the value sent over the wire must be a bare
 * UUID.
 */
export function createScenarioOperation(role: OperationRole): ScenarioOperation {
  return { label: role, operationKey: randomUUID() };
}

export type ScenarioResources = {
  config: DriverConfig;
  kiloConfig: DriverConfig;
  deadlineAt: number;
  events: StreamEvent[];
  streams: Set<StreamConnection>;
  streamsBySession: Map<string, StreamConnection>;
  sessions: Map<string, WorktreeSessionResult>;
  ownedGateTags: Set<string>;
  pendingAcquisitions: Set<PendingAcquisition>;
  uncertainAcquisitions: Set<PendingAcquisition>;
  cleanupStarted: boolean;
  lateCleanupFailures: string[];
  lateUncleanedResource: boolean;
  ownership: { sandbox?: SandboxContainer; rootKiloSessionId?: string };
  connect: (sessionId: string, replay?: boolean) => Promise<StreamConnection>;
  within: <T>(label: string, operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
};

export type CleanupResult = { failures: string[]; uncleanedResource: boolean };

const COLD_IDLE_BUDGET_MS = 8 * 60_000;
const CLEANUP_BUDGET_MS = 10_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scenarioResult(
  name: string,
  args: LifecycleArgs,
  startedAt: number,
  events: StreamEvent[],
  ok: boolean,
  message: string
): LifecycleResult {
  return {
    name,
    conversation: args.conversation,
    ok,
    message,
    events,
    durationMs: Date.now() - startedAt,
  };
}

function fakeDirective(scenario: string, ...args: string[]): string {
  return `__fake__:${scenario}${args.length > 0 ? `:${args.join(':')}` : ''}`;
}

function assertScenarioPreconditions(config: DriverConfig, api: ApiVersion | undefined): void {
  if ((api ?? 'unified') !== 'unified') {
    throw new Error('file-state lifecycle scenarios require the unified API');
  }
  if (config.model.replace(/^kilo\//, '') !== 'fake-deterministic') {
    throw new Error(
      `file-state lifecycle scenarios require kilo/fake-deterministic, got ${config.model}`
    );
  }
}

export function createScenarioResources(
  config: DriverConfig,
  timeoutMs: number
): ScenarioResources {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid scenario timeout: ${timeoutMs}`);
  }
  const events: StreamEvent[] = [];
  const streams = new Set<StreamConnection>();
  const streamsBySession = new Map<string, StreamConnection>();
  const sessions = new Map<string, WorktreeSessionResult>();
  const ownedGateTags = new Set<string>();
  const pendingAcquisitions = new Set<PendingAcquisition>();
  const uncertainAcquisitions = new Set<PendingAcquisition>();
  const ownership: ScenarioResources['ownership'] = {};
  const deadlineAt = Date.now() + timeoutMs;
  const resources: ScenarioResources = {
    config,
    kiloConfig: { ...config, model: config.model.replace(/^kilo\//, '') },
    deadlineAt,
    events,
    streams,
    streamsBySession,
    sessions,
    ownedGateTags,
    pendingAcquisitions,
    uncertainAcquisitions,
    cleanupStarted: false,
    lateCleanupFailures: [],
    lateUncleanedResource: false,
    ownership,
    connect: async () => {
      throw new Error('scenario stream connector was not initialized');
    },
    within: async () => {
      throw new Error('scenario deadline helper was not initialized');
    },
  };
  resources.within = async <T>(
    label: string,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    const remaining = resources.deadlineAt - Date.now();
    if (remaining <= 0) throw new Error(`scenario deadline exceeded before ${label}`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`scenario deadline exceeded during ${label}`));
        reject(new Error(`scenario deadline exceeded during ${label}`));
      }, remaining);
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  resources.connect = async (sessionId: string, replay = false): Promise<StreamConnection> => {
    const existing = resources.streamsBySession.get(sessionId);
    if (existing?.isOpen) return existing;
    return acquireTracked(
      resources,
      `stream connection for ${sessionId}`,
      signal => openConnectedStream(config, sessionId, replay, event => events.push(event), signal),
      stream => {
        streams.add(stream);
        streamsBySession.set(sessionId, stream);
        if (resources.cleanupStarted) {
          try {
            stream.close();
          } catch (error) {
            resources.lateCleanupFailures.push(
              `stream-close(${sessionId}): ${errorMessage(error)}`
            );
          }
          resources.lateUncleanedResource = true;
        }
      }
    );
  };
  return resources;
}

function remaining(resources: ScenarioResources, label: string): number {
  const timeoutMs = resources.deadlineAt - Date.now();
  if (timeoutMs <= 0) throw new Error(`scenario deadline exceeded before ${label}`);
  return timeoutMs;
}

function trackSession(resources: ScenarioResources, session: WorktreeSessionResult): void {
  resources.sessions.set(session.kiloSessionId, session);
  resources.ownership.rootKiloSessionId ??= session.kiloSessionId;
  if (resources.cleanupStarted) resources.lateUncleanedResource = true;
}

export function acquireTracked<T>(
  resources: ScenarioResources,
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
  onAcquired: (value: T) => void,
  options: AcquireTrackedOptions = {}
): Promise<T> {
  return (async () => {
    const pending: PendingAcquisition = { label, operationKey: options.operationKey };
    let operationStarted = false;
    const retainUncertainty = (): void => {
      if (options.uncertainOnFailure && operationStarted) {
        resources.uncertainAcquisitions.add(pending);
      }
    };
    try {
      return await resources.within(label, signal => {
        operationStarted = true;
        resources.pendingAcquisitions.add(pending);
        const acquisition = Promise.resolve()
          .then(() => operation(signal))
          .then(
            value => {
              resources.pendingAcquisitions.delete(pending);
              onAcquired(value);
              return value;
            },
            error => {
              resources.pendingAcquisitions.delete(pending);
              retainUncertainty();
              throw error;
            }
          );
        return acquisition;
      });
    } catch (error) {
      retainUncertainty();
      throw error;
    }
  })();
}

function acquisitionSummary(resources: ScenarioResources): string {
  return Array.from(
    new Set([...resources.pendingAcquisitions, ...resources.uncertainAcquisitions]),
    acquisition =>
      acquisition.operationKey
        ? `${acquisition.label} (operationKey=${acquisition.operationKey})`
        : acquisition.label
  ).join(',');
}

function expectedToolCounters(expectedTool: ExpectedTool): Array<'read' | 'write' | 'edit'> {
  if (expectedTool === 'write') return ['write'];
  if (expectedTool === 'read-edit') return ['read', 'edit'];
  return ['read', 'write'];
}

async function runGatedFileTurn(
  deps: ScenarioResources,
  input: {
    session: WorktreeSessionResult;
    runtime: ControlPlaneKiloRuntime;
    prompt: string;
    gateTag: string;
    expectedFile: ExpectedFile;
    expectTool: ExpectedTool;
    engageTimeoutMs: number;
  }
): Promise<{ messageId: string; head: string }> {
  const stream = await deps.connect(input.session.cloudAgentSessionId);
  deps.ownedGateTags.add(input.gateTag);
  const sent = await deps.within(`send ${input.gateTag}`, signal =>
    sendMessage(deps.kiloConfig, {
      cloudAgentSessionId: input.session.cloudAgentSessionId,
      prompt: input.prompt,
      signal,
    })
  );
  await deps.within(`gate ${input.gateTag}`, () =>
    requireWorktreeGate(
      deps.config,
      input.gateTag,
      Math.min(input.engageTimeoutMs, remaining(deps, `gate ${input.gateTag}`)),
      stream
    )
  );
  const status = await deps.within(`status ${input.gateTag}`, () =>
    fetchFakeScenarioStatus(deps.config.fakeLlmUrl, input.gateTag)
  );
  if (status.unsupportedToolSchema) {
    throw new Error(`unsupported real Kilo tool schema for fake directive ${input.gateTag}`);
  }
  for (const tool of expectedToolCounters(input.expectTool)) {
    if (status.toolCalls[tool] < 1 || status.toolResults[tool] < 1) {
      throw new Error(
        `fake directive ${input.gateTag} missing ${tool} call/result: calls=${status.toolCalls[tool]}, results=${status.toolResults[tool]}`
      );
    }
  }
  const file = await deps.within(`file ${input.expectedFile.path}`, () =>
    inspectControlPlaneWorkspaceFile(input.runtime, {
      kiloSessionId: input.session.kiloSessionId,
      filePath: input.expectedFile.path,
    })
  );
  if (!file.exists || file.contents !== input.expectedFile.contents || !file.dirty) {
    throw new Error(
      `file ${input.expectedFile.path} mismatch: exists=${file.exists}; dirty=${file.dirty}; contents=${JSON.stringify(file.contents)}`
    );
  }
  await deps.within(`release ${input.gateTag}`, signal =>
    releaseGate(deps.config.fakeLlmUrl, input.gateTag, signal)
  );
  deps.ownedGateTags.delete(input.gateTag);
  await deps.within(`completion ${input.gateTag}`, () =>
    waitForOwnedCompletion(
      input.runtime,
      input.session,
      sent.messageId,
      `done-${input.gateTag}`,
      remaining(deps, `completion ${input.gateTag}`)
    )
  );
  return { messageId: sent.messageId, head: file.head };
}

export async function cleanupScenario(resources: ScenarioResources): Promise<CleanupResult> {
  const failures: string[] = [];
  const cleanupDeadline = Date.now() + CLEANUP_BUDGET_MS;
  let uncleanedResource = false;
  resources.cleanupStarted = true;

  const boundedCleanup = async (
    label: string,
    operation: (signal: AbortSignal) => Promise<void>
  ): Promise<boolean> => {
    const remainingMs = cleanupDeadline - Date.now();
    if (remainingMs <= 0) {
      failures.push(`${label}: cleanup deadline exceeded`);
      return false;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`cleanup deadline exceeded during ${label}`));
        reject(new Error(`cleanup deadline exceeded during ${label}`));
      }, remainingMs);
    });
    try {
      await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]);
      return true;
    } catch (error) {
      failures.push(`${label}: ${errorMessage(error)}`);
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
    }
  };

  try {
    for (const tag of resources.ownedGateTags) {
      const released = await boundedCleanup(`release(${tag})`, signal =>
        releaseGate(resources.config.fakeLlmUrl, tag, signal)
      );
      if (released) resources.ownedGateTags.delete(tag);
    }
    const interrupted = new Set<string>();
    for (const session of resources.sessions.values()) {
      if (interrupted.has(session.cloudAgentSessionId)) continue;
      interrupted.add(session.cloudAgentSessionId);
      await boundedCleanup(`interrupt(${session.cloudAgentSessionId})`, signal =>
        interruptSession(resources.config, session.cloudAgentSessionId, signal).then(
          () => undefined
        )
      );
    }
    const rootKiloSessionId = resources.ownership.rootKiloSessionId;
    const ownedSandbox = resources.ownership.sandbox;
    if (rootKiloSessionId && ownedSandbox) {
      if (
        !(await boundedCleanup('stop-owned-sandbox', () =>
          stopOwnedControlPlaneSandbox(ownedSandbox, rootKiloSessionId)
        ))
      ) {
        uncleanedResource = true;
      }
    } else if (
      resources.sessions.size > 0 ||
      resources.pendingAcquisitions.size > 0 ||
      resources.uncertainAcquisitions.size > 0
    ) {
      uncleanedResource = true;
      failures.push(
        resources.pendingAcquisitions.size > 0 || resources.uncertainAcquisitions.size > 0
          ? `stop-owned-sandbox: ownership could not be proved; pending=${acquisitionSummary(resources)}`
          : 'stop-owned-sandbox: ownership could not be proved'
      );
    }
  } finally {
    // Stream close is synchronous and must run even if an HTTP cleanup request
    // stalls. A late acquisition closes itself in acquireTracked's callback.
    for (const stream of resources.streams) {
      try {
        stream.close();
      } catch (error) {
        failures.push(`stream-close: ${errorMessage(error)}`);
      }
    }
  }
  if (resources.pendingAcquisitions.size > 0 || resources.uncertainAcquisitions.size > 0) {
    uncleanedResource = true;
    failures.push(`pending acquisition: ${acquisitionSummary(resources)}`);
  }
  failures.push(...resources.lateCleanupFailures);
  uncleanedResource ||= resources.lateUncleanedResource;
  return { failures, uncleanedResource };
}

function addCleanupReport(result: LifecycleResult, cleanup: CleanupResult): LifecycleResult {
  if (cleanup.failures.length === 0 && !cleanup.uncleanedResource) return result;
  const suffix = [
    ...(cleanup.failures.length > 0 ? [`cleanupFailure=${cleanup.failures.join(' | ')}`] : []),
    ...(cleanup.uncleanedResource ? ['uncleanedResource=true'] : []),
  ].join('; ');
  return { ...result, message: `${result.message}; ${suffix}` };
}

async function waitForOwnedRuntime(
  resources: ScenarioResources,
  kiloSessionId: string
): Promise<ControlPlaneKiloRuntime> {
  const runtime = await acquireTracked(
    resources,
    `runtime ${kiloSessionId}`,
    () =>
      waitForControlPlaneKiloRuntime(
        kiloSessionId,
        remaining(resources, `runtime ${kiloSessionId}`),
        sandbox => {
          resources.ownership.sandbox = sandbox;
          if (resources.cleanupStarted) resources.lateUncleanedResource = true;
        }
      ),
    value => {
      if (value) {
        resources.ownership.sandbox = value.container;
        if (resources.cleanupStarted) resources.lateUncleanedResource = true;
      }
    }
  );
  if (!runtime) throw new Error(`no control-plane runtime for ${kiloSessionId}`);
  return runtime;
}

async function bootSession(
  resources: ScenarioResources,
  input: { runId: string; operation: ScenarioOperation }
): Promise<{
  session: WorktreeSessionResult;
  runtime: ControlPlaneKiloRuntime;
  sandboxId: string;
}> {
  const { label, operationKey } = input.operation;
  const session = await acquireTracked(
    resources,
    `prepare browser session (${label})`,
    signal =>
      prepareBrowserSession(
        resources.kiloConfig,
        {
          prompt: fakeDirective('echo', `boot-${input.runId}`),
          operationKey,
          autoCommit: false,
        },
        signal
      ),
    value => trackSession(resources, value),
    { operationKey, uncertainOnFailure: true }
  );
  requireWorktreeSessionIdentity(session, 'boot session');
  const runtime = await waitForOwnedRuntime(resources, session.kiloSessionId);
  await resources.connect(session.cloudAgentSessionId, true);
  const snapshot = await resources.within('boot snapshot', () =>
    getSessionSnapshot(resources.config, session.cloudAgentSessionId)
  );
  const initialMessageId = snapshot.initialMessageId;
  if (!initialMessageId) throw new Error('boot session did not expose initial message id');
  const sandboxId = snapshot.sandboxId;
  if (!sandboxId) throw new Error('boot session did not expose a durable sandbox id');
  await resources.within('boot completion', () =>
    waitForOwnedCompletion(
      runtime,
      session,
      initialMessageId,
      `boot-${input.runId}`,
      remaining(resources, 'boot completion')
    )
  );
  return { session, runtime, sandboxId };
}

async function captureLogCursor(): Promise<{ fromByte: number; capturedAt: number }> {
  const capturedAt = Date.now();
  try {
    return { fromByte: (await stat(CLOUD_AGENT_LOG_PATH)).size, capturedAt };
  } catch {
    return { fromByte: 0, capturedAt };
  }
}

export async function lifecycleLongSession(args: LifecycleArgs): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const resources = createScenarioResources(
    args.config,
    args.timeoutMs ?? FILE_STATE_SCENARIO_TIMEOUT_MS['long-session']
  );
  let result = scenarioResult(
    'long-session',
    args,
    startedAt,
    resources.events,
    false,
    'scenario did not start'
  );
  try {
    assertScenarioPreconditions(args.config, args.api);
    const runId = randomUUID();
    const { session, runtime: bootRuntime } = await bootSession(resources, {
      runId,
      operation: createScenarioOperation('long-session'),
    });
    const bootContainerId = bootRuntime.container.id;
    const bootFamily = sandboxFamilyKey(bootRuntime.container);
    const bootProcessId = bootRuntime.processId;
    const bootDirectory = bootRuntime.directory;
    let writes = 0;
    let readEdits = 0;
    for (let turn = 1; turn <= 11; turn += 1) {
      const gateTag = `t${turn}-${runId}`;
      const filePath = `long-session-${runId}/turn${turn}.txt`;
      const isReadEdit = turn === 4 || turn === 8;
      const expectedContents = isReadEdit ? `edited-${turn}-${runId}` : `turn-${turn}-${runId}`;
      const previousPath = `long-session-${runId}/turn${turn - 1}.txt`;
      const prompt = isReadEdit
        ? fakeDirective('read-edit-then-gate', gateTag, previousPath, expectedContents)
        : fakeDirective('write-then-gate', gateTag, filePath, expectedContents);
      await runGatedFileTurn(resources, {
        session,
        runtime: bootRuntime,
        prompt,
        gateTag,
        expectedFile: { path: isReadEdit ? previousPath : filePath, contents: expectedContents },
        expectTool: isReadEdit ? 'read-edit' : 'write',
        engageTimeoutMs: remaining(resources, `turn ${turn} gate`),
      });
      if (isReadEdit) readEdits += 1;
      else writes += 1;
      const checkpoint = await resources.within(`turn ${turn} runtime checkpoint`, () =>
        findControlPlaneKiloRuntime(session.kiloSessionId, undefined, sandbox => {
          resources.ownership.sandbox = sandbox;
        })
      );
      if (!checkpoint) throw new Error(`turn ${turn} runtime checkpoint was not found`);
      if (
        checkpoint.container.id !== bootContainerId ||
        sandboxFamilyKey(checkpoint.container) !== bootFamily ||
        checkpoint.processId !== bootProcessId ||
        checkpoint.directory !== bootDirectory
      ) {
        throw new Error(`turn ${turn} changed this root's sandbox/container identity`);
      }
    }
    result = scenarioResult(
      'long-session',
      args,
      startedAt,
      resources.events,
      true,
      'turns=11; writes=9; readEdits=2; sameRootContainer=true (checkpoint)'
    );
  } catch (error) {
    result = scenarioResult(
      'long-session',
      args,
      startedAt,
      resources.events,
      false,
      errorMessage(error)
    );
  } finally {
    const cleanup = await cleanupScenario(resources);
    result = addCleanupReport(result, cleanup);
  }
  return result;
}

export async function lifecycleColdResume(args: LifecycleArgs): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const resources = createScenarioResources(
    args.config,
    args.timeoutMs ?? FILE_STATE_SCENARIO_TIMEOUT_MS['cold-resume']
  );
  let result = scenarioResult(
    'cold-resume',
    args,
    startedAt,
    resources.events,
    false,
    'scenario did not start'
  );
  let resumedAdmission: PendingAcquisition | undefined;
  let resumedAdmissionReconciled = false;
  try {
    assertScenarioPreconditions(args.config, args.api);
    const runId = randomUUID();
    const {
      session,
      runtime: bootRuntime,
      sandboxId: durableSandboxId,
    } = await bootSession(resources, {
      runId,
      operation: createScenarioOperation('cold-resume'),
    });
    const preColdGateTag = `pre-cold-${runId}`;
    const sentinelPath = `sentinel-${runId}.txt`;
    const sentinelContents = `sentinel-${runId}`;
    const logCursor = await captureLogCursor();
    const preCold = await runGatedFileTurn(resources, {
      session,
      runtime: bootRuntime,
      prompt: fakeDirective('write-then-gate', preColdGateTag, sentinelPath, sentinelContents),
      gateTag: preColdGateTag,
      expectedFile: { path: sentinelPath, contents: sentinelContents },
      expectTool: 'write',
      engageTimeoutMs: remaining(resources, 'pre-cold gate'),
    });
    const preColdState = await resources.within('pre-cold sentinel capture', () =>
      inspectControlPlaneWorkspaceFile(bootRuntime, {
        kiloSessionId: session.kiloSessionId,
        filePath: sentinelPath,
      })
    );
    if (!preColdState.exists || preColdState.contents === undefined || !preColdState.dirty) {
      throw new Error('pre-cold sentinel was not captured as a dirty file');
    }
    const capturedContents = preColdState.contents;
    const sentinelHead = preColdState.head;
    const exportHadSentinelDiff = await bestEffortExportDiagnostic(resources, {
      kiloSessionId: session.kiloSessionId,
      sentinelPath,
      sentinelContents: capturedContents,
      messageId: preCold.messageId,
      assistantMarker: `done-${preColdGateTag}`,
    });
    const ownedSandbox = resources.ownership.sandbox;
    if (!ownedSandbox) throw new Error('pre-cold sandbox ownership was not captured');
    const oldContainerId = bootRuntime.container.id;
    const running = await resources.within('pre-cold container running check', async () => {
      const containers = await listSandboxContainers();
      return containers.some(container => container.id === oldContainerId);
    });
    if (!running) throw new Error(`pre-cold container ${oldContainerId} was not running`);
    const idleBudgetMs = Math.min(COLD_IDLE_BUDGET_MS, remaining(resources, 'idle stop'));
    const [idleEvidence, absent] = await resources.within('automatic idle stop', () =>
      Promise.all([
        resources.within('idle-stop log evidence', () =>
          readIdleStopEvidence({
            allocationId: durableSandboxId,
            sandboxId: durableSandboxId,
            fromByte: logCursor.fromByte,
            budgetMs: idleBudgetMs,
            cursorCapturedAt: logCursor.capturedAt,
          })
        ),
        waitForSandboxPrimaryGone(ownedSandbox, idleBudgetMs),
      ])
    );
    if (!absent)
      throw new Error(`owned container ${oldContainerId} remained running after idle stop`);
    const remainingContainers = await resources.within('post-idle container absence check', () =>
      listSandboxContainers()
    );
    if (remainingContainers.some(container => container.id === oldContainerId)) {
      throw new Error(`owned container ${oldContainerId} remained in docker ps after idle stop`);
    }
    const resumedStream = await resources.connect(session.cloudAgentSessionId, false);
    const resumedPromptTag = `resume-${runId}`;
    const resumeAdmissionOperation = createScenarioOperation('cold-resume-admission');
    resumedAdmission = {
      label: `${resumeAdmissionOperation.label} (${resumedPromptTag})`,
      operationKey: resumeAdmissionOperation.operationKey,
    };
    // The resume admission may create a new sandbox after the old one was
    // stopped. Keep both the gate and the admission ownership until the new
    // runtime is observed, even when the response is late or ambiguous.
    resources.ownedGateTags.add(resumedPromptTag);
    resources.uncertainAcquisitions.add(resumedAdmission);
    const resumedMessage = await resources.within('send gate-only resume', signal =>
      sendMessage(resources.kiloConfig, {
        cloudAgentSessionId: session.cloudAgentSessionId,
        prompt: fakeDirective('gate', resumedPromptTag),
        signal,
      })
    );
    const resumedRuntime = await waitForOwnedRuntime(resources, session.kiloSessionId);
    if (resumedRuntime.container.id === oldContainerId) {
      throw new Error('cold resume reused the old container id');
    }
    await resources.within('resume gate', () =>
      requireWorktreeGate(
        resources.config,
        resumedPromptTag,
        remaining(resources, 'resume gate'),
        resumedStream
      )
    );
    resumedAdmissionReconciled = true;
    const resumedFile = await resources.within('resumed sentinel read-only check', () =>
      inspectControlPlaneWorkspaceFile(resumedRuntime, {
        kiloSessionId: session.kiloSessionId,
        filePath: sentinelPath,
      })
    );
    if (!resumedFile.exists || resumedFile.contents !== capturedContents || !resumedFile.dirty) {
      throw new Error('resumed sentinel did not exactly match pre-cold contents');
    }
    const history = await resources.within('resumed history read-only check', () =>
      inspectControlPlaneHistory(resumedRuntime, {
        kiloSessionId: session.kiloSessionId,
        userMessageId: preCold.messageId,
        assistantMarker: `done-${preColdGateTag}`,
      })
    );
    if (!history.userEntryFound || !history.assistantEntryFound) {
      throw new Error(
        `resumed history missing pre-cold entries: user=${history.userEntryFound}; assistant=${history.assistantEntryFound}`
      );
    }
    await resources.within('release gate-only resume', signal =>
      releaseGate(resources.config.fakeLlmUrl, resumedPromptTag, signal)
    );
    resources.ownedGateTags.delete(resumedPromptTag);
    await resources.within('gate-only resume completion', () =>
      waitForOwnedCompletion(
        resumedRuntime,
        session,
        resumedMessage.messageId,
        `done-${resumedPromptTag}`,
        remaining(resources, 'gate-only resume completion')
      )
    );
    const finalFile = await resources.within('post-resume head check', () =>
      inspectControlPlaneWorkspaceFile(resumedRuntime, {
        kiloSessionId: session.kiloSessionId,
        filePath: sentinelPath,
      })
    );
    if (finalFile.head !== sentinelHead) throw new Error('resume unexpectedly changed git head');
    result = scenarioResult(
      'cold-resume',
      args,
      startedAt,
      resources.events,
      true,
      `coldAt=${idleEvidence.elapsedMs}; resumed=${resumedRuntime.container.id}; fileSurvived=true (asserted, exact-equality); historySurvived=true (asserted, pre-cold user messageId + marker); headStable=true; exportHadSentinelDiff=${exportHadSentinelDiff} (observed)`
    );
  } catch (error) {
    if (resumedAdmissionReconciled && resumedAdmission) {
      resources.uncertainAcquisitions.delete(resumedAdmission);
    }
    result = scenarioResult(
      'cold-resume',
      args,
      startedAt,
      resources.events,
      false,
      errorMessage(error)
    );
  } finally {
    if (resumedAdmissionReconciled && resumedAdmission) {
      resources.uncertainAcquisitions.delete(resumedAdmission);
    }
    const cleanup = await cleanupScenario(resources);
    result = addCleanupReport(result, cleanup);
  }
  return result;
}

export async function lifecycleMultiSessionCollab(args: LifecycleArgs): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const resources = createScenarioResources(
    args.config,
    args.timeoutMs ?? FILE_STATE_SCENARIO_TIMEOUT_MS['multi-session-collab']
  );
  let result = scenarioResult(
    'multi-session-collab',
    args,
    startedAt,
    resources.events,
    false,
    'scenario did not start'
  );
  try {
    assertScenarioPreconditions(args.config, args.api);
    const runId = randomUUID();
    const { session: planner, runtime } = await bootSession(resources, {
      runId,
      operation: createScenarioOperation('multi-session-planner'),
    });
    const planPath = `plan-${runId}.md`;
    const planContents = `plan-token-${runId}`;
    const initialHead = (
      await resources.within('initial planner HEAD capture', () =>
        inspectControlPlaneWorkspaceFile(runtime, {
          kiloSessionId: planner.kiloSessionId,
          filePath: planPath,
        })
      )
    ).head;
    const ownership = await resources.within('planner worktree ownership', () =>
      readWorktreeOwnership(args.config, [planner.kiloSessionId])
    );
    const plannerOwnership = ownership[0];
    if (!plannerOwnership?.worktreeId)
      throw new Error('planner worktree ownership was not persisted');
    const plannerTurn = await runGatedFileTurn(resources, {
      session: planner,
      runtime,
      prompt: fakeDirective('write-then-gate', `plan-${runId}`, planPath, planContents),
      gateTag: `plan-${runId}`,
      expectedFile: { path: planPath, contents: planContents },
      expectTool: 'write',
      engageTimeoutMs: remaining(resources, 'planner gate'),
    });
    if (plannerTurn.head !== initialHead) {
      throw new Error('collaboration HEAD changed during planner turn');
    }
    const implementerOperation = createScenarioOperation('multi-session-implementer');
    const implementer = await acquireTracked(
      resources,
      `create implementer chat (${implementerOperation.label})`,
      signal =>
        createWorktreeChat(
          resources.kiloConfig,
          {
            sourceKiloSessionId: planner.kiloSessionId,
            sourceCloudAgentSessionId: planner.cloudAgentSessionId,
            operationKey: implementerOperation.operationKey,
          },
          signal
        ),
      value => trackSession(resources, value),
      {
        operationKey: implementerOperation.operationKey,
        uncertainOnFailure: true,
      }
    );
    requireWorktreeSessionIdentity(implementer, 'implementer chat');
    if (implementer.kiloSessionId === planner.kiloSessionId) {
      throw new Error('implementer chat reused planner kiloSessionId');
    }
    if (implementer.worktreeId !== plannerOwnership.worktreeId) {
      throw new Error('implementer chat did not retain planner worktreeId');
    }
    const implementationPath = `impl-${runId}.ts`;
    const implementationContents = `impl-token-${runId}\n${planContents}`;
    const implementerTurn = await runGatedFileTurn(resources, {
      session: implementer,
      runtime,
      prompt: fakeDirective(
        'read-then-write',
        `impl-${runId}`,
        planPath,
        implementationPath,
        `impl-token-${runId}`
      ),
      gateTag: `impl-${runId}`,
      expectedFile: { path: implementationPath, contents: implementationContents },
      expectTool: 'read-then-write',
      engageTimeoutMs: remaining(resources, 'implementer gate'),
    });
    if (implementerTurn.head !== initialHead) {
      throw new Error('collaboration HEAD changed between planner and implementer turns');
    }
    const reviewerOperation = createScenarioOperation('multi-session-reviewer');
    const reviewer = await acquireTracked(
      resources,
      `create reviewer chat (${reviewerOperation.label})`,
      signal =>
        createWorktreeChat(
          resources.kiloConfig,
          {
            sourceKiloSessionId: planner.kiloSessionId,
            sourceCloudAgentSessionId: planner.cloudAgentSessionId,
            operationKey: reviewerOperation.operationKey,
          },
          signal
        ),
      value => trackSession(resources, value),
      {
        operationKey: reviewerOperation.operationKey,
        uncertainOnFailure: true,
      }
    );
    requireWorktreeSessionIdentity(reviewer, 'reviewer chat');
    if (
      reviewer.kiloSessionId === planner.kiloSessionId ||
      reviewer.kiloSessionId === implementer.kiloSessionId
    ) {
      throw new Error('reviewer chat did not receive a distinct kiloSessionId');
    }
    if (reviewer.worktreeId !== plannerOwnership.worktreeId) {
      throw new Error('reviewer chat did not retain planner worktreeId');
    }
    const reviewPath = `review-${runId}.md`;
    const reviewContents = `review-token-${runId}\n${implementationContents}`;
    const reviewerTurn = await runGatedFileTurn(resources, {
      session: reviewer,
      runtime,
      prompt: fakeDirective(
        'read-then-write',
        `review-${runId}`,
        implementationPath,
        reviewPath,
        `review-token-${runId}`
      ),
      gateTag: `review-${runId}`,
      expectedFile: { path: reviewPath, contents: reviewContents },
      expectTool: 'read-then-write',
      engageTimeoutMs: remaining(resources, 'reviewer gate'),
    });
    if (reviewerTurn.head !== initialHead) {
      throw new Error('collaboration HEAD changed between implementer and reviewer turns');
    }
    const rows = await resources.within('all worktree ownership', () =>
      readWorktreeOwnership(args.config, [
        planner.kiloSessionId,
        implementer.kiloSessionId,
        reviewer.kiloSessionId,
      ])
    );
    if (rows.length !== 3 || rows.some(row => row.worktreeId !== plannerOwnership.worktreeId)) {
      throw new Error('collaboration sessions did not coexist under one worktreeId');
    }
    const roots = await Promise.all(
      [planner, implementer, reviewer].map(session =>
        resources.within(`inspect ${session.kiloSessionId}`, () =>
          inspectControlPlaneKiloRoot(runtime, session.kiloSessionId)
        )
      )
    );
    if (
      roots.some(
        root => root.processId !== runtime.processId || root.directory !== runtime.directory
      )
    ) {
      throw new Error('collaboration sessions did not share one Kilo process and directory');
    }
    const files = await Promise.all(
      [
        { path: planPath, contents: planContents },
        { path: implementationPath, contents: implementationContents },
        { path: reviewPath, contents: reviewContents },
      ].map(expected =>
        resources.within(`final file ${expected.path}`, () =>
          inspectControlPlaneWorkspaceFile(runtime, {
            kiloSessionId: planner.kiloSessionId,
            filePath: expected.path,
          })
        )
      )
    );
    if (
      files.some((file, index) => {
        const expected = [planContents, implementationContents, reviewContents][index];
        return (
          !file.exists || !file.dirty || file.contents !== expected || file.head !== initialHead
        );
      })
    ) {
      throw new Error('collaboration files were not all dirty, exact, and head-stable');
    }
    const directoryFingerprint = createHash('sha256')
      .update(runtime.directory)
      .digest('hex')
      .slice(0, 12);
    result = scenarioResult(
      'multi-session-collab',
      args,
      startedAt,
      resources.events,
      true,
      `workspaces=${planner.cloudAgentSessionId},${implementer.cloudAgentSessionId},${reviewer.cloudAgentSessionId}; directoryFingerprint=${directoryFingerprint}; tokensCarried=plan→impl→review (asserted)`
    );
  } catch (error) {
    result = scenarioResult(
      'multi-session-collab',
      args,
      startedAt,
      resources.events,
      false,
      errorMessage(error)
    );
  } finally {
    const cleanup = await cleanupScenario(resources);
    result = addCleanupReport(result, cleanup);
  }
  return result;
}
