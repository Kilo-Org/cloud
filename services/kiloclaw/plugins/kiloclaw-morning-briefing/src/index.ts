import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from '@sinclair/typebox';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { buildBriefingMarkdown, offsetDateKey, resolveBriefingPath } from './briefing-utils';
import {
  filterEnabledBriefingJobs,
  pickCanonicalCronJobId,
  selectMorningBriefingJobs,
} from './cron-utils';
import { extractBriefingArgsFromText } from './command-fallback-utils';
import { type EnableInput, isValidTimezone, parseEnableArgs } from './enable-input-utils';
import { normalizeLinearIssues, summarizeLinearCallFailure } from './linear-utils';
import { resolveNextReconcileAction } from './reconcile-queue-utils';
import { normalizeWebResults } from './web-utils';

const PLUGIN_ID = 'kiloclaw-morning-briefing';
const CRON_JOB_NAME = 'KiloClaw Morning Briefing';
const CRON_PROMPT =
  'Call the tool morning_briefing_generate exactly once with no arguments. Do not call any other tool.';
const DEFAULT_CRON = '0 7 * * *';
const DEFAULT_TIMEZONE = 'UTC';
const statusWriteQueueByPath = new Map<string, Promise<unknown>>();

type BriefingPluginConfig = {
  defaultCron?: string;
  defaultTimezone?: string;
};

type StoredConfig = {
  enabled: boolean;
  cronJobId: string | null;
  cron: string;
  timezone: string;
  updatedAt: string;
};

type StoredStatus = {
  lastGeneratedDate: string | null;
  lastGeneratedAt: string | null;
  lastPath: string | null;
  sourceSummary: Array<{ source: string; configured: boolean; ok: boolean; summary: string }>;
  failures: string[];
  observedEnabled: boolean | null;
  reconcileState: 'idle' | 'in_progress' | 'succeeded' | 'failed';
  lastReconcileAt: string | null;
  lastReconcileError: string | null;
  lastReconcileDurationMs: number | null;
  lastReconcileAction: 'enable' | 'disable' | null;
};

