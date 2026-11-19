/**
 * Interaction-list bound acceptance — drives the real `@kilocode/cloud-agent-sdk`
 * client against this worktree's stack and records what the client hands its
 * consumers for an interaction payload that is over the schema bound.
 *
 * One question, observed twice:
 *   1. On the raw stream, from the frame real kilo produced. This is the
 *      payload the wire actually carried.
 *   2. On a fresh SDK connection, through the pending-interaction restore the
 *      transport performs after `connected`. This is what a consumer sees.
 *
 * The question is asked with `question:<tag>:<count>:<text>`, an opt-in form of
 * the fake model's `question` directive that emits `<count>` options.
 *
 * Only model inference is deterministic. The Worker, the Session DO, the
 * sandbox, the wrapper, and the pinned kilo binary are the real ones.
 *
 * Run from the repository root with the stack up:
 *
 *   WORKER_URL=http://localhost:8794 FAKE_LLM_URL=http://localhost:8811 \
 *     E2E_FUNDED=1 pnpm -s exec tsx \
 *     services/cloud-agent-next/test/e2e/interaction-bounds.ts
 *
 * Prints one `VERDICT <json>` line. Run it in a base worktree and in the branch
 * worktree against the same stack to compare the two behaviors.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DRIVER_USER_EMAIL_SUFFIX, ensureTestUser, loadDevVars, loadRepoEnvFiles } from './auth.js';
import {
  DEFAULT_CONFIG,
  deleteSession,
  fakeDirective,
  openConnectedStream,
  resolveStreamTicket,
  sendMessage,
  startSession,
  trpcCall,
  type DriverConfig,
  type StartSessionResult,
  type StreamEvent,
} from './client.js';
import { currentOwnedSandbox, stopOwnedSandboxFamily } from './lifecycle.js';
import { createCloudAgentTransport } from '../../../../packages/cloud-agent-sdk/src/cloud-agent-transport.js';
import { createChatProcessor } from '../../../../packages/cloud-agent-sdk/src/chat-processor.js';
import { createMemoryStorage } from '../../../../packages/cloud-agent-sdk/src/storage/memory.js';
import type { ServiceEvent } from '../../../../packages/cloud-agent-sdk/src/normalizer.js';
import type {
  CloudAgentSessionId,
  KiloSessionId,
} from '../../../../packages/cloud-agent-sdk/src/types.js';

const SERVICE_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SETTLE_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 500;

/**
 * Options requested from the fake model: one past the bound this revision
 * enforces. A literal rather than the imported constant, so the same driver
 * file runs against a base revision whose schemas module has no bound yet.
 */
const EMITTED_OPTIONS = 33;
/** Value of `SESSION_QUESTION_MAX_OPTIONS` in the revision under test. */
const CLIENT_MAXIMUM = 32;

type QuestionSink = Extract<ServiceEvent, { type: 'question.asked' }>;

type Verdict = {
  bound: 'question-options';
  emittedOptions: number;
  clientMaximum: number;
  /** Options the wire frame carried, or null when no frame arrived. */
  wireOptions: number | null;
  /** Questions the SDK handed its consumer, or null when it delivered none. */
  sdkQuestions: number | null;
  /** Option counts of those questions. */
  sdkOptions: number[];
};

async function pollFor<T>(
  action: () => T | undefined,
  label: string,
  timeoutMs = SETTLE_TIMEOUT_MS
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = action();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `${label} did not settle in ${timeoutMs}ms${lastError ? `: ${String(lastError)}` : ''}`
  );
}

/**
 * Count the options on a raw `kilocode` frame. The frame's `data` is the SDK's
 * unparsed event envelope, so each level is narrowed rather than cast.
 */
function optionCountOfFrame(frame: StreamEvent): number | null {
  if (!('properties' in frame.data)) return null;
  const envelope = frame.data.properties;
  if (typeof envelope !== 'object' || envelope === null) return null;
  if (!('questions' in envelope)) return null;
  const questions = envelope.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const first: unknown = questions[0];
  if (typeof first !== 'object' || first === null || !('options' in first)) return null;
  const options = first.options;
  return Array.isArray(options) ? options.length : null;
}

function isQuestionFrame(frame: StreamEvent): boolean {
  if (frame.streamEventType !== 'kilocode') return false;
  if (!('type' in frame.data)) return false;
  return frame.data.type === 'question.asked';
}

/**
 * Attach the real SDK and collect the pending question it restores. The
 * transport drops a `question.asked` that arrives before its snapshot resolves
 * and replays the pending interaction after `connected`, so attaching to an
 * already-pending question is the path that carries the stored payload.
 */
