import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { Type } from '@sinclair/typebox';
import type { OpenClawConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

// Reused inside the narrow function-parameter shapes below so the local
// type stays a strict subset of the real plugin API. Without this the
// hand-written `listProviders: (params?: { config?: unknown }) => ...`
// signature is actually broader than the SDK's typed `ListWebSearchProvidersParams`,
// and passing the real api into a narrow-typed function fails.
type SdkWebSearchRuntime = OpenClawPluginApi['runtime']['webSearch'];
import {
  buildBriefingMarkdown,
  type BriefingDocumentSection,
  offsetDateKey,
  resolveBriefingPath,
  wrapBriefingMarkdownForAgent,
} from './briefing-utils';
import {
  type BriefingDeliveryResult,
  deliverBriefingToConfiguredChannels,
  formatDeliverySummary,
  logDeliveryOutcomeEvents,
  parseStoredDelivery,
} from './delivery-utils';
import { DELIVERY_CHANNELS } from './delivery-constants';
import { CommandExecutionError, runCommand } from './command-utils';
import {
  filterEnabledBriefingJobs,
  pickCanonicalCronJobId,
  selectMorningBriefingJobs,
} from './cron-utils';
import { extractBriefingArgsFromText } from './command-fallback-utils';
import { type EnableInput, isValidTimezone, parseEnableArgs } from './enable-input-utils';
import {
  buildGithubEmptySectionLines,
  buildGithubEmptySummary,
  classifyGithubToken,
  formatGithubTldr,
  type GithubEmptyResultContext,
  GITHUB_EMPTY_LINE,
  isCleanGithubEmptyResult,
  missingBriefingScopes,
  parseOAuthScopesHeader,
  readGithubTokenFromEnv,
} from './github-utils';
import {
  formatLinearIssueLine,
  formatLinearTldr,
  hasHighSignalPriority,
  LINEAR_EMPTY_LINE,
  normalizeLinearIssues,
  summarizeLinearCallFailure,
} from './linear-utils';
import {
  buildLocalNewsEmptyLine,
  buildLocalNewsSectionTitle,
  buildLocalNewsTiers,
  dedupeByUrl,
  formatLocalNewsLine,
  formatLocalNewsTldr,
  LOCAL_NEWS_INTEREST_LABEL,
  LOCAL_NEWS_MAX_ITEMS,
  LOCAL_NEWS_MIN_ITEMS,
  LOCAL_NEWS_NO_LOCATION_SUMMARY,
  type LocalNewsItem,
  type LocationContext,
  resolveLocationContextWithOverride,
} from './local-news-utils';
import { resolveNextReconcileAction } from './reconcile-queue-utils';
import { formatWebTldr, normalizeWebResults, WEB_EMPTY_LINE } from './web-utils';
import {
  buildCalendarSectionLines,
  buildCalendarSectionTitle,
  buildCalendarTimeWindow,
  formatCalendarTldr,
} from './calendar-utils';
import {
  fetchCalendarAccessToken,
  fetchCalendarEvents,
  resolveCalendarReady,
} from './calendar-client';
import { createKiloChatSummaryClient } from './chat-summary-client';
import {
  buildChatSummarySectionLines,
  buildChatSummaryStatus,
  buildTodaySoFarChatWindow,
  buildYesterdayChatWindow,
  CHAT_EMPTY_TODAY,
  CHAT_EMPTY_YESTERDAY,
  formatChatTldr,
  summarizeChatActivity,
} from './chat-summary-utils';

const PLUGIN_ID = 'kiloclaw-morning-briefing';
const CRON_JOB_NAME = 'KiloClaw Morning Briefing';
const CRON_PROMPT =
  'Call the tool morning_briefing_generate exactly once with no arguments. Do not call any other tool.';
const DEFAULT_CRON = '0 7 * * *';
const DEFAULT_TIMEZONE = 'UTC';
// Caps for the interests HTTP handler. Authoritative validation lives
// on the worker (`MorningBriefingInterestsSchema` in
// `services/kiloclaw/src/routes/platform.ts`); these are defense-in-
// depth so a direct authenticated gateway call (test tooling, future
// internal bypass, worker bug) can't write a runaway payload into
// `config.json` and blow up the next briefing's web-search query.
// Keep in sync with the worker schema's `MAX_INTEREST_TOPICS` /
// `MAX_INTEREST_TOPIC_LENGTH` — service boundary means we can't share
// the constants.
const MAX_INTEREST_TOPICS = 20;
const MAX_INTEREST_TOPIC_LENGTH = 64;
const statusWriteQueueByPath = new Map<string, Promise<unknown>>();
// Per-instance serialisation for `config.json` read-modify-write sequences.
// reconcileDesiredState holds a stale `StoredConfig` across the long
// `ensureCronJob` call; without this queue an interests/enable/disable
// write that lands in that window would be silently clobbered when
// reconcile resumes and re-writes its stale-base. Same pattern as
// `statusWriteQueueByPath` above.
const configWriteQueueByPath = new Map<string, Promise<unknown>>();

type BriefingPluginConfig = {
  defaultCron?: string;
  defaultTimezone?: string;
};

type StoredConfig = {
  enabled: boolean;
  cronJobId: string | null;
  cron: string;
  timezone: string;
  // User-selected interest topics that scope the morning briefing's
  // web-search query. Empty array means "no topics selected" — the
  // search query path falls back to its default in that case. Written
  // by the gateway `interests` route; read on every reconcile and on
  // every briefing run.
  interestTopics: string[];
  // User-provided location override for the Local News source. When
  // non-null, takes priority over the `KILOCLAW_USER_LOCATION` env var
  // so saves from Settings → Morning Briefing → Location take effect
  // without a container restart. Null means "use env var or fall
  // through to no-location nudge." Written by the gateway
  // `user-location` route.
  userLocation: string | null;
  updatedAt: string;
};

type StoredStatus = {
  lastGeneratedDate: string | null;
  lastGeneratedAt: string | null;
  lastPath: string | null;
  sourceSummary: Array<{ source: string; configured: boolean; ok: boolean; summary: string }>;
  failures: string[];
  lastDelivery: BriefingDeliveryResult[];
  observedEnabled: boolean | null;
  reconcileState: 'idle' | 'in_progress' | 'succeeded' | 'failed';
  lastReconcileAt: string | null;
  lastReconcileError: string | null;
  lastReconcileDurationMs: number | null;
  lastReconcileAction: 'enable' | 'disable' | null;
};

type SourceCollectionResult = {
  source: 'calendar' | 'github' | 'kilo-chat' | 'linear' | 'local-news' | 'web';
  configured: boolean;
  ok: boolean;
  summary: string;
  sectionLines: string[];
  sections?: BriefingDocumentSection[];
  /**
   * Optional per-source section title override. Most sources use a
   * fixed title (`GitHub`, `Linear`, `Web Search`), but `local-news`
   * adds the resolved user location in parens when one is set, and
   * `calendar` uses the connected Google account's email (e.g.
   * `astorms@kilocode.ai daily calendar`). Set by the collector;
   * unset for sources with a static title.
   */
  sectionTitle?: string;
  /**
   * Optional short fragment for the briefing's `**TL;DR:**` header line
   * (e.g. `3 GitHub issues to review`). Set by `populated` collectors;
   * unset/empty when the source has nothing worth counting. The
   * assembler joins all non-empty fragments with ` · `.
   */
  tldr?: string;
};

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resolvePluginConfig(raw: unknown): BriefingPluginConfig {
  const obj = asObject(raw);
  return {
    defaultCron: typeof obj.defaultCron === 'string' ? obj.defaultCron : undefined,
    defaultTimezone: typeof obj.defaultTimezone === 'string' ? obj.defaultTimezone : undefined,
  };
}

async function readRequestBody(
  req: IncomingMessage & AsyncIterable<Buffer | string>
): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const rawChunk of req) {
    const chunk: unknown = rawChunk;
    if (typeof chunk === 'string') {
      chunks.push(new TextEncoder().encode(chunk));
    } else if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    }
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function getStatePaths(api: { runtime: { state: { resolveStateDir: () => string } } }): {
  rootDir: string;
  briefingsDir: string;
  configPath: string;
  statusPath: string;
} {
  const stateDir = api.runtime.state.resolveStateDir();
  const rootDir = path.join(stateDir, 'morning-briefing');
  return {
    rootDir,
    briefingsDir: path.join(rootDir, 'briefings'),
    configPath: path.join(rootDir, 'config.json'),
    statusPath: path.join(rootDir, 'status.json'),
  };
}

