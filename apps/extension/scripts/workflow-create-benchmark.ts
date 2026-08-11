/* eslint-disable capitalized-comments, consistent-function-scoping, import/max-dependencies, consistent-type-definitions, import/no-nodejs-modules, init-declarations, max-classes-per-file, max-lines, max-params, no-array-callback-reference, no-array-reverse, no-await-expression-member, no-await-in-loop, no-continue, no-negated-condition, no-unsafe-finally, numeric-separators-style, prefer-at, prefer-await-to-then, prefer-destructuring, prefer-top-level-await, promise/avoid-new, promise/prefer-await-to-callbacks, sort-keys, typescript-eslint/no-unsafe-type-assertion, unicorn/numeric-separators-style, unicorn/switch-case-braces, unicorn/prefer-string-replace-all, unicorn/no-array-sort, unicorn/no-useless-undefined */
/**
 * Workflow-create benchmark driver.
 *
 * Runs N identical safe-mode workflow-creation attempts against one of the
 * pinned golden-star scenarios (see `agent-workflow-bench-scenarios.ts`) with
 * `kilo-auto/efficient` on the production gateway, records redacted
 * per-attempt JSON plus a summary, and returns exit 0/1/2. See
 * `workflow-create-benchmark.md` in this directory.
 *
 * Security contract:
 * - The Kilo CLI token lives only inside the throwaway browser profile, which
 *   is removed and verified after each attempt. It is never printed or
 *   persisted in an artifact.
 * - Chat-completions traffic must have the exact `https://app.kilo.ai`
 *   origin (parsed, not prefix-matched); the first URL with any other
 *   origin aborts the batch as a blocker.
 * - Artifacts are allowlist-redacted: no user/assistant text, no tool
 *   arguments or results beyond pinned metadata and byte counts, no raw
 *   storage values.
 */
import { chromium, expect } from '@playwright/test';
import type { BrowserContext, Page, Request } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import {
  readExtensionLocalStorage,
  setExtensionStorage,
} from '../tests/e2e/extension-context-fixture';
import {
  correlateToolExchanges,
  computeBatchSummary,
  selectLastValidRealRun,
  scoreWorkflowCorrectness,
} from '../src/shared/agent-workflow-bench-scoring';
import { BENCH_SCENARIOS } from '../src/shared/agent-workflow-bench-scenarios';
import type { BenchScenario } from '../src/shared/agent-workflow-bench-scenarios';
import { TASK_BENCH_SCENARIOS } from '../src/shared/agent-task-bench-scenarios';
import type { BenchTaskScenario } from '../src/shared/agent-task-bench-scenarios';
import {
  computeTaskBatchSummary,
  scoreTaskCorrectness,
} from '../src/shared/agent-task-bench-scoring';
import type { BenchTaskCorrectnessResult } from '../src/shared/agent-task-bench-scoring';
import { agentWorkflowSchema } from '../src/shared/agent-workflows';
import type {
  BenchAttemptStats,
  BenchCorrectnessResult,
  BenchEvent,
  BenchToolCallEvent,
  BenchToolCorrelation,
  BenchToolResultEvent,
  BenchWorkflow,
} from '../src/shared/agent-workflow-bench-scoring';

// ── Pinned scenario (never change it between compared batches) ──────────────

const extensionPath = resolvePath(import.meta.dirname, '../.output/chrome-mv3');
const extensionDir = resolvePath(import.meta.dirname, '..');
const gatewayBase = 'https://app.kilo.ai';
const gatewayChatCompletionsPath = '/api/gateway/v1/chat/completions';
let modelId = 'kilo-auto/efficient';
const creditAccountLabel = 'Kilo';
const turnStabilitySeconds = 6;
// KILO_BENCH_RAW=1 additionally writes attempt-<n>-raw.json with the full
// unredacted transcript and stored workflows, for local debugging only.
// Raw artifacts must never be committed or attached to a PR.
const writeRawArtifacts = process.env['KILO_BENCH_RAW'] === '1';

type AnyBenchScenario = BenchScenario | BenchTaskScenario;

const isTaskScenario = (scenario: AnyBenchScenario): scenario is BenchTaskScenario =>
  'kind' in scenario && scenario.kind === 'task';

/** Task scenarios carry no scope; their origin is the start URL's origin. */
const scenarioOrigin = (scenario: AnyBenchScenario): string =>
  isTaskScenario(scenario) ? new URL(scenario.startUrl).origin : scenario.scopeOrigin;

const scenarioMode = (scenario: AnyBenchScenario): 'dangerous' | 'safe' =>
  isTaskScenario(scenario) ? scenario.mode : 'safe';

/** Resolve {key} placeholders in follow-up values and message. */
const resolveFollowUp = (
  scenario: BenchScenario,
  followUpDate: string
): { message: string; values: Record<string, string> } => {
  const values: Record<string, string> = {};
  for (const [key, raw] of Object.entries(scenario.followUpValues)) {
    values[key] = raw === '{date}' ? followUpDate : raw;
  }
  let message = scenario.followUpMessage;
  for (const [key, value] of Object.entries(values)) {
    message = message.replaceAll(`{${key}}`, value);
  }
  message = message.replaceAll('{date}', followUpDate);
  return { message, values };
};
const benchSettings = {
  allowWorkflowsInSafeMode: true,
  autoApproveWorkflowChanges: true,
  autoApproveWorkflowRuns: true,
} as const;

// ── Types ───────────────────────────────────────────────────────────────────

type RawRecord = Record<string, unknown>;

interface ConversationShape {
  readonly events: readonly RawRecord[];
  readonly id: string;
  readonly updatedAt?: string;
}

interface TurnSnapshot {
  readonly eventCount: number;
  readonly events: readonly RawRecord[];
  readonly lastEvent: RawRecord | undefined;
  readonly stopVisible: boolean;
  readonly dialogOpen: boolean;
  readonly updatedAt: string;
}

interface EventCollector {
  readonly events: RawRecord[];
  readonly offsetByEventId: Map<string, number>;
  readonly toolNameByCallId: Map<string, string>;
  saveSeenAtMs: number | null;
  ingest(rawEvents: readonly RawRecord[], nowOffsetMs: number): void;
  hasSaveSuccess(): boolean;
}

interface CapturedGatewayRequest {
  readonly index: number;
  readonly offsetMs: number;
  durationMs: number | null;
  readonly requestBytes: number;
  status: number | null;
  readonly orgIdHash: string;
  phase: 'create' | 'verify' | null;
}

interface ToolErrorRecord {
  readonly name: string;
  readonly errorClass: string;
  readonly offsetSeconds: number | null;
}

interface LlmRequestRecord {
  readonly index: number;
  readonly offsetMs: number;
  readonly durationMs: number | null;
  readonly requestBytes: number;
  readonly status: number | null;
  readonly orgIdHash: string;
  readonly phase: 'create' | 'verify';
}

interface RedactedEvent {
  readonly type: 'message' | 'thinking' | 'tool-call' | 'tool-result';
  readonly role?: string;
  readonly name?: string;
  readonly offsetSeconds?: number;
  readonly text?: string;
  readonly codeChars?: number;
  readonly arguments?: Record<string, unknown>;
  readonly ok?: boolean;
  readonly valueChars?: number;
  readonly pagesVisited?: number;
  readonly resultChars?: number;
  readonly scalars?: Record<string, unknown>;
}

interface AttemptRecord {
  readonly attempt: number;
  readonly scenarioId: string;
  readonly headless: boolean | null;
  readonly startedAtIso: string;
  readonly gitHead: string;
  readonly modelId: string;
  readonly mode: 'dangerous' | 'safe';
  readonly settings: {
    readonly allowWorkflowsInSafeMode: boolean;
    readonly autoApproveWorkflowChanges: boolean;
    readonly autoApproveWorkflowRuns: boolean;
  };
  readonly followUpDate: string;
  readonly creditAccountLabel: string | null;
  readonly orgIdHash: string | null;
  readonly createToSavedSeconds: number | null;
  readonly savedAtOffsetMs: number | null;
  readonly turnTotalSeconds: number | null;
  readonly wallClockSeconds: number;
  readonly llmRequestCount: number;
  readonly llmCreateRequestCount: number;
  readonly llmRequests: readonly LlmRequestRecord[];
  readonly toolCallCount: number;
  readonly toolErrorCount: number;
  readonly toolErrors: readonly ToolErrorRecord[];
  readonly toolCallsByName: Record<string, number>;
  readonly snapshotResultBytes: readonly number[];
  readonly readCallsBeforeFirstSave: number;
  readonly saveWorkflowCallCount: number;
  readonly autoRunObserved: boolean;
  readonly followUpSent: boolean;
  readonly correctness: BenchCorrectnessResult | BenchTaskCorrectnessResult | null;
  readonly success: boolean;
  readonly failureReason: string | null;
  readonly transcript: readonly RedactedEvent[];
}

type BlockerStage = 'build' | 'auth' | 'setup' | 'attempt' | 'cleanup';

interface BlockerRecord {
  readonly kind: 'blocker';
  readonly reason: string;
  readonly stage: BlockerStage;
  readonly attempt: number | null;
  readonly httpStatus: number | null;
  readonly gitHead: string;
  readonly startedAtIso: string;
  readonly wallClockSeconds: number;
}

interface ParsedArgs {
  readonly attempts: number;
  readonly out: string | null;
  readonly noBuild: boolean;
  readonly timeoutMs: number;
  readonly date: string | null;
  readonly append: boolean;
  readonly scenario: AnyBenchScenario;
  readonly model: string | null;
}

interface AgentPhaseResult {
  readonly turnEnded: boolean;
  readonly timedOut: boolean;
  readonly finalSnapshot: TurnSnapshot;
  readonly wallClockSeconds: number;
  readonly endedAtMs: number | null;
}

// ── Error classes ───────────────────────────────────────────────────────────

class UsageError extends Error {}

class StorageParseError extends Error {}

class BatchBlockerError extends Error {
  readonly stage: BlockerStage;
  readonly attempt: number | null;
  readonly httpStatus: number | null;

  constructor(
    stage: BlockerStage,
    reason: string,
    options: { attempt?: number | null; httpStatus?: number | null } = {}
  ) {
    super(reason);
    this.name = 'BatchBlockerError';
    this.stage = stage;
    this.attempt = options.attempt ?? null;
    this.httpStatus = options.httpStatus ?? null;
  }
}

class GatewayBlockerError extends BatchBlockerError {
  constructor(reason: string) {
    super('attempt', reason);
    this.name = 'GatewayBlockerError';
  }
}

class CleanupBlockerError extends BatchBlockerError {
  constructor(reason: string) {
    super('cleanup', reason);
    this.name = 'CleanupBlockerError';
  }
}

class CleanupCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CleanupCapError';
  }
}

// ── Small helpers ───────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is RawRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const capString = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}…`;

