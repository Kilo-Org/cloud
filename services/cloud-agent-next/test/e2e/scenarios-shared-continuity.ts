/**
 * Continuity and idle admissions shared by the local Docker and HTTP profiles:
 * `interrupt-then-continue` and `question-idle-resume`.
 *
 * They reach the Worker through `prepareBrowserSession` (direct `/trpc/prepareSession`
 * with the e2e internal secret) for session creation, tRPC for send/interrupt/snapshot,
 * and the WebSocket stream for terminal evidence. Physical container identity comes from the
 * injected `sessionSandbox` capability, so the same definition works under
 * local Docker and over the e2e HTTP surface.
 *
 * The container observation is deliberately coarser than the original
 * Docker-only runtime lookup: local Docker passes an empty exclusion set, so it
 * reports the session's container without proving it appeared after a
 * pre-start snapshot, and the HTTP profile reads the persisted provider
 * reference rather than a live runtime observation. See
 * `scenario-capabilities.ts` for the exact contract.
 *
 * `large-stream` lives in `scenarios-shared-load.ts`: beyond staging a workspace
 * file and reading it back, it additionally requires a matching completed
 * read-tool transcript and stream correlation of that exact read call.
 */

import { randomUUID } from 'node:crypto';
import {
  fakeDirective,
  fetchFakeRequests,
  fetchFakeScenarioStatus,
  getSessionSnapshot,
  interruptSession,
  isMessageCompleted,
  messageIdFromEvent,
  openConnectedStream,
  prepareBrowserSession,
  sendMessage,
  type DriverConfig,
  type StreamConnection,
  type StreamEvent,
  type WorktreeSessionResult,
} from './client.js';
import {
  assertScenarioPreconditions,
  requireWorktreeSessionIdentity,
} from './public-surface-support.js';
import { assertMessageLifecycle } from './scenario-assertions.js';
import {
  cleanupRemoteSession,
  collectChildMessageText,
  echoPayloadMatches,
  type SharedScenario,
} from './scenarios-shared.js';
import {
  awaitDurableTerminal,
  createOwnedSessionRegistry,
  createScenarioDeadline,
  readAllocation,
  requireRunning,
  sendTurn,
  sessionSandboxObservation,
  trackCreations,
  waitForPacedProgress,
  waitForPresentAllocation,
  type ScenarioDeadline,
} from './scenarios-shared-runtime.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { ScenarioEnvironment } from './scenario-capabilities.js';

const CONTINUITY_TIMEOUT_MS = 6 * 60_000;
const SANDBOX_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 15_000;
const PACED_PROGRESS_BUDGET_MS = 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Send one prompt on an existing session and require the ordered
 * `queued -> sent -> completed` stream lifecycle plus a durable `completed`
 * (owned by `sendTurn`). The stream is closed when the ordered-lifecycle
 * assertion throws, because `sendTurn` owns the failure-path close only up to
 * its own return.
 */
async function sendAndAwaitCompletion(
  deadline: ScenarioDeadline,
  config: DriverConfig,
  sessionId: string,
  prompt: string,
  label: string
): Promise<{ messageId: string; stream: StreamConnection }> {
  const { messageId, stream } = await sendTurn(deadline, config, sessionId, prompt, label);
  try {
    assertMessageLifecycle(stream, messageId, label);
  } catch (error) {
    stream.close();
    throw error;
  }
  return { messageId, stream };
}

/**
 * `interrupt-then-continue`: boot a prepared browser session, start a bounded
 * paced turn and require it `running`, interrupt it, assert
 * `cloud.message.failed reason=interrupted`, then complete a follow-up on the
 * same session and assert the physical container is the same one the boot turn
 * used. No files are asserted on disk.
 */