type SourceCollectionResult = {
  source: 'github' | 'linear' | 'web';
  configured: boolean;
  ok: boolean;
  summary: string;
  sectionLines: string[];
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

async function readRequestBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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

function sendJson(
  res: import('node:http').ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
): void {
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

async function runCommand(
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
  argv: string[],
  timeoutMs = 30_000
): Promise<{ stdout: string; stderr: string }> {
  const result = await api.runtime.system.runCommandWithTimeout(argv, {
    timeoutMs,
  });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || 'Command failed';
    throw new Error(`${argv.join(' ')} failed: ${message}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
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
  const jsonUnsupported = subcommand === 'disable';
  const command = jsonUnsupported
    ? ['openclaw', 'cron', ...argv]
    : ['openclaw', 'cron', ...argv, '--json'];
  const { stdout } = await runCommand(api, command, 60_000);
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
    logger: { warn?: (message: string) => void };
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
  api: { logger: { warn?: (message: string) => void } },
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
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    enabled: existing.enabled === true,
    cronJobId:
      typeof existing.cronJobId === 'string' && existing.cronJobId ? existing.cronJobId : null,
    cron: typeof existing.cron === 'string' && existing.cron ? existing.cron : defaults.cron,
    timezone:
      typeof existing.timezone === 'string' && existing.timezone
        ? existing.timezone
        : defaults.timezone,
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
    logger: { warn?: (message: string) => void };
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
    webSearch: {
      listProviders: (params?: { config?: unknown }) => Array<{ id?: string }>;
    };
  };
  config: unknown;
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

async function collectGithub(api: {
  runtime: {
    system: {
      runCommandWithTimeout: (
        argv: string[],
        options: { timeoutMs: number; cwd?: string }
      ) => Promise<{ stdout: string; stderr: string; code: number | null }>;
    };
  };
}): Promise<SourceCollectionResult> {
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
        'is:open sort:updated-desc',
        '--limit',
        '12',
        '--json',
        'title,url,updatedAt',
      ],
      20_000
    );
    const items = normalizeGithubIssues(JSON.parse(stdout));
    if (items.length === 0) {
      return {
        source: 'github',
        configured: true,
        ok: true,
        summary: 'No open issues found in accessible repositories',
        sectionLines: ['- No open issues found.'],
      };
    }
    const lines = items.slice(0, 8).map(item => {
      const updatedSuffix = item.updatedAt ? ` (updated ${item.updatedAt})` : '';
      return `- [${item.title}](${item.url})${updatedSuffix}`;
    });
    return {
      source: 'github',
      configured: true,
      ok: true,
      summary: `Fetched ${items.length} open GitHub issues`,
      sectionLines: lines,
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

async function collectWebSearch(api: {
  runtime: {
    webSearch: {
      listProviders: (params?: { config?: unknown }) => Array<{ id?: string }>;
      search: (params: { args: Record<string, unknown>; config?: unknown }) => Promise<{
        provider: string;
        result: Record<string, unknown>;
      }>;
    };
  };
  config: unknown;
}): Promise<SourceCollectionResult> {
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

  try {
    const response = await api.runtime.webSearch.search({
      config: api.config,
      args: {
        query:
          'top engineering updates and breaking software infrastructure news from the last 24 hours',
        count: 6,
      },
    });
    const results = normalizeWebResults(response.result);
    if (results.length === 0) {
      return {
        source: 'web',
        configured: true,
        ok: true,
        summary: 'Web search returned no results',
        sectionLines: ['- No web-search results returned.'],
      };
    }
    return {
      source: 'web',
      configured: true,
      ok: true,
      summary: `Fetched ${results.length} web results (${response.provider})`,
      sectionLines: results
        .slice(0, 6)
        .map(item =>
          item.summary.length > 0
            ? `- [${item.title}](${item.url}) - ${item.summary}`
            : `- [${item.title}](${item.url})`
        ),
    };
  } catch (error) {
    return {
      source: 'web',
      configured: true,
      ok: false,
      summary: `Web search failed: ${error instanceof Error ? error.message : String(error)}`,
      sectionLines: [],
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
      summary: 'No Linear issues matched the default query',
      sectionLines: ['- No Linear issues returned.'],
    };
  }

  return {
    source: 'linear',
    configured: true,
    ok: true,
    summary: `Fetched ${issues.length} Linear issues`,
    sectionLines: issues.map(issue => {
      const updatedSuffix = issue.updatedAt ? ` (updated ${issue.updatedAt})` : '';
      return `- [${issue.id}](${issue.url}) ${issue.title} - ${issue.status}${updatedSuffix}`;
    }),
  };
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
      webSearch: {
        listProviders: (params?: { config?: unknown }) => Array<{ id?: string }>;
        search: (params: { args: Record<string, unknown>; config?: unknown }) => Promise<{
          provider: string;
          result: Record<string, unknown>;
        }>;
      };
    };
    config: unknown;
  },
  dateKey: string
): Promise<{
  dateKey: string;
  filePath: string;
  markdown: string;
  sources: SourceCollectionResult[];
  failures: string[];
}> {
  const paths = getStatePaths(api);
  await ensureStorage(paths);

  const [github, linear, web] = await Promise.all([
    collectGithub(api),
    collectLinear(api),
    collectWebSearch(api),
  ]);
  const sources = [github, linear, web];
  const successes = sources.filter(source => source.ok);

  if (successes.length === 0) {
    throw new Error(
      'No usable briefing sources are available. Configure at least one of GitHub, Linear, or web search.'
    );
  }

  const failures = sources
    .filter(source => !source.ok)
    .map(source => `${source.source}: ${source.summary}`);
  const markdown = buildBriefingMarkdown({
    dateKey,
    generatedAt: new Date(),
    statuses: sources.map(source => ({
      source: source.source,
      configured: source.configured,
      ok: source.ok,
      summary: source.summary,
    })),
    sections: [
      { title: 'GitHub', lines: github.sectionLines },
      { title: 'Linear', lines: linear.sectionLines },
      { title: 'Web Search', lines: web.sectionLines },
    ],
    failures,
  });

  const filePath = resolveBriefingPath(paths.briefingsDir, dateKey);
  await fs.writeFile(filePath, markdown, 'utf8');

  await patchStoredStatus(paths, {
    lastGeneratedDate: dateKey,
    lastGeneratedAt: new Date().toISOString(),
    lastPath: filePath,
    sourceSummary: sources.map(source => ({
      source: source.source,
      configured: source.configured,
      ok: source.ok,
      summary: source.summary,
    })),
    failures,
  });

  return {
    dateKey,
    filePath,
    markdown,
    sources,
    failures,
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
    logger: { warn?: (message: string) => void };
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
    webSearch: {
      listProviders: (params?: { config?: unknown }) => Array<{ id?: string }>;
    };
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
  reconcileState: 'idle' | 'in_progress' | 'succeeded' | 'failed';
  lastReconcileAt: string | null;
  lastReconcileError: string | null;
  lastReconcileAction: 'enable' | 'disable' | null;
  desiredEnabled: boolean;
  observedEnabled: boolean | null;
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
    reconcileState: status.reconcileState,
    lastReconcileAt: status.lastReconcileAt,
    lastReconcileError: status.lastReconcileError,
    lastReconcileAction: status.lastReconcileAction,
    desiredEnabled: config.enabled,
    observedEnabled: status.observedEnabled,
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

      const current = await readStoredConfig(api, paths);
      const requestedTimezone = input.timezone?.trim();
      if (requestedTimezone && !isValidTimezone(requestedTimezone)) {
        throw new Error(`Invalid timezone: ${requestedTimezone}`);
      }
      const timezone = requestedTimezone
        ? requestedTimezone
        : resolveEffectiveTimezone(api, current.timezone, 'enable');
      const nextConfig: StoredConfig = {
        ...current,
        enabled: true,
        cron: input.cron?.trim() || current.cron,
        timezone,
        updatedAt: new Date().toISOString(),
      };

      await writeJsonFile(paths.configPath, nextConfig);
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
      const current = await readStoredConfig(api, paths);
      const nextConfig: StoredConfig = {
        ...current,
        enabled: false,
        updatedAt: new Date().toISOString(),
      };
      await writeJsonFile(paths.configPath, nextConfig);
      await patchStoredStatus(paths, {
        reconcileState: 'in_progress',
        lastReconcileError: null,
        lastReconcileAction: 'disable',
      });
      triggerReconcile('disable');
      return nextConfig;
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

    const runBriefingCommand = async (argsText: string) => {
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
        ].join('\n');
      }

      if (subcommand === 'today' || subcommand === 'yesterday') {
        const targetDateKey = await resolveDateKeyForOffset(api, subcommand === 'today' ? 0 : -1);
        const briefing = await readBriefingByDateKey(api, targetDateKey);
        if (!briefing.exists || !briefing.markdown) {
          return `No saved briefing for ${briefing.dateKey}.`;
        }
        return briefing.markdown;
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
        const commandArgs = extractBriefingArgsFromText(params.message);
        if (commandArgs === null) {
          return {
            content: [
              {
                type: 'text',
                text: 'No /briefing command found in the provided message.',
              },
            ],
          };
        }

        const resultText = await runBriefingCommand(commandArgs);
        return {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
        };
      },
    });

    api.registerTool({
      name: 'morning_briefing_generate',
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
        const dateValue = typeof params.date === 'string' ? params.date : undefined;
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
              ].join('\n'),
            },
          ],
        };
      },
    });

    api.registerTool({
      name: 'morning_briefing_read',
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
        const rawDay = typeof params.day === 'string' ? params.day : 'today';
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
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: briefing.markdown,
            },
          ],
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
      ].join('\n'),
    }));
  },
});