const errorToReason = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return capString(message.replaceAll(/\s+/g, ' ').trim(), 120);
};

const secondsOf = (offsetMs: number | null | undefined): number | null =>
  offsetMs === null || offsetMs === undefined ? null : Math.round(offsetMs / 1000);

const withTimeout = async <Value>(
  promise: Promise<Value>,
  timeoutMs: number,
  message: string
): Promise<Value> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('wait aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new Error('wait aborted'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });

const hashOrgId = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);

const formatDatePlusDays = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getGitHead = (): string => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname });
  if (result.status !== 0) {
    throw new Error('git rev-parse HEAD failed');
  }
  const output = result.stdout.toString('utf8').trim();
  if (output.length === 0) {
    throw new Error('git rev-parse HEAD returned empty output');
  }
  return output;
};

// ── CLI parsing ─────────────────────────────────────────────────────────────

const usage = `Usage:
  pnpm exec tsx apps/extension/scripts/workflow-create-benchmark.ts [options]

Options:
  --attempts <n>     number of attempts (default 3, min 1, max 10)
  --out <dir>        output directory (default: a fresh temp directory)
  --no-build         skip the extension self-build; you own build freshness
  --timeout-ms <ms>  per-attempt agent-phase deadline (default 900000)
  --date <YYYY-MM-DD> follow-up date (default: today + 45 days)
  --scenario <id>    workflow scenario id: ${Object.keys(BENCH_SCENARIOS).join(', ')} (default flights)
                     or task scenario id: ${Object.keys(TASK_BENCH_SCENARIOS).join(', ')}
  --model <id>       gateway model id (default kilo-auto/efficient)
  --append           extend an existing batch in --out; refuses a different
                     gitHead, scenario, model, follow-up date, or org hash`;

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  let attempts = 3;
  let out: string | null = null;
  let noBuild = false;
  let timeoutMs = 900_000;
  let date: string | null = null;
  let append = false;
  let scenario: AnyBenchScenario | undefined = BENCH_SCENARIOS['flights'];
  let model: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const takeValue = (flag: string): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`${flag} requires a value`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--attempts': {
        const value = takeValue('--attempts');
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1 || number > 10) {
          throw new UsageError('--attempts must be an integer between 1 and 10');
        }
        attempts = number;
        break;
      }
      case '--out':
        out = takeValue('--out');
        break;
      case '--timeout-ms': {
        const value = takeValue('--timeout-ms');
        const number = Number(value);
        if (!Number.isInteger(number) || number <= 0) {
          throw new UsageError('--timeout-ms must be a positive integer');
        }
        timeoutMs = number;
        break;
      }
      case '--date': {
        const value = takeValue('--date');
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
          throw new UsageError('--date must be formatted YYYY-MM-DD');
        }
        date = value;
        break;
      }
      case '--scenario': {
        const value = takeValue('--scenario');
        scenario = BENCH_SCENARIOS[value] ?? TASK_BENCH_SCENARIOS[value];
        if (scenario === undefined) {
          throw new UsageError(
            `--scenario must be one of: ${[...Object.keys(BENCH_SCENARIOS), ...Object.keys(TASK_BENCH_SCENARIOS)].join(', ')}`
          );
        }
        break;
      }
      case '--model': {
        const value = takeValue('--model');
        if (!/^[\w.:-]+\/[\w.:-]+$/u.test(value)) {
          throw new UsageError('--model must be a gateway model id like vendor/name');
        }
        model = value;
        break;
      }
      case '--no-build':
        noBuild = true;
        break;
      case '--append':
        append = true;
        break;
      default:
        throw new UsageError(`unknown flag: ${arg}`);
    }
  }

  if (scenario === undefined) {
    throw new UsageError('internal: no scenario resolved');
  }

  return { attempts, out, noBuild, timeoutMs, date, append, scenario, model };
};

const listAttemptFiles = async (outDir: string): Promise<number[]> => {
  let names: string[];
  try {
    names = await readdir(outDir);
  } catch {
    return [];
  }
  const indexes: number[] = [];
  for (const name of names) {
    const match = /^attempt-(\d+)\.json$/u.exec(name);
    if (match !== null) {
      const index = Number(match[1]);
      if (Number.isInteger(index)) {
        indexes.push(index);
      }
    }
  }
  return indexes;
};

// ── Build, token, blockers ──────────────────────────────────────────────────

const runBuild = async (): Promise<void> => {
  const env = { ...process.env };
  delete env['VITE_KILO_API_BASE_URL'];
  const child = spawn('pnpm', ['run', 'build'], { cwd: extensionDir, env, stdio: 'inherit' });
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        resolve(signal === null ? code : 1);
      });
    });
    if (exitCode !== 0) {
      throw new BatchBlockerError(
        'build',
        `extension self-build failed with exit code ${String(exitCode)}`
      );
    }
  } catch (error) {
    if (error instanceof BatchBlockerError) {
      throw error;
    }
    throw new BatchBlockerError(
      'build',
      `extension self-build could not start: ${errorToReason(error)}`
    );
  }
};

const loadToken = async (): Promise<{ token: string; userEmail: string | undefined }> => {
  const authPath = join(homedir(), '.local/share/kilo/auth.json');
  let raw: string;
  try {
    raw = await readFile(authPath, 'utf8');
  } catch {
    throw new BatchBlockerError('auth', `missing kilo CLI auth file at ${authPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new BatchBlockerError('auth', 'kilo CLI auth file is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new BatchBlockerError('auth', 'kilo CLI auth file has an invalid shape');
  }
  const kilo = parsed['kilo'];
  if (!isRecord(kilo)) {
    throw new BatchBlockerError('auth', 'kilo CLI auth file has no "kilo" section');
  }
  const candidate = kilo['access'] ?? kilo['.kilo.access'];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new BatchBlockerError('auth', 'no Kilo access token found in the kilo CLI auth file');
  }

  let response: Response;
  try {
    response = await fetch(`${gatewayBase}/api/user`, {
      headers: { Authorization: `Bearer ${candidate}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new BatchBlockerError(
      'auth',
      'token validation request to the production gateway failed'
    );
  }
  if (!response.ok) {
    throw new BatchBlockerError('auth', 'token validation rejected by the gateway', {
      httpStatus: response.status,
    });
  }

  let userEmail: string | undefined;
  try {
    const data = (await response.json()) as { google_user_email?: unknown };
    if (typeof data.google_user_email === 'string') {
      userEmail = data.google_user_email;
    }
  } catch {
    userEmail = undefined;
  }

  return { token: candidate, userEmail };
};

const makeBlockerRecord = (input: {
  stage: BlockerStage;
  reason: string;
  attempt: number | null;
  httpStatus: number | null;
  gitHead: string;
  batchStartedAtMs: number;
}): BlockerRecord => ({
  kind: 'blocker',
  reason: capString(input.reason, 120),
  stage: input.stage,
  attempt: input.attempt,
  httpStatus: input.httpStatus,
  gitHead: input.gitHead,
  startedAtIso: new Date(input.batchStartedAtMs).toISOString(),
  wallClockSeconds: Math.round((Date.now() - input.batchStartedAtMs) / 1000),
});

const writeBlockerArtifact = async (outDir: string, blocker: BlockerRecord): Promise<void> => {
  const blockerPath = join(outDir, 'blocker.json');
  try {
    await writeFile(blockerPath, `${JSON.stringify(blocker, null, 2)}\n`);
  } catch (error) {
    console.error(
      `blocker artifact could not be written to ${blockerPath}: ${errorToReason(error)}`
    );
  }
};

const readConversationStore = (sidePanel: Page): Promise<unknown> =>
  readExtensionLocalStorage(sidePanel, 'kiloAgentConversations');

// ── Conversation event contract (zod-loose; unknown keys dropped) ───────────

const benchEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      id: z.string(),
      role: z.enum(['assistant', 'user']).optional(),
      text: z.string().optional(),
      type: z.literal('message'),
    })
    .strip(),
  z
    .object({
      id: z.string(),
      text: z.string().optional(),
      type: z.literal('thinking'),
    })
    .strip(),
  z
    .object({
      arguments: z.record(z.string(), z.unknown()).optional(),
      code: z.string().optional(),
      id: z.string(),
      name: z.string(),
      type: z.literal('tool-call'),
    })
    .strip(),
  z
    .object({
      error: z.string().optional(),
      id: z.string(),
      ok: z.boolean(),
      toolCallId: z.string(),
      type: z.literal('tool-result'),
      value: z.unknown().optional(),
    })
    .strip(),
]);

const snapshotTurn = async (sidePanel: Page): Promise<TurnSnapshot> => {
  // A wedged panel must fail the attempt, not hang the poll loop forever.
  const store = await withTimeout(
    readConversationStore(sidePanel),
    20_000,
    'reading the conversation store timed out'
  );
  if (!isRecord(store)) {
    throw new StorageParseError('conversation storage is not an object');
  }
  const activeConversationId = store['activeConversationId'];
  const conversations = store['conversations'];
  if (typeof activeConversationId !== 'string' || !Array.isArray(conversations)) {
    throw new StorageParseError('conversation storage has an invalid envelope');
  }
  const conversation = conversations.find(
    (candidate): candidate is ConversationShape =>
      isRecord(candidate) &&
      candidate['id'] === activeConversationId &&
      Array.isArray(candidate['events']) &&
      (candidate['updatedAt'] === undefined || typeof candidate['updatedAt'] === 'string')
  );
  if (conversation === undefined) {
    throw new StorageParseError('the active conversation is missing from storage');
  }
  const rawEvents = conversation['events'];
  if (!rawEvents.every(isRecord)) {
    throw new StorageParseError('conversation storage contains a malformed event');
  }
  // Validate every event against the benchmark event contract at the
  // storage-read boundary, before any poll ingests it. A malformed record
  // becomes a storage-parse failure instead of poisoning the collector.
  for (const raw of rawEvents) {
    if (!benchEventSchema.safeParse(raw).success) {
      throw new StorageParseError('conversation storage contains an event that failed validation');
    }
  }
  const events = rawEvents;
  let updatedAt = '';
  if (typeof conversation['updatedAt'] === 'string') {
    updatedAt = conversation['updatedAt'];
  }
  const lastEvent = events[events.length - 1];
  const stopVisible = (await sidePanel.getByRole('button', { name: 'Stop' }).count()) > 0;
  const dialogOpen = (await sidePanel.locator('[role="dialog"]:visible').count()) > 0;
  return { eventCount: events.length, events, lastEvent, stopVisible, dialogOpen, updatedAt };
};

// ── Setup stage budget ──────────────────────────────────────────────────────
//
// The whole setup stage (panel, page, target-tab, credit-account, model, and
// safe-mode readiness) shares one enforced 30-second budget. Every internal
// Playwright wait derives its timeout from the remaining budget so the stage
// stops itself when the budget is exhausted; no sub-step starts after it.

