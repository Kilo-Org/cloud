/**
 * Continuity admissions shared by the local Docker and HTTP profiles:
 * `interrupt-then-continue`.
 *
 * It reaches the Worker through `prepareBrowserSession` (direct `/trpc/prepareSession`
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
 * `large-stream` is deliberately NOT admitted here. Beyond staging a workspace
 * file and reading it back, it additionally requires a matching completed
 * read-tool transcript, stream correlation of that exact read call, the
 * unchanged 48 KiB floor, and a successful paced follow-up
 * (`lifecycle-continuity.ts`), and its transcript client mints auth locally.
 * That is well beyond a bounded write-N-bytes/read-N-bytes fixture, and this
 * slice must not change `src/`. It stays local-only with its reason.
 */

import { randomUUID } from 'node:crypto';
import {
  getMessageResult,
  getSessionSnapshot,
  interruptSession,
  isMessageCompleted,
  messageIdFromEvent,
  openConnectedStream,
  prepareBrowserSession,
  releaseGate,
  sendMessage,
  type DriverConfig,
  type StreamConnection,
  type WorktreeSessionResult,
} from './client.js';
import { assertScenarioPreconditions, fakeDirective } from './lifecycle-file-state.js';
import { assertMessageLifecycle } from './lifecycle-continuity.js';
import { withOwnedGates } from './owned-gates.js';
import {
  collectChildMessageText,
  echoPayloadMatches,
  type SharedScenario,
} from './scenarios-shared.js';
import { requireWorktreeGate, requireWorktreeSessionIdentity } from './worktree-support.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { ScenarioEnvironment, SessionSandboxObservation } from './scenario-capabilities.js';

const CONTINUITY_TIMEOUT_MS = 6 * 60_000;
const SANDBOX_TIMEOUT_MS = 120_000;
const DURABLE_BUDGET_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 15_000;

/**
 * Run one operation under the scenario deadline.
 *
 * `within` rejects the await when the budget expires and aborts the signal it
 * passes to the operation. It cancels an operation only where that operation
 * forwards the signal to its transport. After the deadline change these do:
 * the tRPC reads (`getSessionSnapshot`, `getMessageResult`), `releaseGate` and
 * the gate polls (`requireWorktreeGate` -> `waitForGateEngaged` /
 * `fetchFakeScenarioStatus`) all carry the signal into their fetch;
 * `prepareBrowserSession`, `sendMessage`, `interruptSession` and
 * `openConnectedStream` already did. The stream waits (`waitForTerminal` /
 * `waitFor`) are bounded by their own timeout instead of the signal, and the
 * injected `sessionSandbox` capability takes no signal, so for those `within`
 * only rejects the await; the underlying operation still runs to its own
 * timeout.
 */