async function interruptThenContinueBody(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = CONTINUITY_TIMEOUT_MS } = args;
  const scenarioName = 'interrupt-then-continue';
  const sandbox = sessionSandboxObservation(env);
  const runId = randomUUID();
  const bootMarker = `boot-${runId}`;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  let session: WorktreeSessionResult | undefined;
  let bootStream: StreamConnection | undefined;
  let gateStream: StreamConnection | undefined;
  let followupStream: StreamConnection | undefined;
  let completed = false;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: [
      ...(bootStream?.events ?? []),
      ...(gateStream?.events ?? []),
      ...(followupStream?.events ?? []),
    ],
    durationMs: Date.now() - startedAt,
  });

  try {
    assertScenarioPreconditions(config, args.api);

    // 1. Prepared browser session (direct tRPC prepare with the e2e secret), with an echo boot turn.
    session = await deadline.within('prepare browser session', signal =>
      prepareBrowserSession(
        config,
        {
          prompt: fakeDirective(`echo:${bootMarker}`),
          operationKey: randomUUID(),
          autoCommit: false,
        },
        signal
      )
    );
    requireWorktreeSessionIdentity(session, 'boot session');
    const { cloudAgentSessionId, kiloSessionId } = session;

    // 2. The physical container (replaces the local-only runtime discovery).
    const bootContainer = await deadline.within('boot container', signal =>
      sandbox.waitForContainer({
        cloudAgentSessionId,
        kiloSessionId,
        timeoutMs: Math.max(1, Math.min(SANDBOX_TIMEOUT_MS, deadline.remaining('boot container'))),
        signal,
      })
    );
    if (bootContainer === null) {
      throw new Error('boot session did not expose a physical container');
    }

    // 3. The boot turn must complete with the boot marker before the gated turn
    //    is sent: a completed-but-wrong boot is not a valid baseline.
    const bootSnapshot = await deadline.within('boot snapshot', signal =>
      getSessionSnapshot(config, cloudAgentSessionId, signal)
    );
    const bootMessageId = bootSnapshot.initialMessageId;
    if (!bootMessageId) throw new Error('boot session did not expose initial message id');
    if (!bootSnapshot.sandboxId) {
      throw new Error('boot session did not expose a durable sandbox id');
    }
    bootStream = await deadline.within('boot stream', signal =>
      openConnectedStream(config, cloudAgentSessionId, true, undefined, signal)
    );
    const bootTerminal = await bootStream.waitForTerminal(
      deadline.remaining('boot completion'),
      bootMessageId
    );
    if (!isMessageCompleted(bootTerminal, bootMessageId)) {
      throw new Error(`boot turn ${bootMessageId} did not complete`);
    }
    const bootStatus = await deadline.within('boot durable completion', signal =>
      awaitDurableTerminal(
        config,
        cloudAgentSessionId,
        bootMessageId,
        deadline.remaining('boot durable completion'),
        signal
      )
    );
    if (bootStatus !== 'completed') throw new Error(`boot turn durable status=${bootStatus}`);
    const bootText = collectChildMessageText(bootStream.events, bootMessageId);
    if (!echoPayloadMatches(bootText, bootMarker)) {
      throw new Error(
        `boot turn ${bootMessageId} did not complete with ${JSON.stringify(bootMarker)}; observed ${JSON.stringify(bootText)}`
      );
    }
    bootStream.close();
    bootStream = undefined;

    // 4. Start a bounded paced turn and wait until it is actually running. The
    //    slow directive is the hold: no gate to release, and the fake completes
    //    it on its own if the interrupt does not arrive first.
    gateStream = await deadline.within('paced stream', signal =>
      openConnectedStream(config, cloudAgentSessionId, false, undefined, signal)
    );
    const requestsBefore = await deadline.within('paced request baseline', signal =>
      fetchFakeRequests(config.fakeLlmUrl, signal)
    );
    const sent = await deadline.within('send paced', signal =>
      sendMessage(
        config,
        {
          cloudAgentSessionId,
          prompt: fakeDirective('slow:90:1000:16'),
          signal,
        },
        'unified'
      )
    );
    await waitForPacedProgress(
      config,
      gateStream,
      sent.messageId,
      requestsBefore.chatCompletions,
      deadline,
      PACED_PROGRESS_BUDGET_MS,
      'paced progress'
    );
    await requireRunning(config, cloudAgentSessionId, sent.messageId, deadline, 'paced turn');

    // 5. Interrupt the actively-streaming turn.
    await deadline.within('interrupt', signal =>
      interruptSession(config, cloudAgentSessionId, signal)
    );
    const failed = await gateStream.waitFor(
      event =>
        event.streamEventType === 'cloud.message.failed' &&
        messageIdFromEvent(event) === sent.messageId,
      deadline.remaining('interrupted terminal')
    );
    const data = failed?.data as { reason?: string; payload?: { reason?: string } } | undefined;
    const reason = data?.reason ?? data?.payload?.reason;
    if (reason !== 'interrupted') {
      throw new Error(
        `interrupted message ${sent.messageId} terminal reason=${reason ?? 'none'} (event=${failed?.streamEventType ?? 'none'})`
      );
    }

    // 6. Continue on the same session.
    const followup = await sendAndAwaitCompletion(
      deadline,
      config,
      cloudAgentSessionId,
      fakeDirective(`echo:continue-${runId}`),
      'follow-up'
    );
    followupStream = followup.stream;

    // 7. The same physical container as the boot turn across the interrupt.
    const after = await deadline.within('post-interrupt container', signal =>
      sandbox.currentContainer({ cloudAgentSessionId, kiloSessionId, signal })
    );
    if (!after || after !== bootContainer) {
      throw new Error(
        `container changed after interrupt: boot=${bootContainer}; after=${after ?? 'none'}`
      );
    }

    completed = true;
    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message: [
        `session=${cloudAgentSessionId}`,
        `interruptedMessage=${sent.messageId}`,
        `reason=${reason}`,
        `followUpMessage=${followup.messageId}`,
        `container=${bootContainer}`,
        'sameContainer=true',
      ].join('; '),
      events: [...gateStream.events, ...followupStream.events],
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    for (const stream of [bootStream, gateStream, followupStream]) {
      try {
        stream?.close();
      } catch {
        // A close failure must not replace the scenario result.
      }
    }
    if (!completed && session) {
      await interruptSession(
        config,
        session.cloudAgentSessionId,
        AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
      ).catch(() => {});
    }
  }
  return result;
}