interface SetupBudget {
  readonly budgetMs: number;
  readonly startedAtMs: number;
  remainingMs(): number;
  isExhausted(): boolean;
  waitTimeoutFor(nominalMs: number): number;
}

const makeSetupBudget = (budgetMs: number): SetupBudget => {
  const startedAtMs = Date.now();
  return {
    budgetMs,
    startedAtMs,
    remainingMs: () => Math.max(0, budgetMs - (Date.now() - startedAtMs)),
    isExhausted: () => Date.now() - startedAtMs >= budgetMs,
    waitTimeoutFor: (nominalMs: number) =>
      Math.max(1, Math.min(nominalMs, Math.max(0, budgetMs - (Date.now() - startedAtMs)))),
  };
};

// Runs one setup sub-step inside the shared stage budget. A sub-step never
// starts once the budget is exhausted, and its Playwright operations are
// bounded by the remaining budget, so the stage stops itself before cleanup
// starts. When the budget fires first, the started operation is still awaited
// to settlement before the stage returns, so no late Playwright work outlives
// the stage result.
const runSetupStep = async <Value>(
  budget: SetupBudget,
  label: string,
  op: () => Promise<Value>
): Promise<Value> => {
  if (budget.isExhausted()) {
    throw new Error(`${label} timed out: the 30-second setup stage budget was exhausted`);
  }
  const operation = op();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out: the 30-second setup stage budget was exhausted`));
        }, budget.remainingMs());
      }),
    ]);
  } catch (error) {
    try {
      await operation;
    } catch {
      // The operation's own rejection is secondary; the error above is the
      // outcome that made the race return.
    }
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

// ── Browser setup (probe pattern) ───────────────────────────────────────────

type LaunchContextResult =
  | {
      readonly kind: 'ready';
      readonly context: BrowserContext;
      readonly extensionId: string;
      readonly headless: boolean;
    }
  | {
      readonly error: unknown;
      readonly headless: boolean;
      readonly kind: 'pending-cleanup';
      readonly pendingCleanup: Promise<void>;
    }
  | {
      readonly context: BrowserContext;
      readonly cleanupFailure?: string;
      readonly error: unknown;
      readonly headless: boolean;
      readonly kind: 'failed';
    };

const launchContext = async (userDataDir: string): Promise<LaunchContextResult> => {
  const launchOptions: { args: string[] } = {
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  };
  const closeWhenReady = (launch: Promise<BrowserContext>): Promise<void> =>
    launch.then(context => context.close());
  const headedLaunch = chromium.launchPersistentContext(userDataDir, {
    ...launchOptions,
    headless: false,
  });
  let context: BrowserContext;
  let headless = false;
  try {
    context = await withTimeout(headedLaunch, 60_000, 'browser launch timed out after 60s');
  } catch (headedError) {
    let headedContext: BrowserContext | undefined;
    try {
      headedContext = await withTimeout(
        headedLaunch,
        30_000,
        'the headed browser launch did not settle within 30s'
      );
    } catch (settleError) {
      if (settleError instanceof Error && settleError.message.includes('did not settle')) {
        return {
          error: headedError,
          headless: false,
          kind: 'pending-cleanup',
          pendingCleanup: closeWhenReady(headedLaunch),
        };
      }
    }
    if (headedContext !== undefined) {
      const closePromise = headedContext.close();
      try {
        await withTimeout(closePromise, 30_000, 'headed browser close timed out');
      } catch (closeError) {
        if (closeError instanceof Error && closeError.message.includes('timed out')) {
          return {
            error: closeError,
            headless: false,
            kind: 'pending-cleanup',
            pendingCleanup: closePromise,
          };
        }
        return {
          cleanupFailure: errorToReason(closeError),
          context: headedContext,
          error: closeError,
          headless: false,
          kind: 'failed',
        };
      }
    }

    const headlessLaunch = chromium.launchPersistentContext(userDataDir, {
      ...launchOptions,
      headless: true,
    });
    try {
      headless = true;
      context = await withTimeout(headlessLaunch, 60_000, 'browser launch timed out after 60s');
    } catch (headlessError) {
      return {
        error: headlessError,
        headless: true,
        kind: 'pending-cleanup',
        pendingCleanup: closeWhenReady(headlessLaunch),
      };
    }
  }
  try {
    const [existingServiceWorker] = context.serviceWorkers();
    const serviceWorker =
      existingServiceWorker ??
      (await withTimeout(
        context.waitForEvent('serviceworker', { timeout: 30_000 }),
        30_000,
        'service worker discovery timed out after 30s'
      ));
    const extensionId = new URL(serviceWorker.url()).host;
    return { kind: 'ready', context, extensionId, headless };
  } catch (error) {
    // Return the live context to the attempt owner. Cleanup must close it
    // before removing the throwaway profile.
    return { context, error, headless, kind: 'failed' };
  }
};

const ensureSignedInPanel = async (
  sidePanel: Page,
  token: string,
  userEmail: string | undefined,
  budget: SetupBudget
): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (budget.isExhausted()) {
      break;
    }
    if (attempt > 0) {
      try {
        await setExtensionStorage(sidePanel, { kiloAuth: { token, userEmail } });
        await sidePanel.reload();
      } catch (error) {
        lastError = error;
        break;
      }
    }
    try {
      await sidePanel
        .getByLabel('Settings')
        .waitFor({ state: 'visible', timeout: budget.waitTimeoutFor(60_000) });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  const failure = lastError instanceof Error ? lastError : new Error(String(lastError));
  throw failure;
};

const openAuthenticatedSidePanel = async (
  context: BrowserContext,
  extensionId: string,
  token: string,
  userEmail: string | undefined,
  budget: SetupBudget
): Promise<Page> => {
  const sidePanel = await context.newPage();
  await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await setExtensionStorage(sidePanel, { kiloAuth: { token, userEmail } });
  await sidePanel.reload();
  await ensureSignedInPanel(sidePanel, token, userEmail, budget);
  return sidePanel;
};

const seedWorkflowSettings = async (
  sidePanel: Page,
  settings: {
    allowWorkflowsInSafeMode: boolean;
    autoApproveWorkflowChanges: boolean;
    autoApproveWorkflowRuns: boolean;
  }
): Promise<void> => {
  await setExtensionStorage(sidePanel, { kiloWorkflowSettings: settings });
};

const dismissConsent = async (page: Page): Promise<void> => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!page.url().includes('consent.google.com')) {
      return;
    }
    const acceptButton = page.getByRole('button', { name: /accept all|i agree|agree/iu }).first();
    if ((await acceptButton.count()) > 0) {
      await acceptButton.click();
      await page.waitForTimeout(2000);
    } else {
      return;
    }
  }
};

const openScenarioTab = async (
  context: BrowserContext,
  budget: SetupBudget,
  scenario: AnyBenchScenario
): Promise<Page> => {
  const scenarioPage = await context.newPage();
  await scenarioPage.goto(scenario.startUrl, {
    timeout: budget.waitTimeoutFor(60_000),
    waitUntil: 'domcontentloaded',
  });
  await dismissConsent(scenarioPage);
  await scenarioPage.waitForTimeout(2000);
  if (!scenarioPage.url().startsWith(scenarioOrigin(scenario))) {
    throw new Error(
      `Consent or a redirect did not settle on the scenario page: ${scenarioPage.url()}`
    );
  }
  await scenarioPage.bringToFront();
  return scenarioPage;
};

// Reads the target-tab option list as aligned label/value pairs in one
// evaluate, so the label and its value can never be read from two different
// tab-list snapshots. A non-select element returns null (still settling); any
// malformed option entry rejects the whole list instead of selecting blindly.
const readTargetTabOptions = async (
  select: ReturnType<Page['locator']>
): Promise<readonly { label: string; value: string }[] | null> => {
  const value = await select.evaluate((element): unknown =>
    element instanceof HTMLSelectElement
      ? [...element.options].map(option => ({
          label: option.textContent?.trim() ?? '',
          value: option.value,
        }))
      : null
  );
  if (value === null) {
    return null;
  }
  if (
    !Array.isArray(value) ||
    value.some(
      entry =>
        !isRecord(entry) || typeof entry['label'] !== 'string' || typeof entry['value'] !== 'string'
    )
  ) {
    throw new Error('The target tab option list contains malformed option data.');
  }
  return value as readonly { label: string; value: string }[];
};

// Queries the extension's own inspectable-tab list (the same protocol the side
// panel uses) so the selected tab can be verified by its real URL, not by its
// display label.
const readInspectableTabs = async (
  sidePanel: Page
): Promise<readonly { id: number; url: string }[]> => {
  const response = await sidePanel.evaluate(
    () =>
      new Promise<unknown>(resolve => {
        const chromeApi = (
          globalThis as typeof globalThis & {
            chrome?: {
              runtime?: {
                sendMessage?: (
                  message: { readonly type: string },
                  callback: (responseValue: unknown) => void
                ) => void;
              };
            };
          }
        ).chrome;
        const sendMessage = chromeApi?.runtime?.sendMessage;
        if (sendMessage === undefined) {
          resolve(null);
          return;
        }
        sendMessage({ type: 'kilo.tabs.listInspectable' }, responseValue => {
          resolve(responseValue);
        });
      })
  );
  if (!isRecord(response) || response['ok'] !== true) {
    throw new Error('The extension could not list inspectable tabs for target verification.');
  }
  const tabs = response['tabs'];
  if (!Array.isArray(tabs)) {
    throw new TypeError('The inspectable tab list response has an invalid shape.');
  }
  const tabEntries: { id: number; url: string }[] = [];
  for (const entry of tabs) {
    if (isRecord(entry) && typeof entry['id'] === 'number' && typeof entry['url'] === 'string') {
      tabEntries.push({ id: entry['id'], url: entry['url'] });
    }
  }
  return tabEntries;
};

const verifyTargetTabUrl = async (
  sidePanel: Page,
  selectedValue: string,
  scenario: AnyBenchScenario
): Promise<void> => {
  const tabId = Number(selectedValue);
  if (!Number.isInteger(tabId)) {
    throw new TypeError(`The selected target tab id is not an integer: "${selectedValue}".`);
  }
  const tabs = await readInspectableTabs(sidePanel);
  const target = tabs.find(tab => tab.id === tabId);
  if (target === undefined) {
    throw new Error(
      `The selected target tab (id ${String(tabId)}) is missing from the inspectable tab list.`
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(target.url);
  } catch {
    throw new Error(`The selected target tab has an invalid URL: "${target.url}".`);
  }
  if (parsed.origin !== scenarioOrigin(scenario)) {
    throw new Error(
      `Selected target tab is not the scenario page: ${target.url}; expected ${scenario.startUrl}.`
    );
  }
};

const selectTargetTab = async (
  sidePanel: Page,
  budget: SetupBudget,
  scenario: AnyBenchScenario
): Promise<void> => {
  const targetTab = sidePanel.locator('select[aria-label="Target tab"]');
  await targetTab.waitFor({ state: 'visible', timeout: budget.waitTimeoutFor(30_000) });

  const findScenarioOption = async (): Promise<{ label: string; value: string } | undefined> => {
    const options = await readTargetTabOptions(targetTab);
    if (options === null) {
      return undefined;
    }
    const option = options.find(
      candidate => candidate.label.trim() !== '' && scenario.tabLabelRe.test(candidate.label)
    );
    if (option === undefined) {
      return undefined;
    }
    if (option.value === '') {
      throw new Error('The scenario tab option has no selectable value.');
    }
    return option;
  };

  await expect.poll(findScenarioOption, { timeout: budget.waitTimeoutFor(30_000) }).toBeDefined();

  const scenarioOption = await findScenarioOption();
  if (scenarioOption === undefined) {
    throw new Error('The scenario tab is not present in the target tab list.');
  }
  await targetTab.selectOption({ value: scenarioOption.value });

  // Verify the selected option is the intended one by value identity, then
  // verify its tab URL against the scenario origin.
  const selected = await targetTab.evaluate((element): { label: string; value: string } | null => {
    if (!(element instanceof HTMLSelectElement)) {
      return null;
    }
    const option = element.selectedOptions[0];
    if (option === undefined) {
      return null;
    }
    return { label: option.textContent?.trim() ?? '', value: option.value };
  });
  if (selected === null || selected.value !== scenarioOption.value) {
    throw new Error('The selected target tab value does not match the intended scenario tab.');
  }
  if (!scenario.tabLabelRe.test(selected.label)) {
    throw new Error(`Selected target tab is not the scenario tab: "${selected.label}".`);
  }
  await verifyTargetTabUrl(sidePanel, selected.value, scenario);
};

/**
 * Every conversation starts in safe mode; the mode toggle button's accessible
 * name leads with the active mode. A dangerous scenario switches through the
 * footer dropdown and waits for the toggle to reflect it.
 */
const selectAgentMode = async (
  sidePanel: Page,
  budget: SetupBudget,
  mode: 'dangerous' | 'safe'
): Promise<void> => {
  const safeToggle = sidePanel.getByRole('button', { name: /Safe mode/ });
  await safeToggle.waitFor({ state: 'visible', timeout: budget.waitTimeoutFor(30_000) });
  if (mode === 'safe') {
    return;
  }
  await safeToggle.click();
  await sidePanel.getByRole('button', { name: /^Dangerous\b/ }).click();
  // The active-mode toggle label reads "Danger mode: Arbitrary webpage control".
  await sidePanel
    .getByRole('button', { name: /Danger mode/ })
    .waitFor({ state: 'visible', timeout: budget.waitTimeoutFor(30_000) });
};

const selectCreditAccount = async (sidePanel: Page, budget: SetupBudget): Promise<string> => {
  const settingsButton = sidePanel.getByLabel('Settings');
  await settingsButton.waitFor({ state: 'visible', timeout: budget.waitTimeoutFor(30_000) });
  await settingsButton.click();
  await sidePanel
    .getByLabel('Settings panel')
    .waitFor({ state: 'visible', timeout: budget.waitTimeoutFor(30_000) });

  const creditAccount = sidePanel.getByLabel('Credit account');
  await creditAccount.waitFor({ state: 'visible', timeout: budget.waitTimeoutFor(30_000) });
  await expect
    .poll(async () => (await creditAccount.locator('option').count()) > 0, {
      timeout: budget.waitTimeoutFor(30_000),
    })
    .toBe(true);

  await creditAccount.selectOption({ label: creditAccountLabel });
  const selectedLabel = await creditAccount.evaluate(element => {
    if (!(element instanceof HTMLSelectElement)) {
      return '';
    }
    return element.selectedOptions[0]?.textContent?.trim() ?? '';
  });
  if (selectedLabel !== creditAccountLabel) {
    throw new Error(`Credit account selection failed: selected "${selectedLabel}".`);
  }

  await sidePanel.getByLabel('Close settings').click();
  await sidePanel
    .getByLabel('Settings panel')
    .waitFor({ state: 'detached', timeout: budget.waitTimeoutFor(15_000) });
  return selectedLabel;
};

const selectModel = async (sidePanel: Page, budget: SetupBudget): Promise<void> => {
  const modelTrigger = sidePanel.getByLabel('Model');
  await expect(modelTrigger).toBeEnabled({ timeout: budget.waitTimeoutFor(30_000) });
  await modelTrigger.click();
  const dialog = sidePanel.locator('[role="dialog"][aria-label="Select model"]');
  await dialog.waitFor({ state: 'visible', timeout: budget.waitTimeoutFor(30_000) });

  await dialog.getByLabel('Search models').fill(modelId);
  const option = dialog.locator(`button[data-model-id="${modelId}"]`);
  await option.waitFor({ state: 'visible', timeout: budget.waitTimeoutFor(30_000) });
  await option.click();
  await dialog.waitFor({ state: 'detached', timeout: budget.waitTimeoutFor(15_000) });

  await expect(modelTrigger).toHaveAttribute('data-model-id', modelId, {
    timeout: budget.waitTimeoutFor(15_000),
  });
};

const sendMessage = async (sidePanel: Page, text: string): Promise<number> => {
  // A wedged panel must fail the attempt, not hang the batch past cleanup.
  await withTimeout(
    (async (): Promise<void> => {
      const composer = sidePanel.getByLabel('Message agent');
      await expect(composer).toBeEnabled({ timeout: 15_000 });
      await composer.fill(text);
      await composer.press('Enter');
    })(),
    30_000,
    'sending the message to the panel timed out'
  );
  return Date.now();
};

// ── Gateway traffic capture ─────────────────────────────────────────────────

let gatewayBlockerReason: string | null = null;

const checkGatewayBlocker = (): void => {
  if (gatewayBlockerReason !== null) {
    throw new GatewayBlockerError(gatewayBlockerReason);
  }
};

const startGatewayCapture = (
  context: BrowserContext,
  nowOffset: () => number,
  onBlocker: () => void
): { requests: CapturedGatewayRequest[]; detach: () => void } => {
  const requests: CapturedGatewayRequest[] = [];
  const byRequest = new Map<Request, CapturedGatewayRequest>();

  const onRequest = (request: Request): void => {
    const url = request.url();
    if (!url.includes(gatewayChatCompletionsPath)) {
      return;
    }
    let origin: string | null = null;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = null;
    }
    if (origin !== gatewayBase) {
      if (gatewayBlockerReason === null) {
        gatewayBlockerReason = `non-production gateway URL observed: ${url}`;
        onBlocker();
      }
      return;
    }
    let postData: string | null = null;
    try {
      postData = request.postData();
    } catch {
      postData = null;
    }
    const headers = request.headers();
    const organizationHeader = headers['x-kilocode-organizationid'];
    const entry: CapturedGatewayRequest = {
      index: requests.length,
      offsetMs: nowOffset(),
      durationMs: null,
      requestBytes: postData === null ? 0 : Buffer.byteLength(postData, 'utf8'),
      status: null,
      orgIdHash:
        organizationHeader === undefined || organizationHeader === ''
          ? 'absent'
          : hashOrgId(organizationHeader),
      phase: null,
    };
    requests.push(entry);
    byRequest.set(request, entry);
  };

  const onFinished = async (request: Request): Promise<void> => {
    const entry = byRequest.get(request);
    if (entry === undefined) {
      return;
    }
    entry.durationMs = Math.max(0, nowOffset() - entry.offsetMs);
    let status: number | null = null;
    try {
      const response = await request.response();
      status = response?.status() ?? null;
    } catch {
      status = null;
    }
    entry.status = status;
  };

  const onFailed = (request: Request): void => {
    const entry = byRequest.get(request);
    if (entry === undefined) {
      return;
    }
    entry.durationMs = Math.max(0, nowOffset() - entry.offsetMs);
  };

  context.on('request', onRequest);
  context.on('requestfinished', onFinished);
  context.on('requestfailed', onFailed);

  return {
    requests,
    detach: () => {
      context.off('request', onRequest);
      context.off('requestfinished', onFinished);
      context.off('requestfailed', onFailed);
    },
  };
};

const classifyRequestPhases = (
  requests: readonly CapturedGatewayRequest[],
  savedAtOffsetMs: number | null
): void => {
  for (const request of requests) {
    request.phase =
      savedAtOffsetMs === null || request.offsetMs <= savedAtOffsetMs ? 'create' : 'verify';
  }
};

// ── Conversation polling (abortable) ────────────────────────────────────────

const isSaveSuccess = (
  event: RawRecord,
  toolNameByCallId: ReadonlyMap<string, string>
): boolean => {
  if (event['type'] !== 'tool-result' || event['ok'] !== true) {
    return false;
  }
  const toolCallId = event['toolCallId'];
  if (typeof toolCallId !== 'string' || toolNameByCallId.get(toolCallId) !== 'save_workflow') {
    return false;
  }
  const value = event['value'];
  return isRecord(value) && value['saved'] === true;
};

const createEventCollector = (): EventCollector => {
  const events: RawRecord[] = [];
  const offsetByEventId = new Map<string, number>();
  const toolNameByCallId = new Map<string, string>();
  const seenIds = new Set<string>();

  const collector: EventCollector = {
    events,
    offsetByEventId,
    toolNameByCallId,
    saveSeenAtMs: null,
    ingest(rawEvents, nowOffsetMs) {
      for (const raw of rawEvents) {
        const id = raw['id'];
        if (typeof id !== 'string' || id === '' || seenIds.has(id)) {
          continue;
        }
        seenIds.add(id);
        offsetByEventId.set(id, nowOffsetMs);
        events.push(raw);
        if (raw['type'] === 'tool-call' && typeof raw['name'] === 'string') {
          toolNameByCallId.set(id, raw['name']);
        }
      }
      if (collector.saveSeenAtMs !== null) {
        return;
      }
      for (const event of events) {
        if (!isSaveSuccess(event, toolNameByCallId)) {
          continue;
        }
        collector.saveSeenAtMs = nowOffsetMs;
        return;
      }
    },
    hasSaveSuccess() {
      return collector.saveSeenAtMs !== null;
    },
  };
  return collector;
};

const isTerminalLastEvent = (event: RawRecord | undefined): boolean =>
  event !== undefined &&
  ((event['type'] === 'message' && event['role'] === 'assistant') ||
    event['type'] === 'tool-result');

const pollAgentPhase = async (options: {
  sidePanel: Page;
  collector: EventCollector;
  startEventCount: number;
  deadlineMs: number;
  signal: AbortSignal;
  mode: 'create' | 'verify';
  nowOffset: () => number;
}): Promise<AgentPhaseResult> => {
  const { sidePanel, collector, startEventCount, deadlineMs, signal, mode, nowOffset } = options;
  const startedAt = Date.now();
  let lastChangedAt = Date.now();
  let previous: TurnSnapshot | undefined;
  let turnEnded = false;
  let timedOut = false;
  let aborted = false;
  let endedAtMs: number | null = null;
  let finalSnapshot: TurnSnapshot | undefined;

  while (true) {
    checkGatewayBlocker();
    const snapshot = await snapshotTurn(sidePanel);
    finalSnapshot = snapshot;
    collector.ingest(snapshot.events, nowOffset());

    // The deadline is authoritative for this poll: it is checked after the
    // current poll is ingested and before terminal completion is accepted, so
    // a deadline-crossing poll can never be recorded as a completed turn.
    if (aborted || Date.now() >= deadlineMs) {
      timedOut = true;
      break;
    }

    if (snapshot.eventCount > startEventCount) {
      const changed =
        previous === undefined ||
        snapshot.eventCount !== previous.eventCount ||
        snapshot.updatedAt !== previous.updatedAt;
      if (changed) {
        lastChangedAt = Date.now();
      }
      if (
        snapshot.eventCount === startEventCount + 1 &&
        snapshot.lastEvent !== undefined &&
        snapshot.lastEvent['type'] === 'message' &&
        snapshot.lastEvent['role'] === 'user'
      ) {
        lastChangedAt = Date.now();
      }
      const stableFor = Date.now() - lastChangedAt >= turnStabilitySeconds * 1000 && !changed;
      if (
        stableFor &&
        !snapshot.stopVisible &&
        !snapshot.dialogOpen &&
        isTerminalLastEvent(snapshot.lastEvent)
      ) {
        turnEnded = true;
        endedAtMs = Date.now();
      }
    } else {
      lastChangedAt = Date.now();
    }

    // A finished create turn is terminal either way: with a save the verify
    // phase follows; without one no later poll can produce a save, so
    // waiting for the deadline only burns the batch's time.
    if (mode === 'create' && turnEnded) {
      break;
    }
    if (mode === 'verify' && turnEnded) {
      break;
    }

    previous = snapshot;
    try {
      await sleep(1000, signal);
    } catch {
      checkGatewayBlocker();
      aborted = true;
    }
  }

  return {
    turnEnded,
    timedOut,
    finalSnapshot: finalSnapshot ?? (await snapshotTurn(sidePanel)),
    wallClockSeconds: Math.round((Date.now() - startedAt) / 1000),
    endedAtMs,
  };
};

// ── Event conversion and validation helpers ─────────────────────────────────

const toBenchEventFromParsed = (event: z.infer<typeof benchEventSchema>): BenchEvent => {
  switch (event.type) {
    case 'message':
      return {
        id: event.id,
        type: 'message',
        ...(event.role === undefined ? {} : { role: event.role }),
        ...(event.text === undefined ? {} : { text: event.text }),
      };
    case 'thinking':
      return {
        id: event.id,
        type: 'thinking',
        ...(event.text === undefined ? {} : { text: event.text }),
      };
    case 'tool-call':
      return {
        arguments: event.arguments ?? {},
        id: event.id,
        name: event.name,
        type: 'tool-call',
        ...(event.code === undefined ? {} : { code: event.code }),
      };
    case 'tool-result':
      return {
        id: event.id,
        ok: event.ok,
        toolCallId: event.toolCallId,
        type: 'tool-result',
        ...(event.error === undefined ? {} : { error: event.error }),
        ...(event.value === undefined ? {} : { value: event.value }),
      };
  }
};

const validateEvents = (value: readonly RawRecord[]): BenchEvent[] => {
  const parsed = benchEventSchema.array().safeParse(value);
  if (!parsed.success) {
    throw new StorageParseError('conversation storage failed validation');
  }
  return parsed.data.map(toBenchEventFromParsed);
};

const validateWorkflows = (value: unknown): BenchWorkflow[] => {
  const parsed = z.array(agentWorkflowSchema).safeParse(value);
  if (!parsed.success) {
    throw new StorageParseError('workflow storage failed validation');
  }
  const workflows: BenchWorkflow[] = [];
  for (const entry of parsed.data) {
    workflows.push({
      approvedScriptHash: entry.approvedScriptHash,
      description: entry.description,
      id: entry.id,
      name: entry.name,
      scopeOrigin: entry.scopeOrigin,
      script: entry.script,
      ...(entry.params === undefined || entry.params.length === 0 ? {} : { params: entry.params }),
      ...(entry.pathPrefix === undefined ? {} : { pathPrefix: entry.pathPrefix }),
    });
  }
  return workflows;
};

// ── Metrics and redaction ───────────────────────────────────────────────────

const joinNameById = (correlation: BenchToolCorrelation): ReadonlyMap<string, string> => {
  const map = new Map<string, string>();
  for (const exchange of correlation.exchanges) {
    map.set(exchange.result.id, exchange.call.name);
  }
  return map;
};

const computeMetrics = (
  events: readonly BenchEvent[],
  offsetByEventId: ReadonlyMap<string, number>,
  correlation: BenchToolCorrelation
): {
  toolCallCount: number;
  toolErrorCount: number;
  toolErrors: readonly ToolErrorRecord[];
  toolCallsByName: Record<string, number>;
  snapshotResultBytes: readonly number[];
  readCallsBeforeFirstSave: number;
  saveWorkflowCallCount: number;
} => {
  const toolCalls = events.filter(
    (event): event is BenchToolCallEvent => event.type === 'tool-call'
  );
  const toolCallsByName: Record<string, number> = {};
  for (const call of toolCalls) {
    toolCallsByName[call.name] = (toolCallsByName[call.name] ?? 0) + 1;
  }
  const saveWorkflowCallCount = toolCalls.filter(call => call.name === 'save_workflow').length;

  const firstSaveCall = toolCalls.find(call => call.name === 'save_workflow');
  const firstSaveCallOffsetMs =
    firstSaveCall === undefined ? null : (offsetByEventId.get(firstSaveCall.id) ?? null);

  const readTools = new Set(['get_page_snapshot', 'find_in_page', 'get_element_details']);
  const readCallsBeforeFirstSave = toolCalls.filter(call => {
    if (!readTools.has(call.name)) {
      return false;
    }
    if (firstSaveCallOffsetMs === null) {
      return true;
    }
    const offsetMs = offsetByEventId.get(call.id);
    return offsetMs !== undefined && offsetMs < firstSaveCallOffsetMs;
  }).length;

  const toolErrors: ToolErrorRecord[] = [];
  const nameByResultId = joinNameById(correlation);
  for (const event of events) {
    if (event.type !== 'tool-result' || (event.ok && event.error === undefined)) {
      continue;
    }
    const name = nameByResultId.get(event.id) ?? 'unknown-tool';
    const errorText = typeof event.error === 'string' ? event.error : 'tool result ok: false';
    toolErrors.push({
      name,
      errorClass: capString(errorText.replaceAll(/\s+/g, ' ').trim(), 80),
      offsetSeconds: secondsOf(offsetByEventId.get(event.id)),
    });
  }

  const snapshotResultBytes: number[] = [];
  for (const event of events) {
    if (event.type !== 'tool-result' || !event.ok) {
      continue;
    }
    if (nameByResultId.get(event.id) !== 'get_page_snapshot') {
      continue;
    }
    snapshotResultBytes.push(Buffer.byteLength(JSON.stringify(event.value ?? null), 'utf8'));
  }

  return {
    toolCallCount: toolCalls.length,
    toolErrorCount: toolErrors.length,
    toolErrors,
    toolCallsByName,
    snapshotResultBytes,
    readCallsBeforeFirstSave,
    saveWorkflowCallCount,
  };
};

const pageContentTools = new Set([
  'get_page_snapshot',
  'find_in_page',
  'get_element_details',
  'get_viewport_screenshot',
  'eval',
  'web_search',
]);

const capScalar = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return capString(value, 120);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  return undefined;
};

const redactSaveWorkflowArguments = (args: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  const name = args['name'];
  if (typeof name === 'string') {
    out['name'] = capString(name, 120);
  }
  const description = args['description'];
  if (typeof description === 'string') {
    out['description'] = capString(description, 120);
  }
  const scopeOrigin = args['scopeOrigin'];
  if (typeof scopeOrigin === 'string') {
    out['scopeOrigin'] = capString(scopeOrigin, 120);
  }
  const pathPrefix = args['pathPrefix'];
  if (typeof pathPrefix === 'string') {
    out['pathPrefix'] = capString(pathPrefix, 120);
  }
  const params = args['params'];
  if (Array.isArray(params)) {
    const redactedParams: unknown[] = [];
    for (const param of params) {
      if (!isRecord(param)) {
        continue;
      }
      const paramName = param['name'];
      const paramDescription = param['description'];
      redactedParams.push({
        ...(typeof paramName === 'string' ? { name: capString(paramName, 120) } : {}),
        ...(typeof paramDescription === 'string'
          ? { description: capString(paramDescription, 120) }
          : {}),
      });
    }
    out['params'] = redactedParams;
  }
  const script = args['script'];
  if (typeof script === 'string') {
    out['scriptChars'] = script.length;
  }
  return out;
};

const redactOtherToolArguments = (args: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const capped = capScalar(value);
    if (capped === undefined) {
      continue;
    }
    out[key] = capped;
  }
  return out;
};

// Approved metadata keys for workflow and memory tool results. Only these
// keys may enter the artifact; every other field is dropped so raw workflow
// code, memory text, and arbitrary scalar content never persist.
const workflowMemoryResultMetadataKeys = new Set([
  'approvedScriptHash',
  'createdAt',
  'id',
  'inScope',
  'memoryId',
  'saved',
  'truncated',
  'workflowId',
]);

const redactToolResult = (
  event: BenchToolResultEvent,
  joinedName: string,
  offsetSeconds: number | null
): RedactedEvent => {
  const base: RedactedEvent = {
    type: 'tool-result',
    ...(joinedName === 'unknown-tool' ? {} : { name: joinedName }),
    ...(offsetSeconds === null ? {} : { offsetSeconds }),
    ok: event.ok,
  };
  const valueBytes = Buffer.byteLength(JSON.stringify(event.value ?? null), 'utf8');
  if (pageContentTools.has(joinedName)) {
    return { ...base, valueChars: valueBytes };
  }
  if (joinedName === 'run_workflow') {
    let pagesVisited: number | undefined;
    if (isRecord(event.value)) {
      const value = event.value['pagesVisited'];
      if (typeof value === 'number') {
        pagesVisited = value;
      }
    }
    return {
      ...base,
      resultChars: valueBytes,
      ...(pagesVisited === undefined ? {} : { pagesVisited }),
    };
  }
  // Workflow and memory tool results: allowlist metadata only. Raw content
  // fields (`script`, `text`) are replaced with their lengths; all other
  // fields are dropped, so no arbitrary scalar string or token-like field
  // enters the artifact.
  const scalars: Record<string, unknown> = {};
  if (isRecord(event.value)) {
    for (const [key, value] of Object.entries(event.value)) {
      if (!workflowMemoryResultMetadataKeys.has(key)) {
        continue;
      }
      const capped = capScalar(value);
      if (capped === undefined) {
        continue;
      }
      scalars[key] = capped;
    }
    const script = event.value['script'];
    if (typeof script === 'string') {
      scalars['scriptChars'] = script.length;
    }
    const text = event.value['text'];
    if (typeof text === 'string') {
      scalars['textChars'] = text.length;
    }
  }
  return { ...base, ...(Object.keys(scalars).length === 0 ? {} : { scalars }) };
};

const redactTranscript = (
  events: readonly BenchEvent[],
  offsetByEventId: ReadonlyMap<string, number>,
  correlation: BenchToolCorrelation
): RedactedEvent[] => {
  const nameByResultId = joinNameById(correlation);
  const redacted: RedactedEvent[] = [];
  for (const event of events) {
    const offsetSeconds = secondsOf(offsetByEventId.get(event.id));
    switch (event.type) {
      case 'message':
        redacted.push({
          type: 'message',
          ...(event.role === undefined ? {} : { role: event.role }),
          ...(offsetSeconds === null ? {} : { offsetSeconds }),
          text: `<text: ${(event.text ?? '').length} chars>`,
        });
        break;
      case 'thinking':
        redacted.push({
          type: 'thinking',
          ...(offsetSeconds === null ? {} : { offsetSeconds }),
          text: `<text: ${(event.text ?? '').length} chars>`,
        });
        break;
      case 'tool-call': {
        const base: RedactedEvent = {
          type: 'tool-call',
          name: event.name,
          ...(offsetSeconds === null ? {} : { offsetSeconds }),
        };
        if (event.name === 'save_workflow') {
          redacted.push({
            ...base,
            arguments: redactSaveWorkflowArguments(event.arguments ?? {}),
          });
        } else if (event.name === 'eval') {
          redacted.push({ ...base, codeChars: (event.code ?? '').length });
        } else {
          redacted.push({
            ...base,
            arguments: redactOtherToolArguments(event.arguments ?? {}),
          });
        }
        break;
      }
      case 'tool-result':
        redacted.push(
          redactToolResult(event, nameByResultId.get(event.id) ?? 'unknown-tool', offsetSeconds)
        );
        break;
    }
  }
  return redacted;
};

// ── Cleanup ─────────────────────────────────────────────────────────────────

const cleanupAttempt = async (
  context: BrowserContext | undefined,
  userDataDir: string,
  pendingCleanup: Promise<void> | undefined,
  initialContextCloseFailure: string | null
): Promise<void> => {
  // One bounded 15-second lifecycle: every step observes the same deadline, no
  // step starts after it. Crossing the cap emits a cleanup blocker and skips
  // profile removal, so an unresolved browser operation cannot reopen the
  // token profile after cleanup.
  const cleanupController = new AbortController();
  const cleanupCapMs = 15_000;
  const startedAtMs = Date.now();
  const remainingMs = (): number => Math.max(0, cleanupCapMs - (Date.now() - startedAtMs));
  const exceeded = (): boolean => Date.now() - startedAtMs >= cleanupCapMs;

  // Runs one cleanup step under the shared deadline. When the cap fires first,
  // attach a rejection handler and stop before profile removal.
  const runStep = async <Value>(label: string, op: Promise<Value>): Promise<Value> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        op,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new CleanupCapError(`${label} exceeded the 15-second cleanup cap`));
          }, remainingMs());
        }),
      ]);
    } catch (error) {
      if (!(error instanceof CleanupCapError)) {
        throw new CleanupBlockerError(errorToReason(error));
      }
      cleanupController.abort();
      void op.catch(() => undefined);
      throw new CleanupBlockerError(`${label} exceeded the 15-second cleanup cap`);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };

  // A failed context close can leave a live browser process holding the token
  // profile, so it is never silently accepted: the failure is recorded, the
  // profile removal and absence verification still run (cleanup guarantees are
  // not weakened), and the attempt then fails as a cleanup blocker.
  let contextCloseFailure: string | null = initialContextCloseFailure;
  try {
    if (context !== undefined) {
      try {
        await runStep('context close', context.close());
      } catch (error) {
        // Record the failure but continue: profile removal and absence
        // verification must still run so the token profile never survives.
        contextCloseFailure = error instanceof Error ? error.message : String(error);
      }
    } else if (pendingCleanup !== undefined) {
      // The browser launch or close did not settle during setup. Cleanup owns
      // the operation and skips profile removal when the shared cap expires.
      await runStep('browser launch settlement', pendingCleanup);
    }
    if (exceeded()) {
      throw new CleanupBlockerError('cleanup exceeded the 15-second cap');
    }
    await runStep('profile removal', rm(userDataDir, { force: true, recursive: true }));
    let gone = false;
    for (let retry = 0; retry < 2 && !gone; retry += 1) {
      if (exceeded()) {
        throw new CleanupBlockerError('cleanup exceeded the 15-second cap');
      }
      // Only a confirmed missing directory counts as gone; a permission or
      // I/O error rejects here and runStep raises it as a cleanup blocker.
      // The ENOENT mapping happens before runStep's wrapping so the code is
      // still readable on the raw error.
      const exists = await runStep(
        'profile absence check',
        access(userDataDir).then(
          () => true,
          (error: unknown) => {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            if (code !== 'ENOENT') {
              throw error;
            }
            return false;
          }
        )
      );
      if (exceeded()) {
        throw new CleanupBlockerError('cleanup exceeded the 15-second cap');
      }
      gone = !exists;
      if (!gone && retry === 0) {
        await runStep('cleanup wait', sleep(2000, cleanupController.signal));
        if (exceeded()) {
          throw new CleanupBlockerError('cleanup exceeded the 15-second cap');
        }
        await runStep('profile removal retry', rm(userDataDir, { force: true, recursive: true }));
      }
    }
    if (!gone) {
      throw new CleanupBlockerError(`profile directory survived cleanup: ${userDataDir}`);
    }
    // The profile is verifiably gone; a failed context close is still a blocker.
    if (contextCloseFailure !== null) {
      throw new CleanupBlockerError(`context close failed: ${contextCloseFailure}`);
    }
  } catch (error) {
    cleanupController.abort();
    if (error instanceof CleanupBlockerError) {
      throw error;
    }
    throw new CleanupBlockerError(errorToReason(error));
  }
};

// ── Attempt records ─────────────────────────────────────────────────────────

const toLlmRequestRecord = (request: CapturedGatewayRequest): LlmRequestRecord => ({
  index: request.index,
  offsetMs: request.offsetMs,
  durationMs: request.durationMs,
  requestBytes: request.requestBytes,
  status: request.status,
  orgIdHash: request.orgIdHash,
  phase: request.phase ?? 'create',
});

const attemptToStats = (record: AttemptRecord): BenchAttemptStats => ({
  createToSavedSeconds: record.createToSavedSeconds,
  llmCreateRequestCount: record.llmCreateRequestCount,
  llmRequestCount: record.llmRequestCount,
  readCallsBeforeFirstSave: record.readCallsBeforeFirstSave,
  success: record.success,
  toolCallCount: record.toolCallCount,
  toolErrorCount: record.toolErrorCount,
  turnTotalSeconds: record.turnTotalSeconds,
});

const buildFailedAttemptRecord = (input: {
  attempt: number;
  scenarioId: string;
  mode: 'dangerous' | 'safe';
  headless: boolean | null;
  startedAtIso: string;
  gitHead: string;
  followUpDate: string;
  creditAccount: string;
  requests: readonly CapturedGatewayRequest[];
  savedAtOffsetMs: number | null;
  createSentOffsetMs: number;
  attemptStartMs: number;
  failureReason: string;
  collector: EventCollector;
  followUpSent: boolean;
}): AttemptRecord => {
  classifyRequestPhases(input.requests, input.savedAtOffsetMs);
  let transcript: readonly RedactedEvent[] = [];
  let toolCallCount = 0;
  let toolErrorCount = 0;
  let toolErrors: readonly ToolErrorRecord[] = [];
  let toolCallsByName: Record<string, number> = {};
  let snapshotResultBytes: readonly number[] = [];
  let readCallsBeforeFirstSave = 0;
  let saveWorkflowCallCount = 0;
  let autoRunObserved = false;
  let failureReason = input.failureReason;
  try {
    const bench = validateEvents(input.collector.events);
    const correlation = correlateToolExchanges(bench);
    const metrics = computeMetrics(bench, input.collector.offsetByEventId, correlation);
    toolCallCount = metrics.toolCallCount;
    toolErrorCount = metrics.toolErrorCount;
    toolErrors = metrics.toolErrors;
    toolCallsByName = metrics.toolCallsByName;
    snapshotResultBytes = metrics.snapshotResultBytes;
    readCallsBeforeFirstSave = metrics.readCallsBeforeFirstSave;
    saveWorkflowCallCount = metrics.saveWorkflowCallCount;
    autoRunObserved = selectLastValidRealRun(correlation.exchanges) !== undefined;
    transcript = redactTranscript(bench, input.collector.offsetByEventId, correlation);
  } catch (error) {
    // A storage validation failure must surface as `storage-parse`, not as a
    // silent default artifact. The sanitized defaults above stay: no raw
    // storage content ever enters a failed attempt artifact.
    if (error instanceof StorageParseError) {
      failureReason = 'storage-parse';
    }
  }
  return {
    attempt: input.attempt,
    scenarioId: input.scenarioId,
    headless: input.headless,
    startedAtIso: input.startedAtIso,
    gitHead: input.gitHead,
    modelId,
    mode: input.mode,
    settings: { ...benchSettings },
    followUpDate: input.followUpDate,
    creditAccountLabel: input.creditAccount === '' ? null : input.creditAccount,
    orgIdHash: input.requests[0]?.orgIdHash ?? null,
    createToSavedSeconds:
      input.savedAtOffsetMs === null
        ? null
        : Math.round((input.savedAtOffsetMs - input.createSentOffsetMs) / 1000),
    savedAtOffsetMs: input.savedAtOffsetMs,
    turnTotalSeconds: null,
    wallClockSeconds: Math.round((Date.now() - input.attemptStartMs) / 1000),
    llmRequestCount: input.requests.length,
    llmCreateRequestCount: input.requests.filter(request => request.phase === 'create').length,
    llmRequests: input.requests.map(toLlmRequestRecord),
    toolCallCount,
    toolErrorCount,
    toolErrors,
    toolCallsByName,
    snapshotResultBytes,
    readCallsBeforeFirstSave,
    saveWorkflowCallCount,
    autoRunObserved,
    followUpSent: input.followUpSent,
    correctness: null,
    success: false,
    failureReason,
    transcript,
  };
};

// ── One attempt ─────────────────────────────────────────────────────────────

type AttemptRunResult =
  | { kind: 'record'; record: AttemptRecord; raw?: unknown }
  | { kind: 'blocker'; blocker: BlockerRecord };

const runAttempt = async (input: {
  attempt: number;
  /** True for the first attempt this invocation runs, including in --append mode. */
  isFirstAttemptOfBatch: boolean;
  scenario: AnyBenchScenario;
  gitHead: string;
  token: string;
  userEmail: string | undefined;
  followUpDate: string;
  timeoutMs: number;
  batchStartedAtMs: number;
  batchOrgIdHash: string | null;
}): Promise<AttemptRunResult> => {
  const {
    attempt,
    isFirstAttemptOfBatch,
    scenario,
    gitHead,
    token,
    userEmail,
    followUpDate,
    timeoutMs,
    batchStartedAtMs,
    batchOrgIdHash,
  } = input;
  const followUp = isTaskScenario(scenario) ? null : resolveFollowUp(scenario, followUpDate);
  const attemptStartMs = Date.now();
  const startedAtIso = new Date(attemptStartMs).toISOString();
  const userDataDir = await mkdtemp(join(tmpdir(), 'kilo-workflow-create-bench-'));
  const collector = createEventCollector();
  const setupDone = { value: false };
  let context: BrowserContext | undefined;
  let headless: boolean | null = null;
  let pendingCleanup: Promise<void> | undefined;
  let initialContextCloseFailure: string | null = null;
  let extensionId = '';
  let creditAccount = '';
  let requests: readonly CapturedGatewayRequest[] = [];
  let savedAtOffsetMs: number | null = null;
  let createSentOffsetMs = 0;
  let followUpSent = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const abortController = new AbortController();

  const nowOffset = (): number => Date.now() - attemptStartMs;

  try {
    const launched = await launchContext(userDataDir);
    if (launched.kind !== 'ready') {
      if (launched.kind === 'pending-cleanup') {
        pendingCleanup = launched.pendingCleanup;
        throw launched.error;
      }
      context = launched.context;
      headless = launched.headless;
      initialContextCloseFailure = launched.cleanupFailure ?? null;
      throw launched.error;
    }
    const attemptContext = launched.context;
    context = attemptContext;
    headless = launched.headless;
    extensionId = launched.extensionId;

    const capture = startGatewayCapture(attemptContext, nowOffset, () => {
      abortController.abort();
    });
    requests = capture.requests;

    // The whole setup stage shares one enforced 30-second budget. Each
    // sub-step runs inside it; internal Playwright waits derive from the
    // remaining budget, so the stage stops itself before cleanup starts.
    const setupBudget = makeSetupBudget(30_000);
    const sidePanel = await runSetupStep(setupBudget, 'side panel setup', () =>
      openAuthenticatedSidePanel(attemptContext, extensionId, token, userEmail, setupBudget)
    );
    checkGatewayBlocker();
    await runSetupStep(setupBudget, 'workflow settings setup', () =>
      seedWorkflowSettings(sidePanel, benchSettings)
    );
    checkGatewayBlocker();
    await runSetupStep(setupBudget, 'scenario tab setup', () =>
      openScenarioTab(attemptContext, setupBudget, scenario)
    );
    checkGatewayBlocker();
    await runSetupStep(setupBudget, 'target-tab setup', () =>
      selectTargetTab(sidePanel, setupBudget, scenario)
    );
    checkGatewayBlocker();
    creditAccount = await runSetupStep(setupBudget, 'credit-account setup', () =>
      selectCreditAccount(sidePanel, setupBudget)
    );
    checkGatewayBlocker();
    await runSetupStep(setupBudget, 'model setup', () => selectModel(sidePanel, setupBudget));
    checkGatewayBlocker();
    await runSetupStep(setupBudget, 'mode readiness', () =>
      selectAgentMode(sidePanel, setupBudget, scenarioMode(scenario))
    );
    checkGatewayBlocker();

    // ── Agent phase (the only phase governed by --timeout-ms) ──
    setupDone.value = true;
    const preTurnCount = (await snapshotTurn(sidePanel)).eventCount;
    const submitAtMs = await sendMessage(
      sidePanel,
      isTaskScenario(scenario) ? scenario.message : scenario.createMessage
    );
    createSentOffsetMs = submitAtMs - attemptStartMs;
    const deadlineMs = submitAtMs + timeoutMs;
    deadlineTimer = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    const createPhase = await pollAgentPhase({
      sidePanel,
      collector,
      startEventCount: preTurnCount,
      deadlineMs,
      signal: abortController.signal,
      mode: 'create',
      nowOffset,
    });
    checkGatewayBlocker();

    savedAtOffsetMs = collector.saveSeenAtMs;
    const createToSavedSeconds =
      savedAtOffsetMs === null ? null : Math.round((savedAtOffsetMs - createSentOffsetMs) / 1000);
    const createTurnEndedAtMs = createPhase.turnEnded ? createPhase.endedAtMs : null;
    const turnTotalSeconds =
      createTurnEndedAtMs === null ? null : Math.round((createTurnEndedAtMs - submitAtMs) / 1000);

    const createEvents = validateEvents(collector.events);
    const createCorrelation = correlateToolExchanges(createEvents);
    const autoRunObserved =
      !isTaskScenario(scenario) &&
      selectLastValidRealRun(createCorrelation.exchanges, {
        requireInput: Object.keys(scenario.followUpValues).length > 0,
      }) !== undefined;

    if (!isTaskScenario(scenario) && !createPhase.timedOut && !collector.hasSaveSuccess()) {
      return {
        kind: 'record',
        ...(writeRawArtifacts ? { raw: { events: collector.events } } : {}),
        record: buildFailedAttemptRecord({
          attempt,
          scenarioId: scenario.id,
          mode: scenarioMode(scenario),
          headless,
          startedAtIso,
          gitHead,
          followUpDate,
          creditAccount,
          requests,
          savedAtOffsetMs,
          createSentOffsetMs,
          attemptStartMs,
          failureReason: 'no-save',
          collector,
          followUpSent,
        }),
      };
    }

    let verifyTimedOut = false;
    let finalSnapshot = createPhase.finalSnapshot;
    // The follow-up run always uses the pinned values, even after an
    // auto-run: every attempt is verified against the same inputs.
    if (followUp !== null && !createPhase.timedOut && Date.now() < deadlineMs) {
      const verifyStartCount = (await snapshotTurn(sidePanel)).eventCount;
      await sendMessage(sidePanel, followUp.message);
      followUpSent = true;
      const verifyPhase = await pollAgentPhase({
        sidePanel,
        collector,
        startEventCount: verifyStartCount,
        deadlineMs,
        signal: abortController.signal,
        mode: 'verify',
        nowOffset,
      });
      verifyTimedOut = verifyPhase.timedOut;
      checkGatewayBlocker();
      finalSnapshot = verifyPhase.finalSnapshot;
    }
    checkGatewayBlocker();
    if (createPhase.timedOut || verifyTimedOut) {
      return {
        kind: 'record',
        ...(writeRawArtifacts ? { raw: { events: collector.events } } : {}),
        record: buildFailedAttemptRecord({
          attempt,
          scenarioId: scenario.id,
          mode: scenarioMode(scenario),
          headless,
          startedAtIso,
          gitHead,
          followUpDate,
          creditAccount,
          requests,
          savedAtOffsetMs,
          createSentOffsetMs,
          attemptStartMs,
          failureReason: 'deadline',
          collector,
          followUpSent,
        }),
      };
    }

    const finalBenchEvents = validateEvents(finalSnapshot.events);
    const workflows = isTaskScenario(scenario)
      ? []
      : validateWorkflows(await readExtensionLocalStorage(sidePanel, 'kiloAgentWorkflows'));

    classifyRequestPhases(requests, savedAtOffsetMs);
    checkGatewayBlocker();

    if (requests.length === 0) {
      return {
        kind: 'record',
        ...(writeRawArtifacts ? { raw: { events: collector.events } } : {}),
        record: buildFailedAttemptRecord({
          attempt,
          scenarioId: scenario.id,
          mode: scenarioMode(scenario),
          headless,
          startedAtIso,
          gitHead,
          followUpDate,
          creditAccount,
          requests,
          savedAtOffsetMs,
          createSentOffsetMs,
          attemptStartMs,
          failureReason: 'no-gateway-requests',
          collector,
          followUpSent,
        }),
      };
    }

    const distinctOrgIdHashes = new Set(requests.map(request => request.orgIdHash));
    const orgIdMismatched =
      distinctOrgIdHashes.size > 1 ||
      (batchOrgIdHash !== null && !distinctOrgIdHashes.has(batchOrgIdHash));
    if (orgIdMismatched) {
      if (isFirstAttemptOfBatch) {
        return {
          kind: 'blocker',
          blocker: makeBlockerRecord({
            stage: 'attempt',
            reason: 'orgIdHash mismatch across gateway requests',
            attempt,
            httpStatus: null,
            gitHead,
            batchStartedAtMs,
          }),
        };
      }
      return {
        kind: 'record',
        ...(writeRawArtifacts ? { raw: { events: collector.events } } : {}),
        record: buildFailedAttemptRecord({
          attempt,
          scenarioId: scenario.id,
          mode: scenarioMode(scenario),
          headless,
          startedAtIso,
          gitHead,
          followUpDate,
          creditAccount,
          requests,
          savedAtOffsetMs,
          createSentOffsetMs,
          attemptStartMs,
          failureReason: 'org-id-mismatch',
          collector,
          followUpSent,
        }),
      };
    }

    const correlation = correlateToolExchanges(finalBenchEvents);
    const metrics = computeMetrics(finalBenchEvents, collector.offsetByEventId, correlation);
    const correctness = isTaskScenario(scenario)
      ? scoreTaskCorrectness({ events: finalBenchEvents, scenario })
      : scoreWorkflowCorrectness({
          workflows,
          events: finalBenchEvents,
          scenario,
          followUpValues: followUpSent && followUp !== null ? followUp.values : undefined,
        });

    const record: AttemptRecord = {
      attempt,
      scenarioId: scenario.id,
      mode: scenarioMode(scenario),
      headless,
      startedAtIso,
      gitHead,
      modelId,
      settings: { ...benchSettings },
      followUpDate,
      creditAccountLabel: creditAccount === '' ? null : creditAccount,
      orgIdHash: requests[0]?.orgIdHash ?? null,
      createToSavedSeconds,
      savedAtOffsetMs,
      turnTotalSeconds,
      wallClockSeconds: Math.round((Date.now() - attemptStartMs) / 1000),
      llmRequestCount: requests.length,
      llmCreateRequestCount: requests.filter(request => request.phase === 'create').length,
      llmRequests: requests.map(toLlmRequestRecord),
      toolCallCount: metrics.toolCallCount,
      toolErrorCount: metrics.toolErrorCount,
      toolErrors: metrics.toolErrors,
      toolCallsByName: metrics.toolCallsByName,
      snapshotResultBytes: metrics.snapshotResultBytes,
      readCallsBeforeFirstSave: metrics.readCallsBeforeFirstSave,
      saveWorkflowCallCount: metrics.saveWorkflowCallCount,
      autoRunObserved,
      followUpSent,
      correctness,
      success: correctness.passed,
      failureReason: correctness.passed ? null : 'correctness-failed',
      transcript: redactTranscript(finalBenchEvents, collector.offsetByEventId, correlation),
    };
    return {
      kind: 'record',
      record,
      ...(writeRawArtifacts ? { raw: { events: finalBenchEvents, workflows } } : {}),
    };
  } catch (error) {
    if (error instanceof BatchBlockerError) {
      return {
        kind: 'blocker',
        blocker: makeBlockerRecord({
          stage: error.stage,
          reason: error.message,
          attempt,
          httpStatus: error.httpStatus,
          gitHead,
          batchStartedAtMs,
        }),
      };
    }
    const reason = error instanceof StorageParseError ? 'storage-parse' : errorToReason(error);
    if (isFirstAttemptOfBatch && !setupDone.value) {
      return {
        kind: 'blocker',
        blocker: makeBlockerRecord({
          stage: 'setup',
          reason,
          attempt,
          httpStatus: null,
          gitHead,
          batchStartedAtMs,
        }),
      };
    }
    return {
      kind: 'record',
      ...(writeRawArtifacts ? { raw: { events: collector.events } } : {}),
      record: buildFailedAttemptRecord({
        attempt,
        scenarioId: scenario.id,
        mode: scenarioMode(scenario),
        headless,
        startedAtIso,
        gitHead,
        followUpDate,
        creditAccount,
        requests,
        savedAtOffsetMs,
        createSentOffsetMs,
        attemptStartMs,
        failureReason: reason,
        collector,
        followUpSent,
      }),
    };
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
    try {
      await cleanupAttempt(context, userDataDir, pendingCleanup, initialContextCloseFailure);
    } catch (error) {
      if (error instanceof CleanupBlockerError) {
        throw error;
      }
      throw new CleanupBlockerError(errorToReason(error));
    }
  }
};

// ── Main ────────────────────────────────────────────────────────────────────

const main = async (): Promise<number> => {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage);
    return 2;
  }
  if (parsed.model !== null) {
    modelId = parsed.model;
  }

  const batchStartedAtMs = Date.now();

  let outDir: string;
  try {
    outDir = parsed.out ?? (await mkdtemp(join(tmpdir(), 'kilo-workflow-create-bench-')));
    await mkdir(outDir, { recursive: true });
  } catch (error) {
    throw new BatchBlockerError(
      'build',
      `could not create the output directory: ${errorToReason(error)}`
    );
  }

  let gitHead: string;
  try {
    gitHead = getGitHead();
  } catch (error) {
    // An unverifiable head would corrupt batch identity, so the batch stops
    // before measurement with a blocker artifact and exit code 2. The blocker
    // carries an empty head because the head could not be read at all.
    const blocker = makeBlockerRecord({
      stage: 'build',
      reason: `could not determine the git head: ${errorToReason(error)}`,
      attempt: null,
      httpStatus: null,
      gitHead: '',
      batchStartedAtMs,
    });
    await writeBlockerArtifact(outDir, blocker);
    return 2;
  }

  let batchOrgIdHash: string | null = null;

  try {
    let followUpDate = parsed.date;
    let firstAttempt = 1;
    if (parsed.append) {
      const summaryPath = join(outDir, 'summary.json');
      let existingSummary: RawRecord;
      try {
        const parsedSummary = JSON.parse(await readFile(summaryPath, 'utf8')) as unknown;
        if (!isRecord(parsedSummary)) {
          throw new Error('summary.json is not an object');
        }
        existingSummary = parsedSummary;
      } catch {
        throw new BatchBlockerError(
          'build',
          `--append requires an existing summary.json in ${outDir}`
        );
      }
      if (existingSummary['gitHead'] !== gitHead) {
        throw new BatchBlockerError(
          'build',
          '--append refused: the existing summary.gitHead differs from the current head'
        );
      }
      const existingScenario = existingSummary['scenario'];
      if (isRecord(existingScenario) && existingScenario['id'] !== parsed.scenario.id) {
        throw new BatchBlockerError(
          'build',
          '--append refused: the existing summary scenario differs from --scenario'
        );
      }
      if (isRecord(existingScenario) && existingScenario['modelId'] !== modelId) {
        throw new BatchBlockerError(
          'build',
          '--append refused: the existing summary modelId differs from --model'
        );
      }
      if (parsed.date === null) {
        const existingDate = existingSummary['followUpDate'];
        if (typeof existingDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(existingDate)) {
          throw new BatchBlockerError(
            'build',
            '--append refused: the existing summary has no valid followUpDate'
          );
        }
        followUpDate = existingDate;
      } else if (existingSummary['followUpDate'] !== parsed.date) {
        throw new BatchBlockerError(
          'build',
          `--append refused: --date ${parsed.date} differs from the existing summary followUpDate`
        );
      }
      const existingFiles = await listAttemptFiles(outDir);
      firstAttempt = existingFiles.length === 0 ? 1 : Math.max(...existingFiles) + 1;
      const existingOrgIdHashes = new Set<string>();
      for (const index of existingFiles) {
        let existing: { orgIdHash?: unknown };
        try {
          existing = JSON.parse(await readFile(join(outDir, `attempt-${index}.json`), 'utf8')) as {
            orgIdHash?: unknown;
          };
        } catch {
          throw new BatchBlockerError(
            'build',
            `--append refused: could not read attempt-${index}.json in ${outDir}`
          );
        }
        if (typeof existing.orgIdHash === 'string') {
          existingOrgIdHashes.add(existing.orgIdHash);
        }
      }
      if (existingOrgIdHashes.size > 1) {
        throw new BatchBlockerError(
          'build',
          '--append refused: existing attempt files carry differing orgIdHash values'
        );
      }
      if (existingOrgIdHashes.size === 1) {
        const existingHash = existingOrgIdHashes.values().next().value;
        if (existingHash !== undefined) {
          batchOrgIdHash = existingHash;
        }
      }
    } else {
      if (parsed.date === null) {
        followUpDate = formatDatePlusDays(45);
      }
      const existingFiles = await listAttemptFiles(outDir);
      if (existingFiles.length > 0) {
        throw new BatchBlockerError(
          'build',
          `refusing to overwrite attempt files in ${outDir}; use --append`
        );
      }
    }
    if (followUpDate === null) {
      throw new BatchBlockerError('build', 'internal: no follow-up date resolved');
    }

    if (!parsed.noBuild) {
      await runBuild();
    }
    try {
      await access(join(extensionPath, 'manifest.json'));
    } catch {
      throw new BatchBlockerError(
        'build',
        'extension build output is missing; run without --no-build or build apps/extension first'
      );
    }

    const { token, userEmail } = await loadToken();

    gatewayBlockerReason = null;

    for (let offset = 0; offset < parsed.attempts; offset += 1) {
      const attemptNumber = firstAttempt + offset;
      const result = await runAttempt({
        attempt: attemptNumber,
        isFirstAttemptOfBatch: offset === 0,
        scenario: parsed.scenario,
        gitHead,
        token,
        userEmail,
        followUpDate,
        timeoutMs: parsed.timeoutMs,
        batchStartedAtMs,
        batchOrgIdHash,
      });
      if (result.kind === 'blocker') {
        await writeBlockerArtifact(outDir, result.blocker);
        return 2;
      }
      batchOrgIdHash ??= result.record.orgIdHash;
      await writeFile(
        join(outDir, `attempt-${attemptNumber}.json`),
        `${JSON.stringify(result.record, null, 2)}\n`
      );
      if (result.raw !== undefined) {
        await writeFile(
          join(outDir, `attempt-${attemptNumber}-raw.json`),
          `${JSON.stringify(result.raw, null, 2)}\n`
        );
      }
    }

    const attemptFiles = (await listAttemptFiles(outDir)).sort((left, right) => left - right);
    const allRecords: AttemptRecord[] = [];
    for (const index of attemptFiles) {
      const record = JSON.parse(
        await readFile(join(outDir, `attempt-${index}.json`), 'utf8')
      ) as AttemptRecord;
      allRecords.push(record);
    }

    const summaryStats = isTaskScenario(parsed.scenario)
      ? computeTaskBatchSummary(allRecords.map(attemptToStats))
      : computeBatchSummary(allRecords.map(attemptToStats));
    const mixedModes = new Set(allRecords.map(record => record.headless)).size > 1;
    const summary = {
      gitHead,
      startedAtIso: new Date(batchStartedAtMs).toISOString(),
      attempts: attemptFiles.length,
      followUpDate,
      scenario: {
        id: parsed.scenario.id,
        targetUrl: parsed.scenario.startUrl,
        createMessage: isTaskScenario(parsed.scenario)
          ? parsed.scenario.message
          : parsed.scenario.createMessage,
        modelId,
        mode: scenarioMode(parsed.scenario),
        settings: { ...benchSettings },
      },
      attemptsJson: attemptFiles.map(index => `attempt-${index}.json`),
      successCount: summaryStats.successCount,
      speedGatePassed: summaryStats.speedGatePassed,
      mixedModes,
      medians: summaryStats.medians,
      maxCreateToSavedSeconds: summaryStats.maxCreateToSavedSeconds,
    };
    await writeFile(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

    console.log(`Batch complete. out=${outDir}`);
    console.log(
      `attempts=${String(attemptFiles.length)} success=${String(summaryStats.successCount)} speedGate=${summaryStats.speedGatePassed ? 'passed' : 'failed'} mixedModes=${mixedModes ? 'true' : 'false'}`
    );
    const metricOrder = [
      'createToSavedSeconds',
      'turnTotalSeconds',
      'toolCallCount',
      'toolErrorCount',
      'llmRequestCount',
      'llmCreateRequestCount',
      'readCallsBeforeFirstSave',
    ] as const;
    for (const metric of metricOrder) {
      const value = summaryStats.medians[metric];
      console.log(`  ${metric}: ${value === null ? 'n/a' : String(value)}`);
    }

    return summaryStats.successCount === attemptFiles.length ? 0 : 1;
  } catch (error) {
    if (error instanceof BatchBlockerError) {
      const blocker = makeBlockerRecord({
        stage: error.stage,
        reason: error.message,
        attempt: error.attempt,
        httpStatus: error.httpStatus,
        gitHead,
        batchStartedAtMs,
      });
      await writeBlockerArtifact(outDir, blocker);
      return 2;
    }
    throw error;
  }
};

main()
  .then(code => {
    process.exitCode = code;
    return code;
  })
  .catch(error => {
    console.error(
      `benchmark driver crashed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 2;
  });