type Within = <T>(label: string, operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionSandboxObservation(env: ScenarioEnvironment): SessionSandboxObservation {
  if (!env.sessionSandbox) throw new Error('sessionSandbox capability is required');
  return env.sessionSandbox;
}

/**
 * Poll the durable message status until it is terminal or the budget elapses.
 * A single read can race the DO's terminal write, so this mirrors
 * `awaitDurableCompletion` in the continuity harness.
 */
async function awaitDurableTerminal(
  config: DriverConfig,
  sessionId: string,
  messageId: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  const deadline = Date.now() + Math.max(1, Math.min(DURABLE_BUDGET_MS, timeoutMs));
  let status = 'unknown';
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error('durable read aborted');
    status = (await getMessageResult(config, sessionId, messageId, signal)).status;
    if (status === 'completed' || status === 'failed' || status === 'interrupted') return status;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return status;
}

/**
 * Send one prompt on an existing session and require the ordered
 * `queued -> sent -> completed` stream lifecycle plus a durable `completed`.
 * The stream is closed on every failure path so a throwing helper never leaks
 * its socket. `remaining` is called before each wait so a budget captured
 * before the send is never reused for a later step.
 */
async function sendAndAwaitCompletion(
  within: Within,
  config: DriverConfig,
  sessionId: string,
  prompt: string,
  label: string,
  remaining: (label: string) => number
): Promise<{ messageId: string; stream: StreamConnection }> {
  const stream = await within(`${label} stream`, signal =>
    openConnectedStream(config, sessionId, false, undefined, signal)
  );
  try {
    const sent = await within(`${label} send`, signal =>
      sendMessage(config, { cloudAgentSessionId: sessionId, prompt, signal }, 'unified')
    );
    const terminal = await stream.waitForTerminal(remaining(`${label} terminal`), sent.messageId);
    if (!terminal) {
      throw new Error(`${label} did not reach a terminal stream event`);
    }
    const status = await within(`${label} durable status`, signal =>
      awaitDurableTerminal(config, sessionId, sent.messageId, remaining(`${label} durable`), signal)
    );
    if (status !== 'completed') {
      throw new Error(
        `${label} durable status=${status} (stream=${terminal.streamEventType} for ${sent.messageId})`
      );
    }
    assertMessageLifecycle(stream, sent.messageId, label);
    return { messageId: sent.messageId, stream };
  } catch (error) {
    stream.close();
    throw error;
  }
}

/**
 * `interrupt-then-continue`: boot a prepared browser session, park a gated
 * turn, interrupt it, assert `cloud.message.failed reason=interrupted`, then
 * complete a follow-up on the same session and assert the physical container is
 * the same one the boot turn used. No files are asserted on disk.
 */
async function interruptThenContinueBody(
  args: LifecycleArgs,
  env: ScenarioEnvironment,
  owned: Set<string>
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { config, conversation, timeoutMs = CONTINUITY_TIMEOUT_MS } = args;
  const scenarioName = 'interrupt-then-continue';
  const sandbox = sessionSandboxObservation(env);
  const runId = randomUUID();
  const tag = `interrupt-${runId}`;
  const bootMarker = `boot-${runId}`;
  const deadlineAt = startedAt + timeoutMs;
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

  const remaining = (label: string): number => {
    const left = deadlineAt - Date.now();
    if (left <= 0) throw new Error(`scenario deadline exceeded before ${label}`);
    return left;
  };

  const within: Within = async (label, operation) => {
    const budget = remaining(label);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`scenario deadline exceeded during ${label}`));
        reject(new Error(`scenario deadline exceeded during ${label}`));
      }, budget);
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  try {
    assertScenarioPreconditions(config, args.api);

    // 1. Prepared browser session (direct tRPC prepare with the e2e secret), with an echo boot turn.
    session = await within('prepare browser session', signal =>
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
    const bootContainer = await sandbox.waitForContainer({
      cloudAgentSessionId,
      kiloSessionId,
      timeoutMs: Math.max(1, Math.min(SANDBOX_TIMEOUT_MS, remaining('boot container'))),
    });
    if (bootContainer === null) {
      throw new Error('boot session did not expose a physical container');
    }

    // 3. The boot turn must complete with the boot marker before the gated turn
    //    is sent: a completed-but-wrong boot is not a valid baseline.
    const bootSnapshot = await within('boot snapshot', signal =>
      getSessionSnapshot(config, cloudAgentSessionId, signal)
    );
    const bootMessageId = bootSnapshot.initialMessageId;
    if (!bootMessageId) throw new Error('boot session did not expose initial message id');
    if (!bootSnapshot.sandboxId) {
      throw new Error('boot session did not expose a durable sandbox id');
    }
    bootStream = await within('boot stream', signal =>
      openConnectedStream(config, cloudAgentSessionId, true, undefined, signal)
    );
    const bootTerminal = await bootStream.waitForTerminal(
      remaining('boot completion'),
      bootMessageId
    );
    if (!isMessageCompleted(bootTerminal, bootMessageId)) {
      throw new Error(`boot turn ${bootMessageId} did not complete`);
    }
    const bootStatus = await within('boot durable completion', signal =>
      awaitDurableTerminal(
        config,
        cloudAgentSessionId,
        bootMessageId,
        remaining('boot durable completion'),
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

    // 4. Park a gated turn and wait for it to engage.
    gateStream = await within('gate stream', signal =>
      openConnectedStream(config, cloudAgentSessionId, false, undefined, signal)
    );
    owned.add(tag);
    const sent = await within(`send ${tag}`, signal =>
      sendMessage(
        config,
        {
          cloudAgentSessionId,
          prompt: fakeDirective('gate', tag, `done-${tag}`),
          signal,
        },
        'unified'
      )
    );
    await within(`gate ${tag}`, signal =>
      requireWorktreeGate(config, tag, remaining(`gate ${tag}`), gateStream, undefined, signal)
    );

    // 5. Interrupt the actively-streaming turn.
    await within('interrupt', signal => interruptSession(config, cloudAgentSessionId, signal));
    const failed = await gateStream.waitFor(
      event =>
        event.streamEventType === 'cloud.message.failed' &&
        messageIdFromEvent(event) === sent.messageId,
      remaining('interrupted terminal')
    );
    const data = failed?.data as { reason?: string; payload?: { reason?: string } } | undefined;
    const reason = data?.reason ?? data?.payload?.reason;
    if (reason !== 'interrupted') {
      throw new Error(
        `interrupted message ${sent.messageId} terminal reason=${reason ?? 'none'} (event=${failed?.streamEventType ?? 'none'})`
      );
    }

    // 6. Release the parked gate, then continue on the same session. The
    //    interrupt already terminated the gated turn; the release drops the
    //    fake's parked waiter. If it fails, the tag stays owned: the shared
    //    wrapper retries after the body and fails the run when it is still
    //    parked.
    try {
      await within(`release ${tag}`, signal => releaseGate(config.fakeLlmUrl, tag, signal));
      owned.delete(tag);
    } catch {
      // Ownership is deliberately retained for the wrapper's leak check.
    }
    const followup = await sendAndAwaitCompletion(
      within,
      config,
      cloudAgentSessionId,
      fakeDirective(`echo:continue-${runId}`),
      'follow-up',
      remaining
    );
    followupStream = followup.stream;

    // 7. The same physical container as the boot turn across the interrupt.
    const after = await within('post-interrupt container', () =>
      sandbox.currentContainer({ cloudAgentSessionId, kiloSessionId })
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
  return withOwnedGates('interrupt-then-continue', args, owned =>
    interruptThenContinueBody(args, env, owned)
  );
}

export const CONTINUITY_SHARED_SCENARIOS: Record<string, SharedScenario> = {
  'interrupt-then-continue': {
    name: 'interrupt-then-continue',
    requires: ['sessionSandbox'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: CONTINUITY_TIMEOUT_MS,
    run: runInterruptThenContinue,
  },
};