export async function runInterruptThenContinue(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  return interruptThenContinueBody(args, env);
}

// ---------------------------------------------------------------------------
// question-idle-resume
// ---------------------------------------------------------------------------

const QUESTION_IDLE_TIMEOUT_MS = 30 * 60_000;
/** The plan's 15-minute idle window in which the allocation must disappear. */
const QUESTION_IDLE_WINDOW_MS = 15 * 60_000;
/** Unattended-interval poll cadence. */
const IDLE_POLL_INTERVAL_MS = 15_000;
/** Generous budget for a real first container cold start. */
const BOOT_TERMINAL_BUDGET_MS = 240_000;
const CONTAINER_BUDGET_MS = 240_000;
/** Warm-turn budget once the container exists. */
const TURN_BUDGET_MS = 120_000;
/** Budget for the resume turn after a replacement allocation. */
const RESUME_TURN_BUDGET_MS = 240_000;
/** Bound for the replacement allocation after the resume send. */
const RESUME_CONTAINER_BUDGET_MS = 180_000;
/** Bounded wait for a create that outlived the scenario deadline. */
const LATE_CREATE_SETTLE_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The owning chat's open question, parsed from its own stream. The session id
 * is the root `ses_*` identity, so a sibling's question never matches.
 */
function questionAsked(
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

/**
 * `question-idle-resume`: leave a real Kilo question unanswered. The question
 * must be visible on its owning stream (`toolResults.question=0`, so it was
 * never answered), the session allocation must disappear inside the 15-minute
 * idle window, the parked message must reach a durable terminal before the
 * continuation, and a follow-up must complete on a distinct non-null
 * allocation reference. The control-plane checkout inspection and heartbeat
 * log attribution the local-only version used are dropped: they are mechanism,
 * not the user-visible promise.
 */
async function runQuestionIdleResume(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = QUESTION_IDLE_TIMEOUT_MS } = args;
  const scenarioName = 'question-idle-resume';
  const sandbox = sessionSandboxObservation(env);
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<WorktreeSessionResult>(deadline, owned, scenarioName);
  const runId = randomUUID().slice(0, 8);
  const questionTag = `question-idle-${runId}`;
  const questionText = `Should this session idle? ${runId}`;
  const events: StreamEvent[] = [];
  const streams: StreamConnection[] = [];
  let result: LifecycleResult;
  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events,
    durationMs: Date.now() - startedAt,
  });

  try {
    assertScenarioPreconditions(scenarioConfig, args.api);

    const session = await creations.run('prepare session', signal =>
      prepareBrowserSession(
        scenarioConfig,
        {
          prompt: fakeDirective(`echo:boot-${runId}`),
          operationKey: randomUUID(),
          autoCommit: false,
        },
        signal
      )
    );
    owned.register(session);
    requireWorktreeSessionIdentity(session, 'question session');
    const sessionId = session.cloudAgentSessionId;

    const bootStream = await deadline.within('boot stream', signal =>
      openConnectedStream(scenarioConfig, sessionId, true, undefined, signal)
    );
    streams.push(bootStream);
    const bootSnapshot = await deadline.within('boot snapshot', signal =>
      getSessionSnapshot(scenarioConfig, sessionId, signal)
    );
    const bootMessageId = bootSnapshot.initialMessageId;
    if (!bootMessageId) throw new Error('question session did not expose an initial message id');
    const bootTerminal = await bootStream.waitForTerminal(
      Math.max(1, Math.min(BOOT_TERMINAL_BUDGET_MS, deadline.remaining('boot terminal'))),
      bootMessageId
    );
    if (!isMessageCompleted(bootTerminal, bootMessageId)) {
      throw new Error(`boot turn ${bootMessageId} did not complete`);
    }
    const bootStatus = await deadline.within('boot durable', signal =>
      awaitDurableTerminal(
        scenarioConfig,
        sessionId,
        bootMessageId,
        deadline.remaining('boot durable'),
        signal
      )
    );
    if (bootStatus !== 'completed') throw new Error(`boot turn durable status=${bootStatus}`);
    const bootText = collectChildMessageText(bootStream.events, bootMessageId);
    if (!echoPayloadMatches(bootText, `boot-${runId}`)) {
      throw new Error(`boot turn did not echo boot-${runId}`);
    }
    const allocation = await waitForPresentAllocation(
      deadline,
      sandbox,
      session,
      'boot',
      CONTAINER_BUDGET_MS
    );
    if (allocation === null) throw new Error('question session did not expose an allocation');

    // The unanswered real question. It stays parked on its own stream; the
    // stream is kept open so the idle stop can happen without a client watch.
    const questionStream = await deadline.within('question stream', signal =>
      openConnectedStream(scenarioConfig, sessionId, false, undefined, signal)
    );
    streams.push(questionStream);
    const question = await deadline.within(
      'send question',
      signal =>
        sendMessage(
          scenarioConfig,
          {
            cloudAgentSessionId: sessionId,
            prompt: fakeDirective(`question:${questionTag}:${questionText}`),
            signal,
          },
          'unified'
        ),
      TURN_BUDGET_MS
    );
    const asked = await questionStream.waitFor(
      event => questionAsked(event, session.kiloSessionId) !== null,
      Math.max(1, Math.min(TURN_BUDGET_MS, deadline.remaining('question asked')))
    );
    if (!asked) throw new Error(`question ${questionTag} did not reach its owning stream`);
    const questionEventCount = questionStream.events.filter(
      event => questionAsked(event, session.kiloSessionId) !== null
    ).length;
    const questionStatus = await deadline.within('question status', signal =>
      fetchFakeScenarioStatus(scenarioConfig.fakeLlmUrl, questionTag, signal)
    );
    if (questionStatus.toolResults.question !== 0) {
      throw new Error(
        `question ${questionTag} was answered before the idle window (toolResults.question=${questionStatus.toolResults.question})`
      );
    }

    // The unattended interval: the allocation must disappear inside the window.
    const idleEnd = Date.now() + Math.min(QUESTION_IDLE_WINDOW_MS, deadline.remaining('idle window'));
    let consecutiveAbsent = 0;
    let absent = false;
    while (Date.now() < idleEnd) {
      const observed = await readAllocation(deadline, sandbox, session, 'idle sample');
      if (observed === null) {
        consecutiveAbsent += 1;
        if (consecutiveAbsent >= 2) {
          absent = true;
          break;
        }
      } else {
        consecutiveAbsent = 0;
      }
      await sleep(Math.min(IDLE_POLL_INTERVAL_MS, Math.max(0, idleEnd - Date.now())));
    }
    if (!absent) {
      throw new Error(
        `allocation reference ${allocation} was still present after ${QUESTION_IDLE_WINDOW_MS}ms; the unanswered question must not pin the environment`
      );
    }

    // The parked turn must settle before the continuation.
    const parkedStatus = await deadline.within('parked terminal', signal =>
      awaitDurableTerminal(
        scenarioConfig,
        sessionId,
        question.messageId,
        deadline.remaining('parked terminal'),
        signal
      )
    );
    if (parkedStatus === 'queued' || parkedStatus === 'running' || parkedStatus === 'unknown') {
      throw new Error(
        `parked question ${question.messageId} did not settle before the continuation (durable=${parkedStatus})`
      );
    }

    const resume = await sendTurn(
      deadline,
      scenarioConfig,
      sessionId,
      fakeDirective(`echo:resume-${runId}`),
      'resume turn',
      RESUME_TURN_BUDGET_MS
    );
    streams.push(resume.stream);
    const resumeText = collectChildMessageText(resume.stream.events, resume.messageId);
    if (!echoPayloadMatches(resumeText, `resume-${runId}`)) {
      throw new Error(`resume turn did not echo resume-${runId}`);
    }
    const replacement = await waitForPresentAllocation(
      deadline,
      sandbox,
      session,
      'resume',
      RESUME_CONTAINER_BUDGET_MS
    );
    if (replacement === null || replacement === allocation) {
      throw new Error(
        `resume did not expose a replacement allocation: old=${allocation}; new=${replacement ?? 'none'}`
      );
    }
    events.push(...resume.stream.events);

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `session=${sessionId}; questionId=${questionEventCount === 1 ? 'asked' : `events=${questionEventCount}`}; ` +
        `questionScoped=${questionEventCount}; unanswered=true; questionMessage=${question.messageId}; ` +
        `idleAllocationAbsent=true; parkedStatus=${parkedStatus}; ` +
        `postRestoreAllocation=${replacement}!=${allocation}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    for (const stream of streams) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    }
    for (const late of await creations.settleAll(LATE_CREATE_SETTLE_MS)) {
      owned.register(late);
    }
    await owned.cleanup(scenarioName);
  }
  return result;
}

export const CONTINUITY_SHARED_SCENARIOS: Record<string, SharedScenario> = {
  'interrupt-then-continue': {
    name: 'interrupt-then-continue',
    requires: ['sessionSandbox'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: CONTINUITY_TIMEOUT_MS,
    requiresWorktreeCreation: true,
    run: runInterruptThenContinue,
  },
  'question-idle-resume': {
    name: 'question-idle-resume',
    requires: ['sessionSandbox'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: QUESTION_IDLE_TIMEOUT_MS,
    requiresWorktreeCreation: true,
    run: runQuestionIdleResume,
  },
};
