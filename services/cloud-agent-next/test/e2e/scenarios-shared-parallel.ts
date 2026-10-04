/**
 * `worktree-multi-chat-parallel` — plan B11.
 *
 * The existing `worktree-multi-chat` deliberately cannot prove concurrent
 * streaming: it holds a `slow` turn in the root and only then starts sibling
 * work, because the legacy runtime services one model turn at a time. The new
 * control plane (spec §11 scenario 5) must stream two chats in one worktree at
 * the same instant.
 *
 * This scenario creates a root worktree chat and a sibling, then dispatches a
 * bounded `slow` hold to BOTH chats before either can finish. It requires both
 * turns to be durably `running` at the same observation, both streams to show
 * correlated progress, and both turns to complete. On a plane that serializes
 * model turns the second send is queued, `requireRunning` fails, and the
 * scenario fails — which is the point.
 *
 * It declares `controlPlaneV2`, so it reports `unsupported` until the operator
 * opts in with `E2E_CONTROL_PLANE_V2=1` (C1 routes the new plane).
 */

import { randomUUID } from 'node:crypto';
import {
  fakeDirective,
  fetchFakeRequests,
  isMessageCompleted,
  openConnectedStream,
  sendMessage,
  type StreamConnection,
  type StreamEvent,
  type WorktreeSessionResult,
} from './client.js';
import { cleanupRemoteSession, type SharedScenario } from './scenarios-shared.js';
import {
  bootToCompletion,
  createOwnedSessionRegistry,
  createScenarioDeadline,
  requireRunning,
  trackCreations,
  waitForPacedProgress,
  waitForPresentAllocation,
} from './scenarios-shared-runtime.js';
import {
  assertChatContentIsolation,
  createSiblingChat,
  prepareWorktreeChat,
} from './scenarios-shared-worktrees.js';
import {
  assertScenarioPreconditions,
  requireWorktreeSessionIdentity,
} from './public-surface-support.js';
import { CONTROL_PLANE_WRAPPER_BASENAME } from './sandbox-control.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { ScenarioEnvironment } from './scenario-capabilities.js';