async function sdkQuestionVerdict(
  config: DriverConfig,
  root: StartSessionResult
): Promise<QuestionSink | null> {
  const received: QuestionSink[] = [];
  const storage = createMemoryStorage();
  const processor = createChatProcessor(storage);
  let replayComplete = false;
  const transport = createCloudAgentTransport({
    sessionId: root.cloudAgentSessionId as CloudAgentSessionId,
    kiloSessionId: root.kiloSessionId as KiloSessionId,
    websocketBaseUrl: config.workerUrl.replace(/^http/, 'ws'),
    getTicket: sessionId => resolveStreamTicket(config, sessionId),
    fetchCloudSnapshotPage: async () =>
      trpcCall<unknown>(
        config,
        'getSessionMessagesPage',
        { sessionId: root.cloudAgentSessionId },
        { method: 'GET' }
      ),
    api: {
      send: input => {
        if (input.payload.type !== 'prompt') throw new Error('prompt turns only');
        return sendMessage(config, {
          cloudAgentSessionId: input.sessionId,
          prompt: input.payload.prompt,
          messageId: input.messageId,
        });
      },
      interrupt: async () => undefined,
      answer: async () => undefined,
      reject: async () => undefined,
      respondToPermission: async () => undefined,
    },
    onError: error => {
      throw error;
    },
  })({
    onChatEvent(event) {
      processor.process(event);
    },
    onServiceEvent(event) {
      if (event.type === 'question.asked') received.push(event);
    },
    onReplayComplete() {
      replayComplete = true;
    },
  });
  transport.connect();
  try {
    await pollFor(() => (replayComplete ? true : undefined), 'SDK bootstrap');
    await pollFor(() => received[0], 'restored question.asked').catch(() => undefined);
    return received[0] ?? null;
  } finally {
    transport.destroy();
  }
}

async function main(): Promise<void> {
  loadRepoEnvFiles(SERVICE_PACKAGE_DIR);
  const devVars = loadDevVars(SERVICE_PACKAGE_DIR);
  const email = `kilo-interaction-bounds-${Date.now()}${DRIVER_USER_EMAIL_SUFFIX}`;
  const user = await ensureTestUser(process.env.DATABASE_URL, email, { funded: true });
  const config: DriverConfig = {
    ...DEFAULT_CONFIG,
    user,
    nextAuthSecret: devVars.NEXTAUTH_SECRET ?? '',
    internalApiSecret: devVars.INTERNAL_API_SECRET ?? '',
    workerUrl: process.env.WORKER_URL ?? DEFAULT_CONFIG.workerUrl,
    gitUrl: process.env.E2E_GIT_URL ?? DEFAULT_CONFIG.gitUrl,
    model: process.env.E2E_MODEL ?? DEFAULT_CONFIG.model,
  };
  const questionTag = `bounds-${randomUUID().slice(0, 8)}`;

  const root = await startSession(config, { prompt: fakeDirective('echo:bootstrap') });
  const stream = await openConnectedStream(config, root.cloudAgentSessionId);
  try {
    await stream.waitFor(
      event =>
        event.streamEventType === 'kilocode' &&
        'type' in event.data &&
        event.data.type === 'session.turn.close',
      SETTLE_TIMEOUT_MS
    );

    await sendMessage(config, {
      cloudAgentSessionId: root.cloudAgentSessionId,
      prompt: fakeDirective(
        `question:${questionTag}:${EMITTED_OPTIONS}:Continue the E2E scenario?`
      ),
    });

    const frame = await pollFor(
      () =>
        stream.events.find(event => isQuestionFrame(event) && optionCountOfFrame(event) !== null),
      'question frame on the wire'
    );
    const wireOptions = optionCountOfFrame(frame);
    const restored = await sdkQuestionVerdict(config, root);
    const verdict: Verdict = {
      bound: 'question-options',
      emittedOptions: EMITTED_OPTIONS,
      clientMaximum: CLIENT_MAXIMUM,
      wireOptions,
      sdkQuestions: restored === null ? null : (restored.questions?.length ?? null),
      sdkOptions: (restored?.questions ?? []).map(question => question.options.length),
    };
    console.log(`VERDICT ${JSON.stringify(verdict)}`);
    assert.notEqual(wireOptions, null, 'the wire carried no question payload');
  } finally {
    stream.close();
    await releaseOwnedSession(config, root);
  }
}

/**
 * Stop the sandbox this driver owns and delete the session, so repeated runs do
 * not accumulate containers or Durable Object state on the stack.
 */
async function releaseOwnedSession(config: DriverConfig, root: StartSessionResult): Promise<void> {
  try {
    const sandbox = await currentOwnedSandbox(root.cloudAgentSessionId, root.kiloSessionId);
    if (sandbox) {
      await stopOwnedSandboxFamily(sandbox, root.cloudAgentSessionId, root.kiloSessionId);
    }
  } catch (error) {
    console.warn(`interaction-bounds: sandbox cleanup failed: ${String(error)}`);
  }
  try {
    await deleteSession(config, root.cloudAgentSessionId);
  } catch (error) {
    console.warn(`interaction-bounds: session cleanup failed: ${String(error)}`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
