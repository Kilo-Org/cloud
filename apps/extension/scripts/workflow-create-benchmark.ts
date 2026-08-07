/* eslint-disable capitalized-comments, consistent-function-scoping, consistent-type-definitions, import/no-nodejs-modules, init-declarations, max-classes-per-file, max-lines, max-params, no-array-callback-reference, no-array-reverse, no-await-expression-member, no-await-in-loop, no-continue, no-negated-condition, no-unsafe-finally, numeric-separators-style, prefer-at, prefer-await-to-then, prefer-destructuring, prefer-top-level-await, promise/avoid-new, promise/prefer-await-to-callbacks, sort-keys, typescript-eslint/no-unsafe-type-assertion, unicorn/numeric-separators-style, unicorn/switch-case-braces, unicorn/prefer-string-replace-all, unicorn/no-array-sort, unicorn/no-useless-undefined */
/**
 * Workflow-create benchmark driver.
 *
 * Runs N identical safe-mode workflow-creation attempts against the fixed
 * Google Flights scenario with `kilo-auto/efficient` on the production
 * gateway, records redacted per-attempt JSON plus a summary, and returns
 * exit 0/1/2. See `workflow-create-benchmark.md` in this directory.
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
  correlateToolExchanges,
  computeBatchSummary,
  scoreWorkflowCorrectness,
  TARGET_PATH_PREFIX,
  TARGET_SCOPE_ORIGIN,
} from '../src/shared/agent-workflow-bench-scoring';
import type {
  BenchAttemptStats,
  BenchCorrectnessResult,
  BenchEvent,
  BenchToolCorrelation,
  BenchWorkflow,
} from '../src/shared/agent-workflow-bench-scoring';

// ── Pinned scenario (never change it between compared batches) ──────────────

const extensionPath = resolvePath(import.meta.dirname, '../.output/chrome-mv3');
const extensionDir = resolvePath(import.meta.dirname, '..');
const gatewayBase = 'https://app.kilo.ai';
const gatewayChatCompletionsPath = '/api/gateway/v1/chat/completions';
const targetUrl = `${TARGET_SCOPE_ORIGIN}${TARGET_PATH_PREFIX}`;
const modelId = 'kilo-auto/efficient';
const creditAccountLabel = 'Kilo';
const createMessage =
  'Create a workflow to get business class one way flights from Belgrade to a destination I pick, for a date I pick, one-way';
const followUpDestination = 'Paris';
const turnStabilitySeconds = 6;
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

type InternalMessage = {
  id: string;
  role?: string;
  text?: string;
  type: 'message';
};
type InternalThinking = { id: string; text?: string; type: 'thinking' };
type InternalToolCall = {
  arguments?: Record<string, unknown>;
  code?: string;
  id: string;
  name: string;
  type: 'tool-call';
};
type InternalToolResult = {
  error?: string;
  id: string;
  ok: boolean;
  toolCallId: string;
  type: 'tool-result';
  value?: unknown;
};
type InternalEvent = InternalMessage | InternalThinking | InternalToolCall | InternalToolResult;

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
  readonly headless: boolean | null;
  readonly startedAtIso: string;
  readonly gitHead: string;
  readonly modelId: string;
  readonly mode: 'safe';
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
  readonly correctness: BenchCorrectnessResult | null;
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
  --append           extend an existing batch in --out; refuses a different
                     gitHead, follow-up date, or org hash`;

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  let attempts = 3;
  let out: string | null = null;
  let noBuild = false;
  let timeoutMs = 900_000;
  let date: string | null = null;
  let append = false;

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

  return { attempts, out, noBuild, timeoutMs, date, append };
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

// ── Extension storage helpers (raw chrome.storage.local; WXT strips "local:") ─

const readLocal = (page: Page, key: string): Promise<unknown> =>
  page.evaluate(
    storageKey =>
      new Promise<unknown>((resolve, reject) => {
        const chromeApi = (
          globalThis as typeof globalThis & {
            chrome?: {
              runtime?: { lastError?: { message?: string } };
              storage?: {
                local?: {
                  get: (keys: string[], callback: (items: Record<string, unknown>) => void) => void;
                };
              };
            };
          }
        ).chrome;
        const runtime = chromeApi?.runtime;
        const storage = chromeApi?.storage?.local;
        if (runtime === undefined || storage === undefined) {
          reject(new Error('Extension runtime storage is unavailable.'));
          return;
        }
        storage.get([storageKey], items => {
          const message = runtime.lastError?.message;
          if (message !== undefined && message !== '') {
            reject(new Error(message));
            return;
          }
          resolve(items[storageKey]);
        });
      }),
    key
  );

const writeLocal = (page: Page, items: Record<string, unknown>): Promise<void> =>
  page.evaluate(
    storageItems =>
      new Promise<void>((resolve, reject) => {
        const chromeApi = (
          globalThis as typeof globalThis & {
            chrome?: {
              runtime?: { lastError?: { message?: string } };
              storage?: {
                local?: {
                  set: (items: Record<string, unknown>, callback: () => void) => void;
                };
              };
            };
          }
        ).chrome;
        const runtime = chromeApi?.runtime;
        const storage = chromeApi?.storage?.local;
        if (runtime === undefined || storage === undefined) {
          reject(new Error('Extension runtime storage is unavailable.'));
          return;
        }
        storage.set(storageItems, () => {
          const message = runtime.lastError?.message;
          if (message !== undefined && message !== '') {
            reject(new Error(message));
            return;
          }
          resolve();
        });
      }),
    items
  );

const readConversationStore = (sidePanel: Page): Promise<unknown> =>
  readLocal(sidePanel, 'kiloAgentConversations');

const snapshotTurn = async (sidePanel: Page): Promise<TurnSnapshot> => {
  const store = await readConversationStore(sidePanel);
  let events: readonly RawRecord[] = [];
  let updatedAt = '';
  if (isRecord(store)) {
    const activeConversationId = store['activeConversationId'];
    const conversations = store['conversations'];
    if (typeof activeConversationId === 'string' && Array.isArray(conversations)) {
      const conversation = conversations.find(
        (candidate): candidate is ConversationShape =>
          isRecord(candidate) &&
          candidate['id'] === activeConversationId &&
          Array.isArray(candidate['events']) &&
          (candidate['updatedAt'] === undefined || typeof candidate['updatedAt'] === 'string')
      );
      if (conversation !== undefined) {
        const rawEvents = conversation['events'];
        if (Array.isArray(rawEvents)) {
          events = rawEvents.filter(isRecord);
        }
        if (typeof conversation['updatedAt'] === 'string') {
          updatedAt = conversation['updatedAt'];
        }
      }
    }
  }
  const lastEvent = events[events.length - 1];
  const stopVisible = (await sidePanel.getByRole('button', { name: 'Stop' }).count()) > 0;
  const dialogOpen = (await sidePanel.locator('[role="dialog"]:visible').count()) > 0;
  return { eventCount: events.length, events, lastEvent, stopVisible, dialogOpen, updatedAt };
};

// ── Browser setup (probe pattern) ───────────────────────────────────────────

const launchContext = async (
  userDataDir: string
): Promise<{ context: BrowserContext; extensionId: string; headless: boolean }> => {
  const launchOptions: { args: string[] } = {
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  };
  let context: BrowserContext;
  let headless = false;
  try {
    context = await withTimeout(
      chromium.launchPersistentContext(userDataDir, { ...launchOptions, headless: false }),
      60_000,
      'browser launch timed out after 60s'
    );
  } catch {
    headless = true;
    context = await withTimeout(
      chromium.launchPersistentContext(userDataDir, { ...launchOptions, headless: true }),
      60_000,
      'browser launch timed out after 60s'
    );
  }
  const [existingServiceWorker] = context.serviceWorkers();
  const serviceWorker =
    existingServiceWorker ??
    (await withTimeout(
      context.waitForEvent('serviceworker', { timeout: 30_000 }),
      30_000,
      'service worker discovery timed out after 30s'
    ));
  const extensionId = new URL(serviceWorker.url()).host;
  return { context, extensionId, headless };
};

const ensureSignedInPanel = async (
  sidePanel: Page,
  token: string,
  userEmail: string | undefined,
  timeoutMs: number
): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      try {
        await writeLocal(sidePanel, { kiloAuth: { token, userEmail } });
        await sidePanel.reload();
      } catch (error) {
        lastError = error;
        break;
      }
    }
    try {
      await sidePanel.getByLabel('Settings').waitFor({ state: 'visible', timeout: timeoutMs });
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
  userEmail: string | undefined
): Promise<Page> => {
  const sidePanel = await context.newPage();
  await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await writeLocal(sidePanel, { kiloAuth: { token, userEmail } });
  await sidePanel.reload();
  await ensureSignedInPanel(sidePanel, token, userEmail, 60_000);
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
  await writeLocal(sidePanel, { kiloWorkflowSettings: settings });
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

const openFlightsTab = async (context: BrowserContext): Promise<Page> => {
  const flightsPage = await context.newPage();
  await flightsPage.goto(targetUrl, { timeout: 60_000, waitUntil: 'domcontentloaded' });
  await dismissConsent(flightsPage);
  await flightsPage.waitForTimeout(2000);
  if (!flightsPage.url().includes('/travel/flights')) {
    throw new Error(
      `Google consent or redirect did not settle on Google Flights: ${flightsPage.url()}`
    );
  }
  await flightsPage.bringToFront();
  return flightsPage;
};

const readTabOptions = async (select: ReturnType<Page['locator']>): Promise<string[]> => {
  const value = await select.evaluate(element => {
    if (!(element instanceof HTMLSelectElement)) {
      return [];
    }
    return [...element.options].map(option => option.value);
  });
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
};

const readTabLabels = async (select: ReturnType<Page['locator']>): Promise<string[]> => {
  const value = await select.evaluate(element => {
    if (!(element instanceof HTMLSelectElement)) {
      return [];
    }
    return [...element.options].map(option => option.textContent?.trim() ?? '');
  });
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
};

const selectTargetTab = async (sidePanel: Page): Promise<void> => {
  const targetTab = sidePanel.locator('select[aria-label="Target tab"]');
  await targetTab.waitFor({ state: 'visible', timeout: 30_000 });

  const findFlightsValue = async (): Promise<string | undefined> => {
    const labels = await readTabLabels(targetTab);
    const index = labels.findIndex(label => label !== '' && /flights/iu.test(label));
    if (index === -1) {
      return undefined;
    }
    const values = await readTabOptions(targetTab);
    return values[index];
  };

  await expect.poll(findFlightsValue, { timeout: 30_000 }).toBeDefined();

  const flightsValue = await findFlightsValue();
  if (flightsValue === undefined) {
    throw new Error('The Google Flights tab is not present in the target tab list.');
  }
  await targetTab.selectOption({ value: flightsValue });

  const selectedLabel = await targetTab.evaluate(element => {
    if (!(element instanceof HTMLSelectElement)) {
      return '';
    }
    return element.selectedOptions[0]?.textContent?.trim() ?? '';
  });
  if (!/flights/iu.test(selectedLabel)) {
    throw new Error(`Selected target tab is not Google Flights: "${selectedLabel}".`);
  }
};

const selectCreditAccount = async (sidePanel: Page): Promise<string> => {
  const settingsButton = sidePanel.getByLabel('Settings');
  await settingsButton.waitFor({ state: 'visible', timeout: 30_000 });
  await settingsButton.click();
  await sidePanel.getByLabel('Settings panel').waitFor({ state: 'visible', timeout: 30_000 });

  const creditAccount = sidePanel.getByLabel('Credit account');
  await creditAccount.waitFor({ state: 'visible', timeout: 30_000 });
  await expect
    .poll(async () => (await creditAccount.locator('option').count()) > 0, { timeout: 30_000 })
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
  await sidePanel.getByLabel('Settings panel').waitFor({ state: 'detached', timeout: 15_000 });
  return selectedLabel;
};

const selectModel = async (sidePanel: Page): Promise<void> => {
  const modelTrigger = sidePanel.getByLabel('Model');
  await expect(modelTrigger).toBeEnabled({ timeout: 30_000 });
  await modelTrigger.click();
  const dialog = sidePanel.locator('[role="dialog"][aria-label="Select model"]');
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });

  await dialog.getByLabel('Search models').fill(modelId);
  const option = dialog.locator(`button[data-model-id="${modelId}"]`);
  await option.waitFor({ state: 'visible', timeout: 30_000 });
  await option.click();
  await dialog.waitFor({ state: 'detached', timeout: 15_000 });

  await expect(modelTrigger).toHaveAttribute('data-model-id', modelId, { timeout: 15_000 });
};

const sendMessage = async (sidePanel: Page, text: string): Promise<number> => {
  const composer = sidePanel.getByLabel('Message agent');
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.fill(text);
  await composer.press('Enter');
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
  nowOffset: () => number
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
      gatewayBlockerReason ??= `non-production gateway URL observed: ${url}`;
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

const computeSavedAtOffsetMs = (
  collector: EventCollector,
  requests: readonly CapturedGatewayRequest[]
): number | null => {
  const saveSeenAtMs = collector.saveSeenAtMs;
  if (saveSeenAtMs === null) {
    return null;
  }
  // The persisted store can lag the in-memory stream, so the save boundary is
  // the min of the first-seen poll stamp and the first post-save request
  // offset: a new request can only start after the save result existed.
  let firstPostSaveOffsetMs: number | null = null;
  for (const request of requests) {
    if (
      request.offsetMs > saveSeenAtMs &&
      (firstPostSaveOffsetMs === null || request.offsetMs < firstPostSaveOffsetMs)
    ) {
      firstPostSaveOffsetMs = request.offsetMs;
    }
  }
  return Math.min(saveSeenAtMs, firstPostSaveOffsetMs ?? Number.POSITIVE_INFINITY);
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

    if (mode === 'create' && collector.hasSaveSuccess() && turnEnded) {
      break;
    }
    if (mode === 'verify' && turnEnded) {
      break;
    }
    if (aborted || Date.now() >= deadlineMs) {
      timedOut = true;
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

// ── Validation layer (zod-loose; unknown keys dropped) ──────────────────────

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

const toInternalEvent = (event: z.infer<typeof benchEventSchema>): InternalEvent => {
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
        id: event.id,
        name: event.name,
        type: 'tool-call',
        ...(event.arguments === undefined ? {} : { arguments: event.arguments }),
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

const validateEvents = (value: readonly RawRecord[]): InternalEvent[] => {
  const parsed = benchEventSchema.array().safeParse(value);
  if (!parsed.success) {
    throw new StorageParseError('conversation storage failed validation');
  }
  return parsed.data.map(toInternalEvent);
};

const toBenchEvent = (event: InternalEvent): BenchEvent => {
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

const workflowParamSchema = z
  .object({
    description: z.string().optional(),
    name: z.string(),
  })
  .strip();

const workflowSchema = z
  .object({
    approvedScriptHash: z.string().optional(),
    description: z.string(),
    id: z.string(),
    name: z.string(),
    params: z.array(workflowParamSchema).optional(),
    pathPrefix: z.string().optional(),
    scopeOrigin: z.string(),
    script: z.string(),
  })
  .strip();

const validateWorkflows = (value: unknown): BenchWorkflow[] => {
  const parsed = z.array(workflowSchema).safeParse(value);
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

const hasOkRealRun = (events: readonly BenchEvent[]): boolean =>
  correlateToolExchanges(events).exchanges.some(exchange => {
    const argumentsValue = exchange.call.arguments;
    return (
      exchange.call.name === 'run_workflow' &&
      argumentsValue['dryRun'] !== true &&
      isRecord(argumentsValue['input']) &&
      Object.keys(argumentsValue['input']).length > 0 &&
      exchange.result.ok
    );
  });

// ── Metrics and redaction ───────────────────────────────────────────────────

const joinNameById = (correlation: BenchToolCorrelation): ReadonlyMap<string, string> => {
  const map = new Map<string, string>();
  for (const exchange of correlation.exchanges) {
    map.set(exchange.result.id, exchange.call.name);
  }
  return map;
};

const computeMetrics = (
  events: readonly InternalEvent[],
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
  const toolCalls = events.filter((event): event is InternalToolCall => event.type === 'tool-call');
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
    out['scopeOrigin'] = scopeOrigin;
  }
  const pathPrefix = args['pathPrefix'];
  if (typeof pathPrefix === 'string') {
    out['pathPrefix'] = pathPrefix;
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

const redactToolResult = (
  event: InternalToolResult,
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
  const scalars: Record<string, unknown> = {};
  if (isRecord(event.value)) {
    for (const [key, value] of Object.entries(event.value)) {
      const capped = capScalar(value);
      if (capped === undefined) {
        continue;
      }
      scalars[key] = capped;
    }
  }
  return { ...base, ...(Object.keys(scalars).length === 0 ? {} : { scalars }) };
};

const redactTranscript = (
  events: readonly InternalEvent[],
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
  userDataDir: string
): Promise<void> => {
  if (context !== undefined) {
    try {
      await withTimeout(context.close(), 15_000, 'closing the browser context timed out');
    } catch {
      // Best-effort close; the profile-dir absence check is the real gate.
    }
  }
  await rm(userDataDir, { force: true, recursive: true });
  let gone = false;
  for (let retry = 0; retry < 2 && !gone; retry += 1) {
    try {
      await access(userDataDir);
    } catch {
      gone = true;
    }
    if (!gone && retry === 0) {
      await new Promise(resolve => {
        setTimeout(resolve, 2000);
      });
      await rm(userDataDir, { force: true, recursive: true });
    }
  }
  if (!gone) {
    throw new CleanupBlockerError(`profile directory survived cleanup: ${userDataDir}`);
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
  try {
    const internal = validateEvents(input.collector.events);
    const bench = internal.map(toBenchEvent);
    const correlation = correlateToolExchanges(bench);
    const metrics = computeMetrics(internal, input.collector.offsetByEventId, correlation);
    toolCallCount = metrics.toolCallCount;
    toolErrorCount = metrics.toolErrorCount;
    toolErrors = metrics.toolErrors;
    toolCallsByName = metrics.toolCallsByName;
    snapshotResultBytes = metrics.snapshotResultBytes;
    readCallsBeforeFirstSave = metrics.readCallsBeforeFirstSave;
    saveWorkflowCallCount = metrics.saveWorkflowCallCount;
    transcript = redactTranscript(internal, input.collector.offsetByEventId, correlation);
  } catch {
    // Partial or inconsistent store on a failed attempt; keep defaults.
  }
  return {
    attempt: input.attempt,
    headless: input.headless,
    startedAtIso: input.startedAtIso,
    gitHead: input.gitHead,
    modelId,
    mode: 'safe',
    settings: { ...benchSettings },
    followUpDate: input.followUpDate,
    creditAccountLabel: input.creditAccount === '' ? null : input.creditAccount,
    orgIdHash: null,
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
    autoRunObserved: false,
    followUpSent: false,
    correctness: null,
    success: false,
    failureReason: input.failureReason,
    transcript,
  };
};

// ── One attempt ─────────────────────────────────────────────────────────────

type AttemptRunResult =
  | { kind: 'record'; record: AttemptRecord }
  | { kind: 'blocker'; blocker: BlockerRecord };

const runAttempt = async (input: {
  attempt: number;
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
    gitHead,
    token,
    userEmail,
    followUpDate,
    timeoutMs,
    batchStartedAtMs,
    batchOrgIdHash,
  } = input;
  const attemptStartMs = Date.now();
  const startedAtIso = new Date(attemptStartMs).toISOString();
  const userDataDir = await mkdtemp(join(tmpdir(), 'kilo-workflow-create-bench-'));
  const collector = createEventCollector();
  const setupDone = { value: false };
  let context: BrowserContext | undefined;
  let headless: boolean | null = null;
  let extensionId = '';
  let creditAccount = '';
  let requests: readonly CapturedGatewayRequest[] = [];
  let savedAtOffsetMs: number | null = null;
  let createSentOffsetMs = 0;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const nowOffset = (): number => Date.now() - attemptStartMs;

  try {
    const launched = await launchContext(userDataDir);
    context = launched.context;
    headless = launched.headless;
    extensionId = launched.extensionId;

    const capture = startGatewayCapture(context, nowOffset);
    requests = capture.requests;

    const sidePanel = await openAuthenticatedSidePanel(context, extensionId, token, userEmail);
    checkGatewayBlocker();
    await seedWorkflowSettings(sidePanel, benchSettings);
    await openFlightsTab(context);
    checkGatewayBlocker();
    await selectTargetTab(sidePanel);
    checkGatewayBlocker();
    creditAccount = await selectCreditAccount(sidePanel);
    checkGatewayBlocker();
    await selectModel(sidePanel);
    checkGatewayBlocker();
    await sidePanel
      .getByRole('button', { name: /Safe mode/ })
      .waitFor({ state: 'visible', timeout: 30_000 });
    checkGatewayBlocker();

    // ── Agent phase (the only phase governed by --timeout-ms) ──
    setupDone.value = true;
    const preTurnCount = (await snapshotTurn(sidePanel)).eventCount;
    const abortController = new AbortController();
    const submitAtMs = await sendMessage(sidePanel, createMessage);
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

    savedAtOffsetMs = computeSavedAtOffsetMs(collector, requests);
    const createToSavedSeconds =
      savedAtOffsetMs === null ? null : Math.round((savedAtOffsetMs - createSentOffsetMs) / 1000);
    const createTurnEndedAtMs = createPhase.turnEnded ? createPhase.endedAtMs : null;
    const turnTotalSeconds =
      createTurnEndedAtMs === null
        ? null
        : Math.round((createTurnEndedAtMs - createSentOffsetMs) / 1000);

    const createInternalEvents = validateEvents(collector.events);
    const autoRunObserved = hasOkRealRun(createInternalEvents.map(toBenchEvent));

    let followUpSent = false;
    let finalSnapshot = createPhase.finalSnapshot;
    if (!autoRunObserved && Date.now() < deadlineMs) {
      const verifyStartCount = (await snapshotTurn(sidePanel)).eventCount;
      await sendMessage(sidePanel, `Run it for ${followUpDestination} on ${followUpDate}`);
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
      finalSnapshot = verifyPhase.finalSnapshot;
    }

    const finalInternalEvents = validateEvents(finalSnapshot.events);
    const finalBenchEvents = finalInternalEvents.map(toBenchEvent);
    const rawWorkflows = await readLocal(sidePanel, 'kiloAgentWorkflows');
    const workflows = validateWorkflows(rawWorkflows);

    classifyRequestPhases(requests, savedAtOffsetMs);

    if (requests.length === 0) {
      return {
        kind: 'record',
        record: buildFailedAttemptRecord({
          attempt,
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
        }),
      };
    }

    const distinctOrgIdHashes = new Set(requests.map(request => request.orgIdHash));
    const orgIdMismatched =
      distinctOrgIdHashes.size > 1 ||
      (batchOrgIdHash !== null && !distinctOrgIdHashes.has(batchOrgIdHash));
    if (orgIdMismatched) {
      if (attempt === 1) {
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
        record: buildFailedAttemptRecord({
          attempt,
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
        }),
      };
    }

    const correlation = correlateToolExchanges(finalBenchEvents);
    const metrics = computeMetrics(finalInternalEvents, collector.offsetByEventId, correlation);
    const correctness = scoreWorkflowCorrectness({
      workflows,
      events: finalBenchEvents,
      followUp: followUpSent ? { destination: followUpDestination, date: followUpDate } : undefined,
    });

    const record: AttemptRecord = {
      attempt,
      headless,
      startedAtIso,
      gitHead,
      modelId,
      mode: 'safe',
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
      transcript: redactTranscript(finalInternalEvents, collector.offsetByEventId, correlation),
    };
    return { kind: 'record', record };
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
    if (attempt === 1 && !setupDone.value) {
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
      record: buildFailedAttemptRecord({
        attempt,
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
      }),
    };
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
    try {
      await cleanupAttempt(context, userDataDir);
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

  const batchStartedAtMs = Date.now();
  let gitHead = 'unknown';
  try {
    gitHead = getGitHead();
  } catch {
    gitHead = 'unknown';
  }

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
    }

    const attemptFiles = (await listAttemptFiles(outDir)).sort((left, right) => left - right);
    const allRecords: AttemptRecord[] = [];
    for (const index of attemptFiles) {
      const record = JSON.parse(
        await readFile(join(outDir, `attempt-${index}.json`), 'utf8')
      ) as AttemptRecord;
      allRecords.push(record);
    }

    const summaryStats = computeBatchSummary(allRecords.map(attemptToStats));
    const mixedModes = new Set(allRecords.map(record => record.headless)).size > 1;
    const summary = {
      gitHead,
      startedAtIso: new Date(batchStartedAtMs).toISOString(),
      attempts: attemptFiles.length,
      followUpDate,
      scenario: {
        targetUrl,
        createMessage,
        modelId,
        mode: 'safe',
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