async function ensureStorage(paths: { rootDir: string; briefingsDir: string }): Promise<void> {
  await fs.mkdir(paths.rootDir, { recursive: true });
  await fs.mkdir(paths.briefingsDir, { recursive: true });
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function runCronJson(
  api: {
    runtime: {
      system: {
        runCommandWithTimeout: (
          argv: string[],
          options: { timeoutMs: number; cwd?: string }
        ) => Promise<{ stdout: string; stderr: string; code: number | null }>;
      };
    };
  },
  argv: string[]
): Promise<Record<string, unknown>> {
  const [subcommand = ''] = argv;
  const jsonUnsupported = subcommand === 'disable' || subcommand === 'edit';
  const command = jsonUnsupported
    ? ['openclaw', 'cron', ...argv]
    : ['openclaw', 'cron', ...argv, '--json'];
  let stdout: string;
  try {
    ({ stdout } = await runCommand(api, command, 60_000));
  } catch (error) {
    if (
      !jsonUnsupported &&
      error instanceof CommandExecutionError &&
      error.stderr.includes("unknown option '--json'")
    ) {
      ({ stdout } = await runCommand(api, ['openclaw', 'cron', ...argv], 60_000));
    } else {
      throw error;
    }
  }
  try {
    return asObject(JSON.parse(stdout));
  } catch {
    return {};
  }
}

async function runCronCommand(
  api: {
    runtime: {
      system: {
        runCommandWithTimeout: (
          argv: string[],
          options: { timeoutMs: number; cwd?: string }
        ) => Promise<{ stdout: string; stderr: string; code: number | null }>;
      };
    };
  },
  argv: string[]
): Promise<void> {
  await runCommand(api, ['openclaw', 'cron', ...argv], 60_000);
}

type CronJobRef = {
  id: string;
  enabled: boolean;
  updatedAtMs: number;
  createdAtMs: number;
};

async function listBriefingCronJobs(api: {
  runtime: {
    system: {
      runCommandWithTimeout: (
        argv: string[],
        options: { timeoutMs: number; cwd?: string }
      ) => Promise<{ stdout: string; stderr: string; code: number | null }>;
    };
  };
}): Promise<CronJobRef[]> {
  const listResult = await runCronJson(api, ['list']);
  return selectMorningBriefingJobs(listResult, CRON_JOB_NAME, 'morning_briefing_generate');
}

async function removeDuplicateBriefingCronJobs(
  api: {
    runtime: {
      system: {
        runCommandWithTimeout: (
          argv: string[],
          options: { timeoutMs: number; cwd?: string }
        ) => Promise<{ stdout: string; stderr: string; code: number | null }>;
      };
    };
    logger: { info?: (message: string) => void; warn?: (message: string) => void };
  },
  canonicalId: string
): Promise<void> {
  const jobs = await listBriefingCronJobs(api);
  for (const job of jobs) {
    if (job.id === canonicalId) {
      continue;
    }
    try {
      await runCronJson(api, ['remove', job.id]);
    } catch (error) {
      api.logger.warn?.(
        `Morning briefing: failed to remove duplicate cron ${job.id} (${String(error)})`
      );
    }
  }
}

function resolveDefaults(api: {
  config: {
    agents?: {
      defaults?: {
        userTimezone?: string;
      };
    };
  };
  pluginConfig?: Record<string, unknown>;
}): { cron: string; timezone: string } {
  const pluginConfig = resolvePluginConfig(api.pluginConfig);
  return {
    cron: pluginConfig.defaultCron?.trim() || DEFAULT_CRON,
    timezone:
      pluginConfig.defaultTimezone?.trim() ||
      api.config.agents?.defaults?.userTimezone ||
      DEFAULT_TIMEZONE,
  };
}

function resolveEffectiveTimezone(
  api: { logger: { info?: (message: string) => void; warn?: (message: string) => void } },
  timezone: string,
  context: 'enable' | 'schedule' | 'date'
): string {
  if (isValidTimezone(timezone)) {
    return timezone;
  }
  api.logger.warn?.(
    `Morning briefing: invalid configured timezone "${timezone}" during ${context}; falling back to ${DEFAULT_TIMEZONE}`
  );
  return DEFAULT_TIMEZONE;
}

async function readStoredConfig(
  api: {
    runtime: { state: { resolveStateDir: () => string } };
    config: {
      agents?: {
        defaults?: {
          userTimezone?: string;
        };
      };
    };
    pluginConfig?: Record<string, unknown>;
  },
  paths: { configPath: string }
): Promise<StoredConfig> {
  const defaults = resolveDefaults(api);
  const existing = await readJsonFile<StoredConfig>(paths.configPath);
  if (!existing) {
    return {
      enabled: false,
      cronJobId: null,
      cron: defaults.cron,
      timezone: defaults.timezone,
      interestTopics: [],
      userLocation: null,
      updatedAt: new Date().toISOString(),
    };
  }
  // Trim defensively — the worker validates length but a direct
  // authenticated gateway call could otherwise persist " Novato, CA "
  // and break case-sensitive UI compares downstream. Empty-after-trim
  // becomes null (treated the same as "never set").
  const trimmedUserLocation =
    typeof existing.userLocation === 'string' ? existing.userLocation.trim() : '';
  return {
    enabled: existing.enabled === true,
    cronJobId:
      typeof existing.cronJobId === 'string' && existing.cronJobId ? existing.cronJobId : null,
    cron: typeof existing.cron === 'string' && existing.cron ? existing.cron : defaults.cron,
    timezone:
      typeof existing.timezone === 'string' && existing.timezone
        ? existing.timezone
        : defaults.timezone,
    interestTopics: Array.isArray(existing.interestTopics)
      ? existing.interestTopics.filter((topic): topic is string => typeof topic === 'string')
      : [],
    userLocation: trimmedUserLocation.length > 0 ? trimmedUserLocation : null,
    updatedAt:
      typeof existing.updatedAt === 'string' ? existing.updatedAt : new Date().toISOString(),
  };
}

async function readStoredStatus(paths: { statusPath: string }): Promise<StoredStatus> {
  const existing = await readJsonFile<StoredStatus>(paths.statusPath);
  if (!existing) {
    return {
      lastGeneratedDate: null,
      lastGeneratedAt: null,
      lastPath: null,
      sourceSummary: [],
      failures: [],
      lastDelivery: [],
      observedEnabled: null,
      reconcileState: 'idle',
      lastReconcileAt: null,
      lastReconcileError: null,
      lastReconcileDurationMs: null,
      lastReconcileAction: null,
    };
  }
  return {
    lastGeneratedDate:
      typeof existing.lastGeneratedDate === 'string' ? existing.lastGeneratedDate : null,
    lastGeneratedAt: typeof existing.lastGeneratedAt === 'string' ? existing.lastGeneratedAt : null,
    lastPath: typeof existing.lastPath === 'string' ? existing.lastPath : null,
    sourceSummary: Array.isArray(existing.sourceSummary)
      ? existing.sourceSummary.filter(entry => typeof entry === 'object' && entry !== null)
      : [],
    failures: Array.isArray(existing.failures)
      ? existing.failures.filter(value => typeof value === 'string')
      : [],
    lastDelivery: parseStoredDelivery(existing.lastDelivery),
    observedEnabled:
      typeof existing.observedEnabled === 'boolean' ? existing.observedEnabled : null,
    reconcileState:
      existing.reconcileState === 'in_progress' ||
      existing.reconcileState === 'succeeded' ||
      existing.reconcileState === 'failed'
        ? existing.reconcileState
        : 'idle',
    lastReconcileAt: typeof existing.lastReconcileAt === 'string' ? existing.lastReconcileAt : null,
    lastReconcileError:
      typeof existing.lastReconcileError === 'string' ? existing.lastReconcileError : null,
    lastReconcileDurationMs:
      typeof existing.lastReconcileDurationMs === 'number'
        ? existing.lastReconcileDurationMs
        : null,
    lastReconcileAction:
      existing.lastReconcileAction === 'enable' || existing.lastReconcileAction === 'disable'
        ? existing.lastReconcileAction
        : null,
  };
}

async function queueStatusWrite<T>(statusPath: string, work: () => Promise<T>): Promise<T> {
  const previous = statusWriteQueueByPath.get(statusPath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  statusWriteQueueByPath.set(statusPath, next);
  try {
    return await next;
  } finally {
    if (statusWriteQueueByPath.get(statusPath) === next) {
      statusWriteQueueByPath.delete(statusPath);
    }
  }
}

/**
 * Serialise every read-modify-write of `config.json`. Holds the lock for
 * the full duration of `work`, including any external await calls
 * (e.g. `ensureCronJob` during reconcile). Mirror of `queueStatusWrite`
 * for the status file.
 */
async function queueConfigWrite<T>(configPath: string, work: () => Promise<T>): Promise<T> {
  const previous = configWriteQueueByPath.get(configPath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  configWriteQueueByPath.set(configPath, next);
  try {
    return await next;
  } finally {
    if (configWriteQueueByPath.get(configPath) === next) {
      configWriteQueueByPath.delete(configPath);
    }
  }
}

async function patchStoredStatus(
  paths: { statusPath: string },
  patch: Partial<StoredStatus>
): Promise<StoredStatus> {
  return queueStatusWrite(paths.statusPath, async () => {
    const current = await readStoredStatus(paths);
    const next: StoredStatus = {
      ...current,
      ...patch,
    };
    await writeJsonFile(paths.statusPath, next);
    return next;
  });
}

async function ensureCronJob(
  api: {
    runtime: {
      system: {
        runCommandWithTimeout: (
          argv: string[],
          options: { timeoutMs: number; cwd?: string }
        ) => Promise<{ stdout: string; stderr: string; code: number | null }>;
      };
    };
    logger: { info?: (message: string) => void; warn?: (message: string) => void };
  },
  config: StoredConfig
): Promise<{ cronJobId: string; cron: string; timezone: string }> {
  const timezone = resolveEffectiveTimezone(api, config.timezone, 'schedule');
  const existingJobs = await listBriefingCronJobs(api);
  let cronJobId = pickCanonicalCronJobId(existingJobs, config.cronJobId);

  if (cronJobId !== null) {
    try {
      await runCronJson(api, [
        'edit',
        cronJobId,
        '--session',
        'isolated',
        '--message',
        CRON_PROMPT,
        '--cron',
        config.cron,
        '--tz',
        timezone,
        '--tools',
        'morning_briefing_generate',
        '--no-deliver',
      ]);
      await removeDuplicateBriefingCronJobs(api, cronJobId);
      return { cronJobId, cron: config.cron, timezone };
    } catch (error) {
      api.logger.warn?.(
        `Morning briefing: existing cron edit failed (${String(error)}), recreating.`
      );
      cronJobId = null;
    }
  }

  const createResult = await runCronJson(api, [
    'add',
    '--name',
    CRON_JOB_NAME,
    '--session',
    'isolated',
    '--message',
    CRON_PROMPT,
    '--cron',
    config.cron,
    '--tz',
    timezone,
    '--tools',
    'morning_briefing_generate',
    '--no-deliver',
  ]);

  const topLevelId = typeof createResult.id === 'string' ? createResult.id : '';
  const createdJob = asObject(createResult.job);
  const nestedId = typeof createdJob.id === 'string' ? createdJob.id : '';
  const resolvedId = topLevelId || nestedId;
  if (!resolvedId) {
    throw new Error('Unable to resolve cron job id after enable');
  }

  await removeDuplicateBriefingCronJobs(api, resolvedId);

  return {
    cronJobId: resolvedId,
    cron: config.cron,
    timezone,
  };
}

async function resolveGithubReady(api: {
  runtime: {
    system: {
      runCommandWithTimeout: (
        argv: string[],
        options: { timeoutMs: number; cwd?: string }
      ) => Promise<{ stdout: string; stderr: string; code: number | null }>;
    };
  };
}): Promise<{ configured: boolean; summary: string }> {
  const result = await api.runtime.system.runCommandWithTimeout(['gh', 'auth', 'status'], {
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    return {
      configured: false,
      summary: 'GitHub CLI is not authenticated',
    };
  }
  return {
    configured: true,
    summary: 'GitHub CLI authentication is available',
  };
}

async function resolveWebSearchReady(api: {
  runtime: {
    webSearch: Pick<SdkWebSearchRuntime, 'listProviders'>;
  };
  config: OpenClawConfig;
}): Promise<{ configured: boolean; summary: string }> {
  const providers = api.runtime.webSearch.listProviders({ config: api.config });
  if (!Array.isArray(providers) || providers.length === 0) {
    return {
      configured: false,
      summary: 'No web search provider is configured',
    };
  }
  return {
    configured: true,
    summary: `Web search provider ready (${providers.length} provider${providers.length === 1 ? '' : 's'})`,
  };
}

function resolveLinearReady(): { configured: boolean; summary: string } {
  const hasLinearKey =
    typeof process.env.LINEAR_API_KEY === 'string' && process.env.LINEAR_API_KEY.trim().length > 0;
  if (!hasLinearKey) {
    return {
      configured: false,
      summary: 'Linear API key is not configured',
    };
  }
  return {
    configured: true,
    summary: 'Linear API key is configured',
  };
}

function normalizeGithubIssues(
  payload: unknown
): Array<{ title: string; url: string; updatedAt?: string }> {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload
    .map(raw => asObject(raw))
    .map(item => ({
      title: typeof item.title === 'string' ? item.title : '(untitled)',
      url: typeof item.url === 'string' ? item.url : '',
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : undefined,
    }))
    .filter(item => item.url.length > 0);
}

type GithubApiRunner = {
  runtime: {
    system: {
      runCommandWithTimeout: (
        argv: string[],
        options: { timeoutMs: number; cwd?: string }
      ) => Promise<{ stdout: string; stderr: string; code: number | null }>;
    };
  };
};

/**
 * Best-effort diagnostics for the empty-result path. Runs lightweight
 * `gh api` calls to figure out what token the user is on and what it can
 * see, so the brief can render an actionable "no issues" message instead
 * of a generic one. All failures here are absorbed into an 'unknown'
 * fallback so a broken diagnostic doesn't break the brief.
 */
async function gatherGithubEmptyResultContext(
  api: GithubApiRunner
): Promise<GithubEmptyResultContext> {
  const tokenType = classifyGithubToken(readGithubTokenFromEnv());

  // `gh api -i user` returns the raw HTTP response: status line + headers
  // + blank line + JSON body. We need both the body (for `.login`) and the
  // `X-OAuth-Scopes` header (only meaningful for classic PATs).
  let login: string | null = null;
  let scopes: string[] = [];
  try {
    const { stdout, code } = await api.runtime.system.runCommandWithTimeout(
      ['gh', 'api', '-i', 'user'],
      { timeoutMs: 10_000 }
    );
    if (code === 0) {
      // Split on the first blank line. The headers blob is everything
      // before it; the JSON body is everything after.
      const separatorMatch = /\r?\n\r?\n/.exec(stdout);
      const headersBlob = separatorMatch ? stdout.slice(0, separatorMatch.index) : stdout;
      const bodyText = separatorMatch
        ? stdout.slice(separatorMatch.index + separatorMatch[0].length)
        : '';
      scopes = parseOAuthScopesHeader(headersBlob);
      if (bodyText.trim().length > 0) {
        try {
          const parsed: unknown = JSON.parse(bodyText);
          if (typeof parsed === 'object' && parsed !== null && 'login' in parsed) {
            // After the `'login' in parsed` check TS narrows parsed.login
            // to `unknown`; the inner typeof guard is enough — no `as` cast.
            if (typeof parsed.login === 'string') {
              login = parsed.login;
            }
          }
        } catch {
          // Body wasn't JSON; leave login null.
        }
      }
    }
  } catch {
    // Network / spawn failure — fall through with login=null, scopes=[].
  }

  if (tokenType === 'classic' && login !== null) {
    return {
      tokenType: 'classic',
      login,
      scopes,
      missingScopes: missingBriefingScopes(scopes),
    };
  }

  if (tokenType === 'fine-grained' && login !== null) {
    let accessibleRepoCount = 0;
    try {
      const { stdout, code } = await api.runtime.system.runCommandWithTimeout(
        ['gh', 'api', 'user/repos', '--paginate', '--jq', '. | length'],
        { timeoutMs: 15_000 }
      );
      if (code === 0) {
        // `gh api --paginate --jq` emits one line per page. Sum them. The
        // accumulator starts at 0 and only adds finite values, so the total
        // is guaranteed finite — no post-sum guard needed.
        accessibleRepoCount = stdout
          .split(/\r?\n/)
          .map(line => Number.parseInt(line.trim(), 10))
          .filter(value => Number.isFinite(value))
          .reduce((sum, value) => sum + value, 0);
      }
    } catch {
      // Leave accessibleRepoCount=0 — the message still reads sensibly.
    }
    return {
      tokenType: 'fine-grained',
      login,
      accessibleRepoCount,
    };
  }

  // Fallback branch: either tokenType is already 'app' / 'oauth' / 'unknown'
  // (those flow through as-is), OR tokenType is 'classic' / 'fine-grained' but
  // login is null because the `gh api user` call failed earlier. In the
  // failed-auth case we degrade to 'unknown' rather than claim a classic /
  // fine-grained context we never confirmed.
  const authFailedClassicOrFineGrained =
    (tokenType === 'classic' || tokenType === 'fine-grained') && login === null;
  // After the earlier early-returns + the degrade-on-auth-failure above, the
  // tokenType reaching this return is always one of the third union variant's
  // literals. TS can't narrow GithubTokenType down to that subset on its own.
  const narrowedTokenType: 'app' | 'oauth' | 'unknown' = authFailedClassicOrFineGrained
    ? 'unknown'
    : (tokenType as 'app' | 'oauth' | 'unknown');
  return {
    tokenType: narrowedTokenType,
    login,
  };
}

async function collectGithub(api: GithubApiRunner): Promise<SourceCollectionResult> {
  const readiness = await resolveGithubReady(api);
  if (!readiness.configured) {
    return {
      source: 'github',
      configured: false,
      ok: false,
      summary: readiness.summary,
      sectionLines: [],
    };
  }

  try {
    const { stdout } = await runCommand(
      api,
      [
        'gh',
        'search',
        'issues',
        '--state',
        'open',
        '--involves',
        '@me',
        '--sort',
        'updated',
        '--order',
        'desc',
        '--limit',
        '12',
        '--json',
        'title,url,updatedAt',
      ],
      20_000
    );
    const items = normalizeGithubIssues(JSON.parse(stdout));
    if (items.length === 0) {
      const ctx = await gatherGithubEmptyResultContext(api);
      return {
        source: 'github',
        configured: true,
        ok: true,
        summary: buildGithubEmptySummary(ctx),
        // Clean empty (correctly-scoped token, just no issues) gets the
        // friendly one-liner; scope / token-misconfiguration cases keep
        // the verbose PR-7 diagnostic so the user can act on it.
        sectionLines: isCleanGithubEmptyResult(ctx)
          ? [GITHUB_EMPTY_LINE]
          : buildGithubEmptySectionLines(ctx),
      };
    }
    // Render at most 8 of the up-to-12 fetched issues. The TL;DR counts
    // the rendered set, not the fetched set, so the header can't claim
    // "12 issues" while the section only lists 8. `summary` keeps the
    // fetched count — it only surfaces in the debug Source Status footer.
    const renderedItems = items.slice(0, 8);
    const lines = renderedItems.map(item => {
      const updatedSuffix = item.updatedAt ? ` (updated ${item.updatedAt})` : '';
      return `- [${item.title}](${item.url})${updatedSuffix}`;
    });
    return {
      source: 'github',
      configured: true,
      ok: true,
      summary: `Fetched ${items.length} open GitHub issues`,
      sectionLines: lines,
      tldr: formatGithubTldr(renderedItems.length),
    };
  } catch (error) {
    return {
      source: 'github',
      configured: true,
      ok: false,
      summary: `GitHub query failed: ${error instanceof Error ? error.message : String(error)}`,
      sectionLines: [],
    };
  }
}

/**
 * Build a per-topic web-search query for the morning briefing.
 *
 * Each interest topic gets its OWN query so the search engine returns
 * balanced per-topic coverage. The old behavior (comma-joining all
 * topics into a single query) caused the engine to dilute results as
 * topics multiplied — 9 topics with a single 6-result count gave 6
 * mushy results trying to cover everything. The per-topic loop runs
 * one search per topic with a small count and dedupes by URL.
 *
 * Caller is responsible for trimming and filtering out "Local News"
 * (it has its own dedicated source). This function is called once per
 * topic with the topic string already cleaned.
 */
export function buildBriefingWebSearchQuery(topic: string): string {
  return `latest news and updates on ${topic} from the last 24 hours`;
}

/**
 * Per-topic web search call count cap. Each topic gets up to this many
 * results before the dedupe/cap step. Higher = better per-topic
 * coverage but more search-engine calls. 3 is a balance: enough to
 * dedupe duplicates and still surface 2-3 unique items per topic.
 */
const WEB_SEARCH_COUNT_PER_TOPIC = 3;

/**
 * Total result cap on the rendered `## Web Search` section. Even with
 * many topics, we slice down to this count after deduping by URL.
 */
const WEB_SEARCH_MAX_ITEMS = 10;

type WebSearchPerTopicResult = {
  topic: string;
  title: string;
  url: string;
};

async function collectWebSearch(
  api: WebSearchRuntime,
  interestTopics: readonly string[]
): Promise<SourceCollectionResult> {
  // Caller already filtered out "Local News" — that has its own source.
  // If nothing remains, the user hasn't opted into general web news.
  // No section body — `configured: false` routes it into the single
  // `## ⚙️ Connect more` nudge the assembler builds.
  const cleanedTopics = interestTopics.map(topic => topic.trim()).filter(topic => topic.length > 0);
  if (cleanedTopics.length === 0) {
    return {
      source: 'web',
      configured: false,
      ok: true,
      summary: 'No general-interest topics selected',
      sectionLines: [],
    };
  }

  const readiness = await resolveWebSearchReady(api);
  if (!readiness.configured) {
    return {
      source: 'web',
      configured: false,
      ok: false,
      summary: readiness.summary,
      sectionLines: [],
    };
  }

  // Per-topic loop. Run searches sequentially (provider rate limits +
  // ordering predictability outweigh the parallelism win for a daily
  // brief). Per-topic failures are swallowed and logged so a transient
  // search error doesn't tank the whole section. Results across topics
  // are deduped by URL — first-seen-wins so the topic that pulled it
  // in keeps the badge.
  const accumulated: WebSearchPerTopicResult[] = [];
  const seenUrls = new Set<string>();
  const providersTried = new Set<string>();
  // Track which topics returned a response (even if empty) vs threw.
  // If EVERY topic threw, we treat the whole source as failed instead
  // of misreporting it as a successful empty search — that would hide
  // real outages (rate limits, auth breaks, provider down) from the
  // brief's failure list and source-status footer.
  let topicSuccessCount = 0;
  const topicFailures: Array<{ topic: string; error: string }> = [];
  for (const topic of cleanedTopics) {
    try {
      const response = await api.runtime.webSearch.search({
        config: api.config,
        args: {
          query: buildBriefingWebSearchQuery(topic),
          count: WEB_SEARCH_COUNT_PER_TOPIC,
        },
      });
      providersTried.add(response.provider);
      topicSuccessCount += 1;
      const results = normalizeWebResults(response.result);
      for (const item of results) {
        if (!item.url || seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        accumulated.push({ topic, title: item.title, url: item.url });
      }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      topicFailures.push({ topic, error: errorText });
      api.logger.warn?.(`Morning briefing web search topic '${topic}' failed: ${errorText}`);
    }
  }

  // Hard failure: zero topics returned a response. Surface as an error
  // source so the brief's failure section and source-status footer
  // record it. Without this, a complete provider outage looks
  // identical to a benign empty result.
  if (topicSuccessCount === 0) {
    const firstFailure = topicFailures[0]?.error ?? 'unknown error';
    return {
      source: 'web',
      configured: true,
      ok: false,
      summary: `Web search failed for all ${cleanedTopics.length} topic(s): ${firstFailure}`,
      sectionLines: [],
    };
  }

  if (accumulated.length === 0) {
    return {
      source: 'web',
      configured: true,
      ok: true,
      summary: 'Web search returned no results',
      sectionLines: [WEB_EMPTY_LINE],
    };
  }

  const rendered = accumulated.slice(0, WEB_SEARCH_MAX_ITEMS);
  const providerSuffix = providersTried.size > 0 ? ` (${[...providersTried].join(', ')})` : '';
  return {
    source: 'web',
    configured: true,
    ok: true,
    summary: `Fetched ${rendered.length} web results across ${cleanedTopics.length} topic(s)${providerSuffix}`,
    sectionLines: rendered.map(item => `- [${item.topic}] [${item.title}](${item.url})`),
    tldr: formatWebTldr(rendered.length),
  };
}

type WebSearchRuntime = {
  runtime: {
    webSearch: SdkWebSearchRuntime;
  };
  config: OpenClawConfig;
  logger: { info?: (message: string) => void; warn?: (message: string) => void };
};

/**
 * Detect whether the user opted into Local News by checking for the
 * exact `LOCAL_NEWS_INTEREST_LABEL` string in their interest topics.
 * Case-insensitive, whitespace-trimmed — matches how the Settings
 * editor stores topics.
 */
function wantsLocalNews(interestTopics: readonly string[]): boolean {
  const target = LOCAL_NEWS_INTEREST_LABEL.toLowerCase();
  return interestTopics.some(topic => topic.trim().toLowerCase() === target);
}

/**
 * Run the Local News tier escalation. Loops `buildLocalNewsTiers` in
 * order, calling `webSearch.search()` per tier, deduping by URL across
 * tiers, and stopping early once we have at least
 * `LOCAL_NEWS_MIN_ITEMS` unique results. Caps at `LOCAL_NEWS_MAX_ITEMS`.
 *
 * Any individual tier failure is swallowed so a transient search
 * provider error doesn't tank the whole section — we just move on to
 * the next tier and aggregate what we have.
 *
 * Caller is responsible for short-circuiting the no-location case
 * (the tier list comes back empty for `kind: 'none'`); this loop just
 * returns an empty array in that case, which is fine but wasteful if
 * the caller didn't short-circuit.
 */
async function runLocalNewsTiers(
  api: WebSearchRuntime,
  locationContext: LocationContext
): Promise<{ items: LocalNewsItem[]; providersTried: string[]; tiersConsumed: number }> {
  const tiers = buildLocalNewsTiers(locationContext);
  const accumulated: LocalNewsItem[] = [];
  const providersTried = new Set<string>();
  let tiersConsumed = 0;

  for (const query of tiers) {
    tiersConsumed += 1;
    try {
      const response = await api.runtime.webSearch.search({
        config: api.config,
        args: { query, count: LOCAL_NEWS_MAX_ITEMS },
      });
      providersTried.add(response.provider);
      const fresh = normalizeWebResults(response.result).map<LocalNewsItem>(item => ({
        title: item.title,
        url: item.url,
        summary: item.summary,
      }));
      const novel = dedupeByUrl(fresh, accumulated);
      accumulated.push(...novel);
      if (accumulated.length >= LOCAL_NEWS_MIN_ITEMS) {
        break;
      }
    } catch (error) {
      // Swallow per-tier errors; the next tier may still succeed and
      // the accumulated set might already be enough. Logger surfaces
      // the failure for observability without breaking the brief.
      const errorText = error instanceof Error ? error.message : String(error);
      api.logger.warn?.(`Morning briefing local-news tier ${tiersConsumed} failed: ${errorText}`);
    }
  }

  return {
    items: accumulated.slice(0, LOCAL_NEWS_MAX_ITEMS),
    providersTried: Array.from(providersTried),
    tiersConsumed,
  };
}

/**
 * Build the `local-news` SourceCollectionResult. Only invoked when
 * the user has `Local News` in their interest topics; otherwise the
 * brief skips this source entirely.
 *
 * Three result shapes:
 * - No location resolvable: emits a "set a location" nudge in the
 *   section body and a status footer flagged `[skipped]`.
 * - Web-search provider unavailable: error shape, no section content.
 * - Got results: section renders the items, status footer reports
 *   tier count + provider(s) used.
 */
async function collectLocalNews(
  api: WebSearchRuntime,
  storedUserLocation: string | null
): Promise<SourceCollectionResult> {
  // Stored config overrides env. Settings edits write to config.json
  // via the gateway `/user-location` route; the override takes effect
  // on the next brief without restart. Env var is the boot-time
  // fallback (set at provision time).
  const locationContext = resolveLocationContextWithOverride(storedUserLocation);

  if (locationContext.kind === 'none') {
    // No section body — `configured: false` routes Local News into the
    // single `## ⚙️ Connect more` nudge the assembler builds.
    return {
      source: 'local-news',
      configured: false,
      ok: true,
      summary: LOCAL_NEWS_NO_LOCATION_SUMMARY,
      sectionLines: [],
      sectionTitle: buildLocalNewsSectionTitle(locationContext),
    };
  }

  const readiness = await resolveWebSearchReady(api);
  if (!readiness.configured) {
    return {
      source: 'local-news',
      configured: false,
      ok: false,
      summary: readiness.summary,
      sectionLines: [],
      sectionTitle: buildLocalNewsSectionTitle(locationContext),
    };
  }

  try {
    const { items, providersTried, tiersConsumed } = await runLocalNewsTiers(api, locationContext);
    if (items.length === 0) {
      return {
        source: 'local-news',
        configured: true,
        ok: true,
        summary: `0 local news results after ${tiersConsumed} tier(s)`,
        sectionLines: [buildLocalNewsEmptyLine(locationContext)],
        sectionTitle: buildLocalNewsSectionTitle(locationContext),
      };
    }
    const providerSuffix = providersTried.length > 0 ? ` via ${providersTried.join(', ')}` : '';
    return {
      source: 'local-news',
      configured: true,
      ok: true,
      summary: `Fetched ${items.length} local news result(s) in ${tiersConsumed} tier(s)${providerSuffix}`,
      sectionLines: items.map(formatLocalNewsLine),
      sectionTitle: buildLocalNewsSectionTitle(locationContext),
      tldr: formatLocalNewsTldr(items.length),
    };
  } catch (error) {
    return {
      source: 'local-news',
      configured: true,
      ok: false,
      summary: `Local news search failed: ${error instanceof Error ? error.message : String(error)}`,
      sectionLines: [],
      sectionTitle: buildLocalNewsSectionTitle(locationContext),
    };
  }
}

async function collectLinear(api: {
  runtime: {
    state: { resolveStateDir: () => string };
    system: {
      runCommandWithTimeout: (
        argv: string[],
        options: { timeoutMs: number; cwd?: string }
      ) => Promise<{ stdout: string; stderr: string; code: number | null }>;
    };
  };
}): Promise<SourceCollectionResult> {
  const readiness = resolveLinearReady();
  if (!readiness.configured) {
    return {
      source: 'linear',
      configured: false,
      ok: false,
      summary: readiness.summary,
      sectionLines: [],
    };
  }

  const workspaceDir = path.join(api.runtime.state.resolveStateDir(), 'workspace');
  const result = await api.runtime.system.runCommandWithTimeout(
    [
      'mcporter',
      'call',
      'linear',
      'list_issues',
      'assignee:me',
      'limit:8',
      'orderBy:updatedAt',
      '--output',
      'json',
    ],
    {
      timeoutMs: 25_000,
      cwd: workspaceDir,
    }
  );

  if (result.code !== 0) {
    return {
      source: 'linear',
      configured: true,
      ok: false,
      summary: summarizeLinearCallFailure(result.stdout, result.stderr),
      sectionLines: [],
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return {
      source: 'linear',
      configured: true,
      ok: false,
      summary: 'Linear returned non-JSON output',
      sectionLines: [],
    };
  }

  const issues = normalizeLinearIssues(payload);
  if (issues.length === 0) {
    return {
      source: 'linear',
      configured: true,
      ok: true,
      summary: '0 issues assigned to you in Linear',
      sectionLines: [LINEAR_EMPTY_LINE],
    };
  }

  const briefHasHighSignal = hasHighSignalPriority(issues);
  return {
    source: 'linear',
    configured: true,
    ok: true,
    summary: `Fetched ${issues.length} Linear issues assigned to you`,
    sectionLines: issues.map(issue => formatLinearIssueLine(issue, briefHasHighSignal)),
    tldr: formatLinearTldr(issues),
  };
}

/**
 * Pulls today + tomorrow-morning events from the user's primary Google
 * calendar via the controller's OAuth broker. Both Settings UI cards
 * (simple "Calendar Connect" and the full Google Account flow) write
 * to the same per-instance connection row, so this collector is path-
 * agnostic: ask the broker for status, then for a token, then hit
 * Google.
 *
 * Returns:
 *   - `ok:true, configured:false` + nudge body when no Google
 *     connection or no calendar capability is present
 *   - `ok:true, configured:true` + rendered section when calendar
 *     fetch succeeds (including the empty-calendar case)
 *   - `ok:false, configured:true` when the broker has a connection
 *     but the token fetch or Google API call fails — the source
 *     surfaces in the `## Failures` list and the source-status footer
 */
async function collectCalendar(now: Date, userTimezone: string): Promise<SourceCollectionResult> {
  const readiness = await resolveCalendarReady();
  if (!readiness.statusOk) {
    return {
      source: 'calendar',
      configured: true,
      ok: false,
      summary: readiness.reason,
      sectionLines: [],
    };
  }

  // Both "no Google connection" and "connected without calendar scope"
  // emit no section body — `configured: false` routes Calendar into the
  // single `## ⚙️ Connect more` nudge the assembler builds.
  if (!readiness.connected) {
    return {
      source: 'calendar',
      configured: false,
      ok: true,
      summary: readiness.reason,
      sectionLines: [],
    };
  }

  if (!readiness.hasCalendarCapability) {
    return {
      source: 'calendar',
      configured: false,
      ok: true,
      summary: readiness.reason,
      sectionLines: [],
    };
  }

  let token: Awaited<ReturnType<typeof fetchCalendarAccessToken>>;
  try {
    token = await fetchCalendarAccessToken();
  } catch (error) {
    return {
      source: 'calendar',
      configured: true,
      ok: false,
      summary: `Could not retrieve Google access token: ${error instanceof Error ? error.message : String(error)}`,
      sectionLines: [],
    };
  }

  const { timeMin, timeMax } = buildCalendarTimeWindow(now, userTimezone);
  try {
    const events = await fetchCalendarEvents(token.accessToken, timeMin, timeMax);
    return {
      source: 'calendar',
      configured: true,
      ok: true,
      summary: `Fetched ${events.length} events for ${token.accountEmail}`,
      sectionLines: buildCalendarSectionLines(events, now, userTimezone),
      sectionTitle: buildCalendarSectionTitle(token.accountEmail),
      tldr: formatCalendarTldr(events, now, userTimezone),
    };
  } catch (error) {
    return {
      source: 'calendar',
      configured: true,
      ok: false,
      summary: `Google Calendar fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      sectionLines: [],
    };
  }
}

async function collectKiloChatSummary(
  now: Date,
  userTimezone: string
): Promise<SourceCollectionResult> {
  const client = createKiloChatSummaryClient();
  if (!client.configured) {
    return {
      source: 'kilo-chat',
      configured: false,
      ok: true,
      summary: client.reason,
      sectionLines: [],
    };
  }

  const yesterdayWindow = buildYesterdayChatWindow(now, userTimezone);
  const todayWindow = buildTodaySoFarChatWindow(now, userTimezone);
  try {
    const [yesterday, today] = await Promise.all([
      client.listConversationsForWindow(yesterdayWindow),
      client.listConversationsForWindow(todayWindow),
    ]);
    const yesterdayStats = summarizeChatActivity(yesterday.conversations, yesterdayWindow);
    const todayStats = summarizeChatActivity(today.conversations, todayWindow);
    const truncatedNote =
      yesterday.truncated || today.truncated
        ? ' (counts truncated; activity exceeded the scan limit)'
        : '';
    return {
      source: 'kilo-chat',
      configured: true,
      ok: true,
      summary: `Yesterday: ${buildChatSummaryStatus(
        yesterdayStats,
        'yesterday'
      )}; today: ${buildChatSummaryStatus(todayStats, 'so far today')}${truncatedNote}`,
      sectionLines: [],
      sections: [
        {
          title: `💬 Yesterday in Chat (${yesterdayWindow.dateKey})`,
          lines: buildChatSummarySectionLines(yesterdayStats, CHAT_EMPTY_YESTERDAY),
        },
        {
          title: '💬 So Far Today in Chat',
          lines: buildChatSummarySectionLines(todayStats, CHAT_EMPTY_TODAY),
        },
      ],
      tldr: formatChatTldr(yesterdayStats),
    };
  } catch (error) {
    return {
      source: 'kilo-chat',
      configured: true,
      ok: false,
      summary: `Kilo Chat summary failed: ${error instanceof Error ? error.message : String(error)}`,
      sectionLines: [],
    };
  }
}

async function generateBriefing(
  api: {
    runtime: {
      state: { resolveStateDir: () => string };
      system: {
        runCommandWithTimeout: (
          argv: string[],
          options: { timeoutMs: number; cwd?: string }
        ) => Promise<{ stdout: string; stderr: string; code: number | null }>;
      };
      webSearch: SdkWebSearchRuntime;
    };
    config: {
      agents?: { defaults?: { userTimezone?: string } };
    };
    logger: { info?: (message: string) => void; warn?: (message: string) => void };
  },
  dateKey: string
): Promise<{
  dateKey: string;
  filePath: string;
  markdown: string;
  sources: SourceCollectionResult[];
  failures: string[];
  delivery: BriefingDeliveryResult[];
}> {
  const paths = getStatePaths(api);
  await ensureStorage(paths);

  // Read interest topics + userLocation directly from config.json. The
  // `api.config.agents.defaults.userTimezone` field above gives us the
  // brief's effective timezone for the Calendar source's time window.
  // Missing or malformed config.json => empty topics + null location
  // (env-var fallback path in resolveLocationContextWithOverride).
  const storedConfig = await readJsonFile<StoredConfig>(paths.configPath);
  const interestTopics = Array.isArray(storedConfig?.interestTopics)
    ? storedConfig.interestTopics.filter((value): value is string => typeof value === 'string')
    : [];
  const storedUserLocation =
    typeof storedConfig?.userLocation === 'string' && storedConfig.userLocation.trim().length > 0
      ? storedConfig.userLocation.trim()
      : null;

  // Always-on sources first, then opt-in sources based on interests.
  // Order in the array determines order in the rendered brief.
  //
  // "Local News" is excluded from the Web Search topic list — it has
  // its own dedicated source and shouldn't leak into the general
  // web-search query (otherwise the search engine treats "Local News"
  // as text and returns local stories from arbitrary cities, ignoring
  // the user's actual location). Case-insensitive trim matches the
  // plugin's `wantsLocalNews` exactly.
  const localNewsLabelLower = LOCAL_NEWS_INTEREST_LABEL.toLowerCase();
  const webSearchTopics = interestTopics.filter(
    topic => topic.trim().toLowerCase() !== localNewsLabelLower
  );
  // Calendar uses the user's IANA timezone for time window + formatting.
  // Falls back to UTC when not configured (the brief plugin already
  // accepts that fallback elsewhere via `resolveEffectiveTimezone`).
  const storedTimezone =
    typeof storedConfig?.timezone === 'string' && storedConfig.timezone.trim().length > 0
      ? storedConfig.timezone.trim()
      : null;
  const configuredTimezone = storedTimezone ?? api.config.agents?.defaults?.userTimezone;
  const briefingTimezone =
    configuredTimezone && isValidTimezone(configuredTimezone)
      ? configuredTimezone
      : DEFAULT_TIMEZONE;

  const generatedAt = new Date();
  const corePromises = [
    collectCalendar(generatedAt, briefingTimezone),
    collectKiloChatSummary(generatedAt, briefingTimezone),
    collectGithub(api),
    collectLinear(api),
    collectWebSearch(api, webSearchTopics),
  ];
  const [calendar, kiloChat, github, linear, web] = await Promise.all(corePromises);
  // Local News slots between Linear and Web Search — interest-gated so
  // users who haven't opted in pay no search cost and see no
  // local-news entry in the source-status footer.
  const localNews = wantsLocalNews(interestTopics)
    ? await collectLocalNews(api, storedUserLocation)
    : null;

  // Canonical brief order: Calendar → Linear → GitHub → Local News →
  // Web → Kilo Chat. Fixed so the user gets the same rhythm every
  // morning. Array order drives both the rendered section order and
  // the `**TL;DR:**` fragment order.
  const sources: SourceCollectionResult[] = [
    calendar,
    linear,
    github,
    ...(localNews ? [localNews] : []),
    web,
    kiloChat,
  ];
  const successes = sources.filter(source => source.ok);

  if (successes.length === 0) {
    throw new Error(
      'No usable briefing sources are available. Configure at least one of Calendar, Kilo Chat, GitHub, Linear, Local News, or web search.'
    );
  }

  // Only configured-but-errored sources are failures. A source the user
  // simply hasn't connected (`configured: false`) belongs in the
  // `## ⚙️ Connect more` nudge the assembler builds, not the failure list.
  const failures = sources
    .filter(source => source.configured && !source.ok)
    .map(source => `${source.source}: ${source.summary}`);
  // Default titles per source type, each carrying the source's canonical
  // emoji. Individual sources can override via
  // `SourceCollectionResult.sectionTitle` (Calendar uses the connected
  // account email, Local News the resolved location) — those builders
  // prepend the same emoji themselves.
  const DEFAULT_SECTION_TITLE: Record<SourceCollectionResult['source'], string> = {
    calendar: '🗓 Calendar',
    github: '🐙 GitHub',
    // `kilo-chat` always supplies its own `sections`, so this entry only
    // exists to satisfy the exhaustive Record type and is never rendered.
    'kilo-chat': '💬 Kilo Chat',
    linear: '📈 Linear',
    'local-news': '📰 Local News',
    web: '🌐 Web',
  };
  // TL;DR fragments in canonical source order; empty fragments dropped.
  const tldr = sources
    .map(source => source.tldr?.trim())
    .filter((fragment): fragment is string => Boolean(fragment))
    .join(' · ');
  // `BRIEFING_DEBUG` (1/true/yes) appends the operator-facing
  // `## Source Status` footer; off by default for the user-facing brief.
  const debug = ['1', 'true', 'yes'].includes(
    (process.env.BRIEFING_DEBUG ?? '').trim().toLowerCase()
  );
  const markdown = buildBriefingMarkdown({
    dateKey,
    generatedAt,
    statuses: sources.map(source => ({
      source: source.source,
      configured: source.configured,
      ok: source.ok,
      summary: source.summary,
    })),
    sections: sources.flatMap(
      source =>
        source.sections ?? [
          {
            title: source.sectionTitle ?? DEFAULT_SECTION_TITLE[source.source],
            lines: source.sectionLines,
          },
        ]
    ),
    failures,
    tldr,
    debug,
  });

  const filePath = resolveBriefingPath(paths.briefingsDir, dateKey);
  await fs.writeFile(filePath, markdown, 'utf8');
  let delivery: BriefingDeliveryResult[];
  try {
    delivery = await deliverBriefingToConfiguredChannels(api, markdown);
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    api.logger.warn?.(`Morning briefing delivery failed unexpectedly: ${errorText}`);
    delivery = DELIVERY_CHANNELS.map(channel => ({
      channel,
      status: 'failed',
      reason: 'config_unavailable',
      error: errorText,
    }));
  }
  logDeliveryOutcomeEvents(api, delivery);

  await patchStoredStatus(paths, {
    lastGeneratedDate: dateKey,
    lastGeneratedAt: generatedAt.toISOString(),
    lastPath: filePath,
    sourceSummary: sources.map(source => ({
      source: source.source,
      configured: source.configured,
      ok: source.ok,
      summary: source.summary,
    })),
    failures,
    lastDelivery: delivery,
  });

  return {
    dateKey,
    filePath,
    markdown,
    sources,
    failures,
    delivery,
  };
}

async function readBriefingByDateKey(
  api: { runtime: { state: { resolveStateDir: () => string } } },
  dateKey: string
): Promise<{ dateKey: string; filePath: string; exists: boolean; markdown: string | null }> {
  const paths = getStatePaths(api);
  await ensureStorage(paths);
  const filePath = resolveBriefingPath(paths.briefingsDir, dateKey);
  try {
    const markdown = await fs.readFile(filePath, 'utf8');
    return {
      dateKey,
      filePath,
      exists: true,
      markdown,
    };
  } catch {
    return {
      dateKey,
      filePath,
      exists: false,
      markdown: null,
    };
  }
}

async function resolveDateKeyForOffset(
  api: {
    runtime: { state: { resolveStateDir: () => string } };
    config: {
      agents?: {
        defaults?: {
          userTimezone?: string;
        };
      };
    };
    pluginConfig?: Record<string, unknown>;
    logger: { info?: (message: string) => void; warn?: (message: string) => void };
  },
  offset: number
): Promise<string> {
  const paths = getStatePaths(api);
  await ensureStorage(paths);
  const config = await readStoredConfig(api, paths);
  const timezone = resolveEffectiveTimezone(api, config.timezone, 'date');
  return offsetDateKey(new Date(), offset, timezone);
}

async function getStatusSnapshot(api: {
  runtime: {
    state: { resolveStateDir: () => string };
    system: {
      runCommandWithTimeout: (
        argv: string[],
        options: { timeoutMs: number; cwd?: string }
      ) => Promise<{ stdout: string; stderr: string; code: number | null }>;
    };
    webSearch: Pick<SdkWebSearchRuntime, 'listProviders'>;
  };
  config: {
    agents?: {
      defaults?: {
        userTimezone?: string;
      };
    };
  };
  pluginConfig?: Record<string, unknown>;
}): Promise<{
  enabled: boolean;
  cron: string;
  timezone: string;
  cronJobId: string | null;
  lastGeneratedDate: string | null;
  lastGeneratedAt: string | null;
  sourceReadiness: {
    github: { configured: boolean; summary: string };
    linear: { configured: boolean; summary: string };
    web: { configured: boolean; summary: string };
  };
  lastDelivery: BriefingDeliveryResult[];
  reconcileState: 'idle' | 'in_progress' | 'succeeded' | 'failed';
  lastReconcileAt: string | null;
  lastReconcileError: string | null;
  lastReconcileAction: 'enable' | 'disable' | null;
  desiredEnabled: boolean;
  observedEnabled: boolean | null;
  interestTopics: string[];
}> {
  const paths = getStatePaths(api);
  await ensureStorage(paths);
  const config = await readStoredConfig(api, paths);
  const status = await readStoredStatus(paths);
  const [github, web] = await Promise.all([resolveGithubReady(api), resolveWebSearchReady(api)]);
  const linear = resolveLinearReady();
  const enabled = status.observedEnabled ?? config.enabled;

  return {
    enabled,
    cron: config.cron,
    timezone: config.timezone,
    cronJobId: config.cronJobId,
    lastGeneratedDate: status.lastGeneratedDate,
    lastGeneratedAt: status.lastGeneratedAt,
    sourceReadiness: {
      github,
      linear,
      web,
    },
    lastDelivery: status.lastDelivery,
    reconcileState: status.reconcileState,
    lastReconcileAt: status.lastReconcileAt,
    lastReconcileError: status.lastReconcileError,
    lastReconcileAction: status.lastReconcileAction,
    desiredEnabled: config.enabled,
    observedEnabled: status.observedEnabled,
    interestTopics: config.interestTopics,
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: 'KiloClawMorningBriefing',
  description: 'Morning briefing plugin for KiloClaw-hosted OpenClaw instances',
  register(api) {
    let reconcileInFlight: Promise<void> | null = null;
    let queuedReconcileAction: 'enable' | 'disable' | null = null;

    const reconcileDesiredState = async (
      action: 'enable' | 'disable'
    ): Promise<'succeeded' | 'failed'> => {
      const paths = getStatePaths(api);
      await ensureStorage(paths);
      const startedAt = Date.now();

      await patchStoredStatus(paths, {
        reconcileState: 'in_progress',
        lastReconcileError: null,
        lastReconcileAction: action,
      });

      try {
        // Hold the config-write lock across the entire reconcile so a
        // concurrent interests/enable/disable handler can't slip a write
        // between our read and our final write (the `ensureCronJob` call
        // below is slow). `patchStoredStatus` uses a separate queue, so
        // no deadlock from nesting.
        return await queueConfigWrite<'succeeded' | 'failed'>(paths.configPath, async () => {
          const config = await readStoredConfig(api, paths);

          if (config.enabled) {
            const ensured = await ensureCronJob(api, config);
            const finalConfig: StoredConfig = {
              ...config,
              cronJobId: ensured.cronJobId,
              cron: ensured.cron,
              timezone: ensured.timezone,
              updatedAt: new Date().toISOString(),
            };
            await writeJsonFile(paths.configPath, finalConfig);
            await patchStoredStatus(paths, {
              observedEnabled: true,
              reconcileState: 'succeeded',
              lastReconcileAt: new Date().toISOString(),
              lastReconcileError: null,
              lastReconcileDurationMs: Date.now() - startedAt,
              lastReconcileAction: action,
            });
            return 'succeeded';
          }

          const jobs = await listBriefingCronJobs(api);
          const disableErrors: string[] = [];
          for (const job of jobs) {
            try {
              await runCronCommand(api, ['disable', job.id]);
            } catch (error) {
              disableErrors.push(
                `Failed to disable cron ${job.id}: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
          const remainingEnabledJobs = filterEnabledBriefingJobs(await listBriefingCronJobs(api));
          if (disableErrors.length > 0 || remainingEnabledJobs.length > 0) {
            const issues: string[] = [];
            issues.push(...disableErrors);
            if (remainingEnabledJobs.length > 0) {
              issues.push(
                `Cron jobs still enabled after disable: ${remainingEnabledJobs.map(job => job.id).join(', ')}`
              );
            }
            throw new Error(issues.join(' | '));
          }

          const finalConfig: StoredConfig = {
            ...config,
            enabled: false,
            cronJobId: null,
            updatedAt: new Date().toISOString(),
          };
          await writeJsonFile(paths.configPath, finalConfig);
          await patchStoredStatus(paths, {
            observedEnabled: false,
            reconcileState: 'succeeded',
            lastReconcileAt: new Date().toISOString(),
            lastReconcileError: null,
            lastReconcileDurationMs: Date.now() - startedAt,
            lastReconcileAction: action,
          });
          return 'succeeded';
        });
      } catch (error) {
        await patchStoredStatus(paths, {
          reconcileState: 'failed',
          lastReconcileAt: new Date().toISOString(),
          lastReconcileError: error instanceof Error ? error.message : String(error),
          lastReconcileDurationMs: Date.now() - startedAt,
          lastReconcileAction: action,
        });
        return 'failed';
      }
    };

    const triggerReconcile = (action: 'enable' | 'disable') => {
      if (reconcileInFlight) {
        queuedReconcileAction = action;
        return;
      }
      const runReconcileLoop = async (initialAction: 'enable' | 'disable') => {
        let nextAction: 'enable' | 'disable' | null = initialAction;

        while (nextAction) {
          const reconcileResult = await reconcileDesiredState(nextAction);

          const queuedAction = queuedReconcileAction;
          queuedReconcileAction = null;

          const paths = getStatePaths(api);
          await ensureStorage(paths);
          const [config, status] = await Promise.all([
            readStoredConfig(api, paths),
            readStoredStatus(paths),
          ]);

          nextAction =
            reconcileResult === 'failed'
              ? queuedAction
              : resolveNextReconcileAction({
                  queuedAction,
                  desiredEnabled: config.enabled,
                  observedEnabled: status.observedEnabled,
                });
        }
      };

      reconcileInFlight = runReconcileLoop(action).finally(() => {
        reconcileInFlight = null;
      });
      void reconcileInFlight.catch(error => {
        api.logger.warn?.(`Morning briefing reconcile failed: ${String(error)}`);
      });
    };

    const enableFromInput = async (input: EnableInput) => {
      const paths = getStatePaths(api);
      await ensureStorage(paths);

      const requestedTimezone = input.timezone?.trim();
      if (requestedTimezone && !isValidTimezone(requestedTimezone)) {
        throw new Error(`Invalid timezone: ${requestedTimezone}`);
      }

      const nextConfig = await queueConfigWrite(paths.configPath, async () => {
        const current = await readStoredConfig(api, paths);
        const timezone = requestedTimezone
          ? requestedTimezone
          : resolveEffectiveTimezone(api, current.timezone, 'enable');
        const next: StoredConfig = {
          ...current,
          enabled: true,
          cron: input.cron?.trim() || current.cron,
          timezone,
          updatedAt: new Date().toISOString(),
        };
        await writeJsonFile(paths.configPath, next);
        return next;
      });

      await patchStoredStatus(paths, {
        reconcileState: 'in_progress',
        lastReconcileError: null,
        lastReconcileAction: 'enable',
      });
      triggerReconcile('enable');
      return nextConfig;
    };

    const enableFromCommand = async (args: string | undefined) => {
      return enableFromInput(parseEnableArgs(args));
    };

    const disableFromCommand = async () => {
      const paths = getStatePaths(api);
      await ensureStorage(paths);

      const nextConfig = await queueConfigWrite(paths.configPath, async () => {
        const current = await readStoredConfig(api, paths);
        const next: StoredConfig = {
          ...current,
          enabled: false,
          updatedAt: new Date().toISOString(),
        };
        await writeJsonFile(paths.configPath, next);
        return next;
      });

      await patchStoredStatus(paths, {
        reconcileState: 'in_progress',
        lastReconcileError: null,
        lastReconcileAction: 'disable',
      });
      triggerReconcile('disable');
      return nextConfig;
    };

    // Update interest topics only — does NOT trigger reconcile because
    // topics only affect the *next* briefing run's web-search query,
    // not the cron registration. The worker enforces caps + sanitization
    // before calling this route; we trust its input here.
    const updateInterestsFromInput = async (topics: string[]): Promise<StoredConfig> => {
      const paths = getStatePaths(api);
      await ensureStorage(paths);
      return queueConfigWrite(paths.configPath, async () => {
        const current = await readStoredConfig(api, paths);
        const next: StoredConfig = {
          ...current,
          interestTopics: topics,
          updatedAt: new Date().toISOString(),
        };
        await writeJsonFile(paths.configPath, next);
        return next;
      });
    };

    // Update user location only — same write-only semantics as
    // updateInterestsFromInput: doesn't touch cron, doesn't trigger
    // reconcile. Affects the next briefing's Local News tier queries
    // via `resolveLocationContextWithOverride`. Caller passes the
    // trimmed string (or `null` to clear).
    const updateUserLocationFromInput = async (
      userLocation: string | null
    ): Promise<StoredConfig> => {
      const paths = getStatePaths(api);
      await ensureStorage(paths);
      return queueConfigWrite(paths.configPath, async () => {
        const current = await readStoredConfig(api, paths);
        const next: StoredConfig = {
          ...current,
          userLocation,
          updatedAt: new Date().toISOString(),
        };
        await writeJsonFile(paths.configPath, next);
        return next;
      });
    };

    void (async () => {
      const paths = getStatePaths(api);
      await ensureStorage(paths);
      const [config, status] = await Promise.all([
        readStoredConfig(api, paths),
        readStoredStatus(paths),
      ]);
      const shouldReconcile =
        status.reconcileState === 'in_progress' ||
        config.enabled ||
        (status.observedEnabled !== null && status.observedEnabled !== config.enabled);
      if (shouldReconcile) {
        triggerReconcile(config.enabled ? 'enable' : 'disable');
      }
    })();

    const runBriefingCommand = async (argsText: string, options?: { forAgent?: boolean }) => {
      const args = argsText.trim();
      const [subcommand = 'status'] = args.split(/\s+/).filter(Boolean);

      if (subcommand === 'enable') {
        const trailing = args.replace(/^enable\s*/, '');
        const config = await enableFromCommand(trailing);
        const status = await readStoredStatus(getStatePaths(api));
        return [
          'Morning Briefing enable requested.',
          `- schedule: ${config.cron}`,
          `- timezone: ${config.timezone}`,
          `- apply state: ${status.reconcileState}`,
        ].join('\n');
      }

      if (subcommand === 'disable') {
        const config = await disableFromCommand();
        const status = await readStoredStatus(getStatePaths(api));
        return [
          'Morning Briefing disable requested.',
          `- schedule retained: ${config.cron} (${config.timezone})`,
          `- apply state: ${status.reconcileState}`,
        ].join('\n');
      }

      if (subcommand === 'run') {
        const dateKey = await resolveDateKeyForOffset(api, 0);
        const result = await generateBriefing(api, dateKey);
        return [
          `Generated briefing for ${result.dateKey}.`,
          `- file: ${result.filePath}`,
          ...result.failures.map(failure => `- note: ${failure}`),
          ...formatDeliverySummary(result.delivery),
        ].join('\n');
      }

      if (subcommand === 'today' || subcommand === 'yesterday') {
        const targetDateKey = await resolveDateKeyForOffset(api, subcommand === 'today' ? 0 : -1);
        const briefing = await readBriefingByDateKey(api, targetDateKey);
        if (!briefing.exists || !briefing.markdown) {
          return `No saved briefing for ${briefing.dateKey}.`;
        }
        return options?.forAgent
          ? wrapBriefingMarkdownForAgent(briefing.markdown)
          : briefing.markdown;
      }

      const status = await getStatusSnapshot(api);
      return [
        'Morning Briefing status:',
        `- enabled: ${status.enabled ? 'yes' : 'no'}`,
        `- schedule: ${status.cron} (${status.timezone})`,
        `- cron job id: ${status.cronJobId ?? '(none)'}`,
        `- desired enabled: ${status.desiredEnabled ? 'yes' : 'no'}`,
        `- reconcile state: ${status.reconcileState}`,
        `- last generated: ${status.lastGeneratedDate ?? '(none)'}`,
        `- github: ${status.sourceReadiness.github.configured ? 'ready' : 'not ready'} (${status.sourceReadiness.github.summary})`,
        `- linear: ${status.sourceReadiness.linear.configured ? 'configured' : 'not configured'} (${status.sourceReadiness.linear.summary})`,
        `- web search: ${status.sourceReadiness.web.configured ? 'ready' : 'not ready'} (${status.sourceReadiness.web.summary})`,
      ].join('\n');
    };

    api.registerCommand({
      name: 'briefing',
      description: 'Manage and run KiloClaw Morning Briefings',
      acceptsArgs: true,
      handler: async ctx => {
        return {
          text: await runBriefingCommand(ctx.args ?? ''),
        };
      },
    });

    api.registerTool({
      name: 'morning_briefing_handle_command',
      label: 'Morning briefing /briefing command',
      description:
        'Deterministically handles /briefing commands from raw inbound text when slash routing fails.',
      parameters: Type.Object(
        {
          message: Type.String({
            description:
              'Raw inbound user text that may include wrapper metadata and a /briefing command.',
            minLength: 1,
          }),
        },
        { additionalProperties: false }
      ),
      async execute(_toolCallId, params) {
        const { message } = params as { message: string };
        const commandArgs = extractBriefingArgsFromText(message);
        if (commandArgs === null) {
          return {
            content: [
              {
                type: 'text',
                text: 'No /briefing command found in the provided message.',
              },
            ],
            details: undefined,
          };
        }

        const resultText = await runBriefingCommand(commandArgs, { forAgent: true });
        return {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
          details: undefined,
        };
      },
    });

    api.registerTool({
      name: 'morning_briefing_generate',
      label: 'Generate morning briefing',
      description:
        "Generate today's morning briefing from configured sources and persist it as Markdown.",
      parameters: Type.Object(
        {
          date: Type.Optional(
            Type.String({
              description: 'Optional local date key in YYYY-MM-DD format',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            })
          ),
        },
        { additionalProperties: false }
      ),
      async execute(_toolCallId, params) {
        const typed = params as { date?: string };
        const dateValue = typeof typed.date === 'string' ? typed.date : undefined;
        const targetDateKey = dateValue ?? (await resolveDateKeyForOffset(api, 0));
        const result = await generateBriefing(api, targetDateKey);
        return {
          content: [
            {
              type: 'text',
              text: [
                `Morning briefing generated for ${result.dateKey}.`,
                `Saved to ${result.filePath}.`,
                ...result.failures.map(failure => `Note: ${failure}`),
                ...formatDeliverySummary(result.delivery).map(line => line.replace(/^- /, '')),
                '',
                // Hand the agent the full briefing plus a fidelity rule so
                // an on-demand "run my briefing" chat reply reproduces
                // every section instead of paraphrasing the file (which
                // silently dropped sections like "Connect more" and
                // individual calendar lines). PR-6 replaces this with
                // structured multi-bubble injection.
                //
                // wrapBriefingMarkdownForAgent fences the body in an
                // untrusted-content tag so a malicious issue or event
                // title cannot hijack the agent. Shared with
                // morning_briefing_read so both paths carry the same guard.
                wrapBriefingMarkdownForAgent(result.markdown),
              ].join('\n'),
            },
          ],
          details: undefined,
        };
      },
    });

    api.registerTool({
      name: 'morning_briefing_read',
      label: 'Read morning briefing',
      description: 'Read a saved morning briefing Markdown file for a specific date.',
      parameters: Type.Object(
        {
          day: Type.Optional(
            Type.Union([
              Type.Literal('today'),
              Type.Literal('yesterday'),
              Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
            ])
          ),
        },
        { additionalProperties: false }
      ),
      async execute(_toolCallId, params) {
        const typed = params as { day?: string };
        const rawDay = typeof typed.day === 'string' ? typed.day : 'today';
        const dateKey =
          rawDay === 'yesterday'
            ? await resolveDateKeyForOffset(api, -1)
            : rawDay === 'today'
              ? await resolveDateKeyForOffset(api, 0)
              : rawDay;
        const briefing = await readBriefingByDateKey(api, dateKey);
        if (!briefing.exists || !briefing.markdown) {
          return {
            content: [
              {
                type: 'text',
                text: `No briefing exists for ${briefing.dateKey}.`,
              },
            ],
            details: undefined,
          };
        }
        return {
          content: [
            {
              type: 'text',
              // Same untrusted-content fence as morning_briefing_generate:
              // a saved briefing carries the same external titles, and the
              // agent reads this in response to "/briefing today".
              text: wrapBriefingMarkdownForAgent(briefing.markdown),
            },
          ],
          details: undefined,
        };
      },
    });

    api.registerHttpRoute({
      path: '/api/plugins/kiloclaw-morning-briefing/status',
      auth: 'gateway',
      match: 'exact',
      handler: async (_req, res) => {
        try {
          const snapshot = await getStatusSnapshot(api);
          sendJson(res, 200, {
            ok: true,
            ...snapshot,
          });
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });

    api.registerHttpRoute({
      path: '/api/plugins/kiloclaw-morning-briefing/enable',
      auth: 'gateway',
      match: 'exact',
      handler: async (req, res) => {
        try {
          const body = asObject(await readRequestBody(req));
          const cron = typeof body.cron === 'string' ? body.cron.trim() : undefined;
          const timezone = typeof body.timezone === 'string' ? body.timezone.trim() : undefined;
          const result = await enableFromInput({ cron, timezone });
          const status = await readStoredStatus(getStatePaths(api));
          sendJson(res, 200, {
            ok: true,
            enabled: result.enabled,
            cron: result.cron,
            timezone: result.timezone,
            cronJobId: result.cronJobId,
            reconcileState: status.reconcileState,
            message: 'Enable requested. Reconciliation is running in background.',
          });
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('Invalid timezone:')) {
            sendJson(res, 400, {
              ok: false,
              error: error.message,
            });
            return;
          }
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });

    api.registerHttpRoute({
      path: '/api/plugins/kiloclaw-morning-briefing/disable',
      auth: 'gateway',
      match: 'exact',
      handler: async (_req, res) => {
        try {
          const result = await disableFromCommand();
          const status = await readStoredStatus(getStatePaths(api));
          sendJson(res, 200, {
            ok: true,
            enabled: result.enabled,
            cron: result.cron,
            timezone: result.timezone,
            reconcileState: status.reconcileState,
            message: 'Disable requested. Reconciliation is running in background.',
          });
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });

    api.registerHttpRoute({
      path: '/api/plugins/kiloclaw-morning-briefing/interests',
      auth: 'gateway',
      match: 'exact',
      handler: async (req, res) => {
        try {
          const body = asObject(await readRequestBody(req));
          const rawTopics = Array.isArray(body.topics) ? body.topics : null;
          if (!rawTopics) {
            sendJson(res, 400, { ok: false, error: 'topics must be an array of strings' });
            return;
          }
          // Defense in depth — the worker validates first, but caps here
          // make sure a direct gateway call can't write a runaway payload.
          if (rawTopics.length > MAX_INTEREST_TOPICS) {
            sendJson(res, 400, {
              ok: false,
              error: `topics must not exceed ${MAX_INTEREST_TOPICS} items`,
            });
            return;
          }
          // Trim to match the worker's `z.string().trim().min(1)` Zod
          // shape — a direct authenticated gateway call that bypasses
          // Zod could otherwise write " Tech " and break case-insensitive
          // equality against the "Tech" preset on the UI side. Empty
          // (after trim) entries are silently skipped, matching Zod's
          // `.min(1)` rejection without surfacing an error for what's
          // effectively whitespace garbage.
          const topics: string[] = [];
          for (const value of rawTopics) {
            if (typeof value !== 'string') {
              sendJson(res, 400, { ok: false, error: 'topics must be an array of strings' });
              return;
            }
            const trimmed = value.trim();
            if (trimmed.length === 0) continue;
            if (trimmed.length > MAX_INTEREST_TOPIC_LENGTH) {
              sendJson(res, 400, {
                ok: false,
                error: `each topic must be ${MAX_INTEREST_TOPIC_LENGTH} characters or fewer`,
              });
              return;
            }
            topics.push(trimmed);
          }
          const result = await updateInterestsFromInput(topics);
          sendJson(res, 200, {
            ok: true,
            interestTopics: result.interestTopics,
          });
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });

    api.registerHttpRoute({
      path: '/api/plugins/kiloclaw-morning-briefing/user-location',
      auth: 'gateway',
      match: 'exact',
      handler: async (req, res) => {
        try {
          const body = asObject(await readRequestBody(req));
          // Three accepted shapes:
          //   - { userLocation: "Novato, CA" }  → set
          //   - { userLocation: null }          → clear
          //   - { userLocation: "" }            → clear (trim-empty)
          // Any other type (number, array, object) is rejected. Missing
          // field (`body.userLocation === undefined`, e.g. `{}` body or
          // malformed JSON that the controller fell back to an empty
          // object on) is ALSO rejected — otherwise a buggy caller
          // could silently erase the saved location by omitting the
          // field, since `undefined` was previously falling through to
          // the null-write path.
          if (!('userLocation' in body)) {
            sendJson(res, 400, {
              ok: false,
              error: 'userLocation field is required (use null to clear)',
            });
            return;
          }
          if (body.userLocation !== null && typeof body.userLocation !== 'string') {
            sendJson(res, 400, {
              ok: false,
              error: 'userLocation must be a string or null',
            });
            return;
          }
          // Cap length defensively. Worker enforces 200 via Zod
          // (`userLocationSchema`); we cap here so a direct authenticated
          // gateway call can't write a runaway string into config.json
          // and slow down brief-time query construction. Keep in sync
          // with `apps/web/src/routers/kiloclaw-router.ts`.
          const MAX_USER_LOCATION_LENGTH = 200;
          let next: string | null = null;
          if (typeof body.userLocation === 'string') {
            const trimmed = body.userLocation.trim();
            if (trimmed.length > MAX_USER_LOCATION_LENGTH) {
              sendJson(res, 400, {
                ok: false,
                error: `userLocation must be ${MAX_USER_LOCATION_LENGTH} characters or fewer`,
              });
              return;
            }
            next = trimmed.length > 0 ? trimmed : null;
          }
          const result = await updateUserLocationFromInput(next);
          sendJson(res, 200, {
            ok: true,
            userLocation: result.userLocation,
          });
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });

    api.registerHttpRoute({
      path: '/api/plugins/kiloclaw-morning-briefing/run',
      auth: 'gateway',
      match: 'exact',
      handler: async (_req, res) => {
        try {
          const dateKey = await resolveDateKeyForOffset(api, 0);
          const result = await generateBriefing(api, dateKey);
          sendJson(res, 200, {
            ok: true,
            date: result.dateKey,
            filePath: result.filePath,
            failures: result.failures,
            delivery: result.delivery,
          });
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });

    api.registerHttpRoute({
      path: '/api/plugins/kiloclaw-morning-briefing/read/today',
      auth: 'gateway',
      match: 'exact',
      handler: async (_req, res) => {
        try {
          const dateKey = await resolveDateKeyForOffset(api, 0);
          const result = await readBriefingByDateKey(api, dateKey);
          sendJson(res, 200, {
            ok: true,
            ...result,
          });
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });

    api.registerHttpRoute({
      path: '/api/plugins/kiloclaw-morning-briefing/read/yesterday',
      auth: 'gateway',
      match: 'exact',
      handler: async (_req, res) => {
        try {
          const dateKey = await resolveDateKeyForOffset(api, -1);
          const result = await readBriefingByDateKey(api, dateKey);
          sendJson(res, 200, {
            ok: true,
            ...result,
          });
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });

    api.on('before_prompt_build', () => ({
      appendSystemContext: [
        'Morning Briefing plugin is installed.',
        'Use /briefing enable|status|run|today|yesterday|disable for command-driven control.',
        'If inbound text contains /briefing but command routing did not execute, call morning_briefing_handle_command exactly once with the full raw inbound message.',
        'Never emulate /briefing by manually calling generic cron/file tools.',
        'When you present a morning briefing in chat, reproduce every section and every line of the briefing Markdown — including the "Connect more" section and all calendar entries. Light reformatting for readability is fine, but never drop, merge, or summarize away a section or line.',
      ].join('\n'),
    }));
  },
});