const PARALLEL_TIMEOUT_MS = 25 * 60_000;
const BOOT_BUDGET_MS = 240_000;
/** Per-turn budget once the worktree is warm. */
const TURN_BUDGET_MS = 180_000;
/** The paced hold both chats run at once; long enough to overlap reliably. */
const PARALLEL_HOLD_DIRECTIVE = 'slow:60:1000:16';
const PACED_PROGRESS_BUDGET_MS = 90_000;
/** Bounded settle for a create that outlived the scenario deadline. */
const LATE_CREATE_SETTLE_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runWorktreeMultiChatParallel(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = PARALLEL_TIMEOUT_MS } = args;
  const scenarioName = 'worktree-multi-chat-parallel';
  const sandbox = env.sessionSandbox;
  const runtime = env.controlPlaneRuntime;
  if (!sandbox) throw new Error('sessionSandbox capability is required');
  if (!runtime) throw new Error('controlPlaneRuntime capability is required');
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const runId = randomUUID();
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<WorktreeSessionResult>(deadline, owned, scenarioName);

  const events: StreamEvent[] = [];
  let rootParallelStream: StreamConnection | undefined;
  let siblingParallelStream: StreamConnection | undefined;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: [...events],
    durationMs: Date.now() - startedAt,
  });

  try {
    assertScenarioPreconditions(scenarioConfig, args.api);

    // Root boot: prepareBrowserSession auto-initiates the initial turn.
    const root = await prepareWorktreeChat(creations, scenarioConfig, {
      prompt: fakeDirective(`echo:root-parallel-${runId}`),
      operationKey: randomUUID(),
    });
    owned.register(root);
    const rootBoot = await bootToCompletion(
      deadline,
      scenarioConfig,
      root,
      'root boot',
      text => text.includes(`root-parallel-${runId}`),
      BOOT_BUDGET_MS
    );
    events.push(...rootBoot.stream.events);
    rootBoot.stream.close();

    // Prove the new plane before asserting concurrency: a `workspace_*` id is
    // also produced by the legacy plane, so an opted-in run must fail rather
    // than false-pass if the container runs the legacy wrapper.
    const allocation = await waitForPresentAllocation(
      deadline,
      sandbox,
      root,
      'root parallel allocation',
      BOOT_BUDGET_MS
    );
    if (allocation === null) throw new Error('root parallel did not expose an allocation');
    await runtime.proveNewPlane({
      cloudAgentSessionId: root.cloudAgentSessionId,
      kiloSessionId: root.kiloSessionId,
      expectedAllocationRef: allocation,
      wrapperProcessBasename: CONTROL_PLANE_WRAPPER_BASENAME,
    });

    const sibling = await createSiblingChat(
      creations,
      scenarioConfig,
      root,
      randomUUID(),
      BOOT_BUDGET_MS
    );
    owned.register(sibling);
    requireWorktreeSessionIdentity(sibling, 'parallel sibling');

    const rootId = root.cloudAgentSessionId;
    const siblingId = sibling.cloudAgentSessionId;

    rootParallelStream = await deadline.within('root parallel stream', signal =>
      openConnectedStream(scenarioConfig, rootId, false, undefined, signal)
    );
    siblingParallelStream = await deadline.within('sibling parallel stream', signal =>
      openConnectedStream(scenarioConfig, siblingId, false, undefined, signal)
    );

    // A fresh counter baseline per chat: the root's dispatch must not satisfy
    // the sibling's own progress check.
    const beforeRoot = await deadline.within('root parallel baseline', () =>
      fetchFakeRequests(scenarioConfig.fakeLlmUrl)
    );
    const rootSend = await deadline.within('root parallel send', signal =>
      sendMessage(
        scenarioConfig,
        { cloudAgentSessionId: rootId, prompt: fakeDirective(PARALLEL_HOLD_DIRECTIVE), signal },
        'unified'
      )
    );
    const beforeSibling = await deadline.within('sibling parallel baseline', () =>
      fetchFakeRequests(scenarioConfig.fakeLlmUrl)
    );
    const siblingSend = await deadline.within('sibling parallel send', signal =>
      sendMessage(
        scenarioConfig,
        {
          cloudAgentSessionId: siblingId,
          prompt: fakeDirective(PARALLEL_HOLD_DIRECTIVE),
          signal,
        },
        'unified'
      )
    );

    await deadline.within('root parallel progress', () =>
      waitForPacedProgress(
        scenarioConfig,
        rootParallelStream as StreamConnection,
        rootSend.messageId,
        beforeRoot.chatCompletions,
        deadline,
        PACED_PROGRESS_BUDGET_MS,
        'root parallel progress'
      )
    );
    await deadline.within('sibling parallel progress', () =>
      waitForPacedProgress(
        scenarioConfig,
        siblingParallelStream as StreamConnection,
        siblingSend.messageId,
        beforeSibling.chatCompletions,
        deadline,
        PACED_PROGRESS_BUDGET_MS,
        'sibling parallel progress'
      )
    );

    // The concurrency proof: both turns are durably `running` at the same
    // observation. A serializing plane leaves one queued and fails here.
    await requireRunning(scenarioConfig, rootId, rootSend.messageId, deadline, 'root parallel');
    await requireRunning(
      scenarioConfig,
      siblingId,
      siblingSend.messageId,
      deadline,
      'sibling parallel'
    );

    const rootTerminal = await rootParallelStream.waitForTerminal(
      Math.max(1, Math.min(TURN_BUDGET_MS, deadline.remaining('root parallel terminal'))),
      rootSend.messageId
    );
    if (!isMessageCompleted(rootTerminal, rootSend.messageId)) {
      throw new Error(`root parallel turn ${rootSend.messageId} did not complete`);
    }
    const siblingTerminal = await siblingParallelStream.waitForTerminal(
      Math.max(1, Math.min(TURN_BUDGET_MS, deadline.remaining('sibling parallel terminal'))),
      siblingSend.messageId
    );
    if (!isMessageCompleted(siblingTerminal, siblingSend.messageId)) {
      throw new Error(`sibling parallel turn ${siblingSend.messageId} did not complete`);
    }

    assertChatContentIsolation(
      'root parallel chat',
      rootParallelStream.events,
      [siblingSend.messageId],
      []
    );
    assertChatContentIsolation(
      'sibling parallel chat',
      siblingParallelStream.events,
      [rootSend.messageId],
      []
    );

    events.push(...rootParallelStream.events, ...siblingParallelStream.events);
    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `root=${rootId}; sibling=${siblingId}; both=running-then-completed; ` +
        `rootMessage=${rootSend.messageId}; siblingMessage=${siblingSend.messageId}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    for (const stream of [rootParallelStream, siblingParallelStream]) {
      try {
        stream?.close();
      } catch {
        /* best-effort close */
      }
    }
    for (const late of await creations.settleAll(LATE_CREATE_SETTLE_MS)) {
      owned.register(late);
    }
    await owned.cleanup(scenarioName);
  }
  return result;
}

export const PARALLEL_SHARED_SCENARIOS: Record<string, SharedScenario> = {
  'worktree-multi-chat-parallel': {
    name: 'worktree-multi-chat-parallel',
    requires: ['sessionSandbox', 'controlPlaneRuntime', 'controlPlaneV2'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: PARALLEL_TIMEOUT_MS,
    requiresWorktreeCreation: true,
    run: runWorktreeMultiChatParallel,
  },
};
