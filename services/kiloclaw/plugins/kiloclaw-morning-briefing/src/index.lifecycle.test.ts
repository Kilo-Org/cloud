import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sinclair/typebox', () => ({
  Type: {
    Object: (value: unknown) => value,
    Optional: (value: unknown) => value,
    String: (value: unknown) => value,
    Union: (value: unknown) => value,
    Literal: (value: unknown) => value,
  },
}));

vi.mock('openclaw/plugin-sdk/plugin-entry', () => ({
  definePluginEntry: (entry: unknown) => entry,
}));

type CronJob = {
  id: string;
  name: string;
  enabled: boolean;
  updatedAtMs: number;
  createdAtMs: number;
  payload: {
    toolsAllow: string[];
  };
};

type TestHarness = {
  stateDir: string;
  commandHandler: (ctx: { args?: string }) => Promise<{ text: string }>;
  statusHttpHandler: (_req: unknown, res: FakeResponse) => Promise<void>;
  enableHttpHandler: (req: unknown, res: FakeResponse) => Promise<void>;
  interestsHttpHandler: (req: unknown, res: FakeResponse) => Promise<void>;
  userLocationHttpHandler: (req: unknown, res: FakeResponse) => Promise<void>;
  runHttpHandler: (_req: unknown, res: FakeResponse) => Promise<void>;
  cronJobs: CronJob[];
  sentMessages: Array<{
    channel: string;
    target: string;
    accountId?: string;
    message: string;
  }>;
  loggerInfo: ReturnType<typeof vi.fn>;
  loggerWarn: ReturnType<typeof vi.fn>;
  runCommandWithTimeout: ReturnType<typeof vi.fn>;
};

class FakeResponse {
  statusCode = 200;
  private headers = new Map<string, string>();
  body = '';

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  end(chunk?: string): void {
    this.body = chunk ?? '';
  }
}

function createJsonRequest(body: Record<string, unknown>): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      yield JSON.stringify(body);
    },
  };
}

async function createHarness(options?: {
  disableCommandFails?: boolean;
  preloadedConfig?: Record<string, unknown>;
  preloadedStatus?: Record<string, unknown>;
  githubAuthReady?: boolean;
  githubIssues?: Array<{ title: string; url: string; updatedAt?: string }>;
  /**
   * Stubs the diagnostic path that fires on empty issue results.
   * `login` populates the `gh api user` body; `oauthScopes` populates the
   * `X-OAuth-Scopes` header in that response; `accessibleRepoCount`
   * populates the `gh api user/repos --paginate --jq '. | length'` total.
   * Setting `GH_TOKEN` / `GITHUB_TOKEN` in `tokenEnv` controls
   * `classifyGithubToken` since the plugin reads from `process.env`.
   */
  githubDiagnostics?: {
    login?: string;
    oauthScopes?: string[];
    accessibleRepoCount?: number;
    userApiFails?: boolean;
    reposApiFails?: boolean;
  };
  tokenEnv?: { GH_TOKEN?: string; GITHUB_TOKEN?: string };
  /**
   * When set, populates `LINEAR_API_KEY` in the process env via
   * `vi.stubEnv` so `resolveLinearReady` returns configured. Cleared
   * automatically in `afterEach`.
   */
  linearApiKey?: string;
  /**
   * Payload returned by the mocked `mcporter call linear list_issues`
   * invocation. The harness wraps these in the `{issues, hasNextPage}`
   * envelope that the real Linear MCP server returns.
   */
  linearIssues?: Array<Record<string, unknown>>;
  /** When set, the mocked mcporter call fails with this stderr / non-zero exit. */
  linearMcpFailure?: { stdout?: string; stderr?: string };
  /**
   * Stubs `process.env.KILOCLAW_USER_LOCATION` and
   * `process.env.KILOCLAW_USER_TIMEZONE` via `vi.stubEnv` so
   * `resolveLocationContext` (in local-news-utils) returns the
   * matching shape. Cleared automatically in `afterEach`.
   */
  userLocationEnv?: { KILOCLAW_USER_LOCATION?: string; KILOCLAW_USER_TIMEZONE?: string };
  /**
   * Web-search runtime stub. `providers` populates `listProviders()`;
   * `resultsPerQuery` is a map from the issued query string to the
   * `{ provider, result }` envelope that `search()` returns. Queries
   * that don't match any key fall back to `defaultResult`.
   *
   * Local-news tier escalation issues distinct queries per tier, so
   * tests for the tier loop seed `resultsPerQuery` with all tiers
   * the test expects to fire. Unmatched queries surface as
   * `{ provider: 'none', result: { results: [] } }`.
   */
  webSearch?: {
    providers?: Array<{ id?: string }>;
    resultsPerQuery?: Record<
      string,
      { provider?: string; results?: Array<{ title: string; url: string; summary?: string }> }
    >;
    defaultResult?: { provider?: string; results?: Array<{ title: string; url: string }> };
    /** When set, every call to `search()` rejects with this error. */
    searchThrows?: Error;
  };
  channelsConfig?: Record<string, unknown>;
  messageSendFailures?: Partial<Record<'telegram' | 'discord' | 'slack', string>>;
  messageSendFailureCounts?: Partial<Record<'telegram' | 'discord' | 'slack', number>>;
  omitRuntimeChannelsConfig?: boolean;
  /**
   * When set, the cron `add` command awaits this promise before
   * proceeding. Used by the reconcile-vs-interests race test to hold
   * `ensureCronJob` inside reconcile so a concurrent interests write
   * can land while reconcile is mid-flight. Resolve the promise to let
   * reconcile finish.
   */
  cronAddBarrier?: Promise<void>;
}): Promise<TestHarness> {
  // `gatherGithubEmptyResultContext` reads from `process.env`. Use
  // vi.stubEnv so the value is scoped to the test and `vi.unstubAllEnvs`
  // in afterEach restores the original. Tests that don't set tokenEnv
  // get an explicit-unset to avoid leaking host env into the test.
  vi.stubEnv('GH_TOKEN', options?.tokenEnv?.GH_TOKEN ?? '');
  vi.stubEnv('GITHUB_TOKEN', options?.tokenEnv?.GITHUB_TOKEN ?? '');
  // Linear readiness reads `process.env.LINEAR_API_KEY` directly. Same
  // pattern; default cleared so the resolveLinearReady path doesn't
  // accidentally pick up the host env.
  vi.stubEnv('LINEAR_API_KEY', options?.linearApiKey ?? '');
  // Local-news location resolution reads two env vars (set in
  // `gateway/env.ts` at provision time). Stub them per-test for the
  // same reason — the host env must not leak in.
  vi.stubEnv('KILOCLAW_USER_LOCATION', options?.userLocationEnv?.KILOCLAW_USER_LOCATION ?? '');
  vi.stubEnv('KILOCLAW_USER_TIMEZONE', options?.userLocationEnv?.KILOCLAW_USER_TIMEZONE ?? '');

  const { default: morningBriefingPlugin } = await import('./index');
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morning-briefing-'));
  const pluginDir = path.join(stateDir, 'morning-briefing');
  await fs.mkdir(pluginDir, { recursive: true });

  if (options?.preloadedConfig) {
    await fs.writeFile(
      path.join(pluginDir, 'config.json'),
      JSON.stringify(options.preloadedConfig, null, 2),
      'utf8'
    );
  }
  if (options?.preloadedStatus) {
    await fs.writeFile(
      path.join(pluginDir, 'status.json'),
      JSON.stringify(options.preloadedStatus, null, 2),
      'utf8'
    );
  }

  let sequence = 0;
  const cronJobs: CronJob[] = [];
  const sentMessages: Array<{
    channel: string;
    target: string;
    accountId?: string;
    message: string;
  }> = [];
  const runCommandWithTimeout = vi.fn(async (argv: string[]) => {
    if (argv[0] === 'gh' && argv[1] === 'auth' && argv[2] === 'status') {
      if (options?.githubAuthReady) {
        return { stdout: '', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: 'not authenticated', code: 1 };
    }

    if (argv[0] === 'gh' && argv[1] === 'search' && argv[2] === 'issues') {
      return {
        stdout: JSON.stringify(options?.githubIssues ?? []),
        stderr: '',
        code: 0,
      };
    }

    if (argv[0] === 'gh' && argv[1] === 'api' && argv[2] === '-i' && argv[3] === 'user') {
      if (options?.githubDiagnostics?.userApiFails) {
        return { stdout: '', stderr: 'api error', code: 1 };
      }
      const login = options?.githubDiagnostics?.login ?? 'testuser';
      const scopesHeader =
        options?.githubDiagnostics?.oauthScopes !== undefined
          ? `X-OAuth-Scopes: ${options.githubDiagnostics.oauthScopes.join(', ')}\n`
          : '';
      const body = JSON.stringify({ login, id: 1 });
      const stdout = `HTTP/2.0 200 OK\nContent-Type: application/json\n${scopesHeader}\n${body}`;
      return { stdout, stderr: '', code: 0 };
    }

    if (
      argv[0] === 'gh' &&
      argv[1] === 'api' &&
      argv[2] === 'user/repos' &&
      argv.includes('--paginate')
    ) {
      if (options?.githubDiagnostics?.reposApiFails) {
        return { stdout: '', stderr: 'api error', code: 1 };
      }
      const count = options?.githubDiagnostics?.accessibleRepoCount ?? 0;
      return { stdout: `${count}\n`, stderr: '', code: 0 };
    }

    if (
      argv[0] === 'mcporter' &&
      argv[1] === 'call' &&
      argv[2] === 'linear' &&
      argv[3] === 'list_issues'
    ) {
      if (options?.linearMcpFailure) {
        return {
          stdout: options.linearMcpFailure.stdout ?? '',
          stderr: options.linearMcpFailure.stderr ?? 'mcporter failure',
          code: 1,
        };
      }
      return {
        stdout: JSON.stringify({
          issues: options?.linearIssues ?? [],
          hasNextPage: false,
        }),
        stderr: '',
        code: 0,
      };
    }

    if (
      argv[0] === 'openclaw' &&
      argv[1] === 'config' &&
      argv[2] === 'get' &&
      argv[3] === 'channels'
    ) {
      if (!options?.channelsConfig) {
        return {
          stdout: '',
          stderr: 'Config path not found: channels',
          code: 1,
        };
      }
      return {
        stdout: JSON.stringify(options.channelsConfig),
        stderr: '',
        code: 0,
      };
    }

    if (argv[0] === 'openclaw' && argv[1] === 'message' && argv[2] === 'send') {
      const channelIndex = argv.indexOf('--channel');
      const targetIndex = argv.indexOf('--target');
      const messageIndex = argv.indexOf('--message');
      const accountIndex = argv.indexOf('--account');
      const channel = channelIndex >= 0 ? (argv[channelIndex + 1] ?? '') : '';
      const target = targetIndex >= 0 ? (argv[targetIndex + 1] ?? '') : '';
      const message = messageIndex >= 0 ? (argv[messageIndex + 1] ?? '') : '';
      const accountId = accountIndex >= 0 ? argv[accountIndex + 1] : undefined;
      if (channel && target && message) {
        sentMessages.push({ channel, target, accountId, message });
      }
      const configuredFailure =
        channel === 'telegram' || channel === 'discord' || channel === 'slack'
          ? options?.messageSendFailures?.[channel]
          : undefined;
      const configuredFailureCount =
        channel === 'telegram' || channel === 'discord' || channel === 'slack'
          ? options?.messageSendFailureCounts?.[channel]
          : undefined;
      if (configuredFailure && configuredFailureCount && configuredFailureCount > 0) {
        if (!options?.messageSendFailureCounts) {
          return { stdout: '', stderr: configuredFailure, code: 1 };
        }
        options.messageSendFailureCounts[channel] = configuredFailureCount - 1;
        return { stdout: '', stderr: configuredFailure, code: 1 };
      }
      if (configuredFailure && configuredFailureCount === undefined) {
        return { stdout: '', stderr: configuredFailure, code: 1 };
      }
      return { stdout: JSON.stringify({ ok: true }), stderr: '', code: 0 };
    }

    if (argv[0] === 'openclaw' && argv[1] === 'cron') {
      const subcommand = argv[2];

      if (subcommand === 'list') {
        return {
          stdout: JSON.stringify({ jobs: cronJobs }),
          stderr: '',
          code: 0,
        };
      }

      if (subcommand === 'add') {
        // The race test holds reconcile here so a concurrent interests
        // handler can land on the config write queue while reconcile is
        // mid-flight inside `ensureCronJob`.
        if (options?.cronAddBarrier) {
          await options.cronAddBarrier;
        }
        const id = `job-${++sequence}`;
        const now = Date.now();
        cronJobs.push({
          id,
          name: 'KiloClaw Morning Briefing',
          enabled: true,
          updatedAtMs: now,
          createdAtMs: now,
          payload: { toolsAllow: ['morning_briefing_generate'] },
        });
        return { stdout: JSON.stringify({ id }), stderr: '', code: 0 };
      }

      if (subcommand === 'edit') {
        const id = argv[3] ?? '';
        const job = cronJobs.find(entry => entry.id === id);
        if (!job) {
          return { stdout: '', stderr: 'missing job', code: 1 };
        }
        job.updatedAtMs = Date.now();
        job.enabled = true;
        return { stdout: JSON.stringify({ id }), stderr: '', code: 0 };
      }

      if (subcommand === 'disable') {
        const id = argv[3] ?? '';
        if (options?.disableCommandFails) {
          return { stdout: '', stderr: 'disable failed', code: 1 };
        }
        const job = cronJobs.find(entry => entry.id === id);
        if (job) {
          job.enabled = false;
          job.updatedAtMs = Date.now();
        }
        return { stdout: '', stderr: '', code: 0 };
      }

      if (subcommand === 'remove') {
        const id = argv[3] ?? '';
        const index = cronJobs.findIndex(entry => entry.id === id);
        if (index >= 0) {
          cronJobs.splice(index, 1);
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: '', code: 0 };
      }
    }

    return { stdout: '', stderr: '', code: 0 };
  });

  let commandHandler: ((ctx: { args?: string }) => Promise<{ text: string }>) | null = null;
  let statusHttpHandler: ((_req: unknown, res: FakeResponse) => Promise<void>) | null = null;
  let enableHttpHandler: ((req: unknown, res: FakeResponse) => Promise<void>) | null = null;
  let interestsHttpHandler: ((req: unknown, res: FakeResponse) => Promise<void>) | null = null;
  let userLocationHttpHandler: ((req: unknown, res: FakeResponse) => Promise<void>) | null = null;
  let runHttpHandler: ((_req: unknown, res: FakeResponse) => Promise<void>) | null = null;
  const loggerInfo = vi.fn();
  const loggerWarn = vi.fn();

  morningBriefingPlugin.register({
    runtime: {
      state: { resolveStateDir: () => stateDir },
      system: { runCommandWithTimeout },
      webSearch: {
        listProviders: () => options?.webSearch?.providers ?? [],
        search: async (params: { args: Record<string, unknown> }) => {
          if (options?.webSearch?.searchThrows) {
            throw options.webSearch.searchThrows;
          }
          const query = typeof params.args?.query === 'string' ? params.args.query : '';
          const perQuery = options?.webSearch?.resultsPerQuery?.[query];
          if (perQuery) {
            return {
              provider: perQuery.provider ?? 'brave',
              result: { results: perQuery.results ?? [] },
            };
          }
          const fallback = options?.webSearch?.defaultResult;
          return {
            provider: fallback?.provider ?? 'none',
            result: { results: fallback?.results ?? [] },
          };
        },
      },
    },
    config: {
      agents: { defaults: { userTimezone: 'America/Chicago' } },
      ...(options?.omitRuntimeChannelsConfig ? {} : { channels: options?.channelsConfig ?? {} }),
    },
    logger: { info: loggerInfo, warn: loggerWarn },
    registerCommand: (def: { handler: (ctx: { args?: string }) => Promise<{ text: string }> }) => {
      commandHandler = def.handler;
    },
    registerHttpRoute: (route: {
      path: string;
      handler: (_req: unknown, res: FakeResponse) => Promise<void>;
    }) => {
      if (route.path.endsWith('/status')) {
        statusHttpHandler = route.handler;
      } else if (route.path.endsWith('/enable')) {
        enableHttpHandler = route.handler;
      } else if (route.path.endsWith('/interests')) {
        interestsHttpHandler = route.handler;
      } else if (route.path.endsWith('/user-location')) {
        userLocationHttpHandler = route.handler;
      } else if (route.path.endsWith('/run')) {
        runHttpHandler = route.handler;
      }
    },
    registerTool: vi.fn(),
    on: vi.fn(),
  } as never);

  if (
    !commandHandler ||
    !statusHttpHandler ||
    !enableHttpHandler ||
    !interestsHttpHandler ||
    !userLocationHttpHandler ||
    !runHttpHandler
  ) {
    throw new Error('Failed to register command or HTTP handlers');
  }

  return {
    stateDir,
    commandHandler,
    statusHttpHandler,
    enableHttpHandler,
    interestsHttpHandler,
    userLocationHttpHandler,
    runHttpHandler,
    cronJobs,
    sentMessages,
    loggerInfo,
    loggerWarn,
    runCommandWithTimeout,
  };
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
}

async function waitForReconcileState(
  stateDir: string,
  expectedState: 'succeeded' | 'failed',
  timeoutMs = 2000
): Promise<Record<string, unknown>> {
  const statusPath = path.join(stateDir, 'morning-briefing', 'status.json');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const status = await readJson(statusPath);
      if (status.reconcileState === expectedState) {
        return status;
      }
    } catch {
      // ignore until file exists
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for reconcileState=${expectedState}`);
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('morning briefing lifecycle', () => {
  it('enable command converges to enabled state via reconcile', async () => {
    const harness = await createHarness();

    const response = await harness.commandHandler({ args: 'enable' });
    expect(response.text).toContain('Morning Briefing enable requested.');

    const status = await waitForReconcileState(harness.stateDir, 'succeeded');
    const config = await readJson(path.join(harness.stateDir, 'morning-briefing', 'config.json'));

    expect(config.enabled).toBe(true);
    expect(config.cronJobId).toBeTypeOf('string');
    expect(status.observedEnabled).toBe(true);
    expect(status.lastReconcileAction).toBe('enable');
  });

  it('disable reconcile succeeds when only disabled jobs remain listed', async () => {
    const harness = await createHarness();

    await harness.commandHandler({ args: 'enable' });
    await waitForReconcileState(harness.stateDir, 'succeeded');

    const disableResponse = await harness.commandHandler({ args: 'disable' });
    expect(disableResponse.text).toContain('Morning Briefing disable requested.');

    const status = await waitForReconcileState(harness.stateDir, 'succeeded');
    const config = await readJson(path.join(harness.stateDir, 'morning-briefing', 'config.json'));

    expect(config.enabled).toBe(false);
    expect(status.observedEnabled).toBe(false);
    expect(status.lastReconcileAction).toBe('disable');
    expect(harness.cronJobs.length).toBeGreaterThan(0);
    expect(harness.cronJobs.every(job => job.enabled === false)).toBe(true);
  });

  it('startup reconcile resumes from persisted diverged state', async () => {
    const now = new Date().toISOString();
    const harness = await createHarness({
      preloadedConfig: {
        enabled: false,
        cronJobId: 'job-existing',
        cron: '0 7 * * *',
        timezone: 'America/Chicago',
        updatedAt: now,
      },
      preloadedStatus: {
        lastGeneratedDate: null,
        lastGeneratedAt: null,
        lastPath: null,
        sourceSummary: [],
        failures: [],
        observedEnabled: true,
        reconcileState: 'idle',
        lastReconcileAt: null,
        lastReconcileError: null,
        lastReconcileDurationMs: null,
        lastReconcileAction: null,
      },
    });

    harness.cronJobs.push({
      id: 'job-existing',
      name: 'KiloClaw Morning Briefing',
      enabled: true,
      updatedAtMs: Date.now(),
      createdAtMs: Date.now(),
      payload: { toolsAllow: ['morning_briefing_generate'] },
    });

    const status = await waitForReconcileState(harness.stateDir, 'succeeded');
    expect(status.observedEnabled).toBe(false);
    expect(status.lastReconcileAction).toBe('disable');
  });

  it('status payload exposes reconcile failure details', async () => {
    const harness = await createHarness({ disableCommandFails: true });

    await harness.commandHandler({ args: 'enable' });
    await waitForReconcileState(harness.stateDir, 'succeeded');

    await harness.commandHandler({ args: 'disable' });
    await waitForReconcileState(harness.stateDir, 'failed');

    const response = new FakeResponse();
    await harness.statusHttpHandler({}, response);

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body) as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.reconcileState).toBe('failed');
    expect(typeof payload.lastReconcileError).toBe('string');
  });

  it('uses configured timezone for /briefing today', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T16:30:00.000Z'));

    const now = new Date().toISOString();
    const harness = await createHarness({
      preloadedConfig: {
        enabled: false,
        cronJobId: null,
        cron: '0 7 * * *',
        timezone: 'Asia/Tokyo',
        updatedAt: now,
      },
    });

    const briefingsDir = path.join(harness.stateDir, 'morning-briefing', 'briefings');
    await fs.mkdir(briefingsDir, { recursive: true });
    await fs.writeFile(path.join(briefingsDir, '2026-04-24.md'), 'tokyo briefing', 'utf8');

    const response = await harness.commandHandler({ args: 'today' });
    expect(response.text).toBe('tokyo briefing');
  });

  it('rejects enable when timezone is invalid', async () => {
    const harness = await createHarness();

    await expect(
      harness.commandHandler({ args: 'enable 0 7 * * * America/Chcago' })
    ).rejects.toThrow('Invalid timezone: America/Chcago');
  });

  it('returns 400 for invalid timezone in enable HTTP route', async () => {
    const harness = await createHarness();
    const response = new FakeResponse();

    await harness.enableHttpHandler(
      createJsonRequest({ cron: '0 7 * * *', timezone: 'America/Chcago' }),
      response
    );

    expect(response.statusCode).toBe(400);
    const payload = JSON.parse(response.body) as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('Invalid timezone: America/Chcago');
  });

  it('falls back to UTC date key when persisted timezone is invalid', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T00:30:00.000Z'));

    const now = new Date().toISOString();
    const harness = await createHarness({
      preloadedConfig: {
        enabled: false,
        cronJobId: null,
        cron: '0 7 * * *',
        timezone: 'America/Chcago',
        updatedAt: now,
      },
    });

    const briefingsDir = path.join(harness.stateDir, 'morning-briefing', 'briefings');
    await fs.mkdir(briefingsDir, { recursive: true });
    await fs.writeFile(path.join(briefingsDir, '2026-04-23.md'), 'utc fallback briefing', 'utf8');

    const response = await harness.commandHandler({ args: 'today' });
    expect(response.text).toBe('utc fallback briefing');
  });

  it('normalizes invalid persisted timezone on enable without override', async () => {
    const now = new Date().toISOString();
    const harness = await createHarness({
      preloadedConfig: {
        enabled: false,
        cronJobId: null,
        cron: '0 7 * * *',
        timezone: 'America/Chcago',
        updatedAt: now,
      },
    });

    const response = await harness.commandHandler({ args: 'enable' });
    expect(response.text).toContain('- timezone: UTC');

    await waitForReconcileState(harness.stateDir, 'succeeded');
    const config = await readJson(path.join(harness.stateDir, 'morning-briefing', 'config.json'));
    expect(config.timezone).toBe('UTC');
  });

  it('normalizes invalid persisted timezone during startup reconcile', async () => {
    const now = new Date().toISOString();
    const harness = await createHarness({
      preloadedConfig: {
        enabled: true,
        cronJobId: null,
        cron: '0 7 * * *',
        timezone: 'America/Chcago',
        updatedAt: now,
      },
    });

    await waitForReconcileState(harness.stateDir, 'succeeded');
    const config = await readJson(path.join(harness.stateDir, 'morning-briefing', 'config.json'));
    expect(config.timezone).toBe('UTC');
  });

  it('sends adapted briefing message to configured channel targets and persists delivery metadata', async () => {
    const harness = await createHarness({
      githubAuthReady: true,
      githubIssues: [
        {
          title: 'Fix failing deploy workflow',
          url: 'https://github.com/Kilo-Org/cloud/issues/123',
          updatedAt: '2026-04-24T10:00:00Z',
        },
      ],
      channelsConfig: {
        telegram: {
          enabled: true,
          defaultTo: '-100123456',
        },
        discord: {
          enabled: true,
          accounts: {
            default: {
              defaultTo: 'channel:1234567890',
            },
          },
        },
      },
    });

    const response = new FakeResponse();
    await harness.runHttpHandler({}, response);
    expect(response.statusCode).toBe(200);

    const payload = JSON.parse(response.body) as {
      ok: boolean;
      delivery?: Array<{ channel: string; status: string; target?: string; accountId?: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.delivery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'telegram', status: 'sent', target: '-100123456' }),
        expect.objectContaining({
          channel: 'discord',
          status: 'sent',
          target: 'channel:1234567890',
          accountId: 'default',
        }),
      ])
    );

    expect(harness.sentMessages).toHaveLength(2);
    for (const sent of harness.sentMessages) {
      expect(sent.message).toContain('Morning Briefing -');
      expect(sent.message).toContain('GitHub');
      expect(sent.message).toContain('• ');
      expect(sent.message).not.toContain('# ');
      expect(sent.message).toContain('https://github.com/Kilo-Org/cloud/issues/123');
      expect(sent.message).not.toContain('Repository:');
    }

    const statusPayload = new FakeResponse();
    await harness.statusHttpHandler({}, statusPayload);
    const statusBody = JSON.parse(statusPayload.body) as {
      ok: boolean;
      lastDelivery?: Array<{ channel: string; status: string }>;
    };
    expect(statusBody.ok).toBe(true);
    expect(statusBody.lastDelivery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'telegram', status: 'sent' }),
        expect.objectContaining({ channel: 'discord', status: 'sent' }),
      ])
    );
  });

  it('marks missing default targets as skipped and send errors as failed without failing run', async () => {
    const harness = await createHarness({
      githubAuthReady: true,
      githubIssues: [
        {
          title: 'Investigate queue latency',
          url: 'https://github.com/Kilo-Org/cloud/issues/456',
          updatedAt: '2026-04-24T12:00:00Z',
        },
      ],
      channelsConfig: {
        telegram: {
          enabled: true,
        },
        slack: {
          enabled: true,
          defaultTo: 'channel:C123',
        },
      },
      messageSendFailures: {
        slack: 'slack send failed',
      },
    });

    const response = new FakeResponse();
    await harness.runHttpHandler({}, response);
    expect(response.statusCode).toBe(200);

    const payload = JSON.parse(response.body) as {
      ok: boolean;
      delivery?: Array<{ channel: string; status: string; reason?: string; error?: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.delivery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'telegram',
          status: 'skipped',
          reason: 'missing_target',
        }),
        expect.objectContaining({
          channel: 'slack',
          status: 'failed',
          reason: 'send_failed',
        }),
      ])
    );
    const slackFailure = payload.delivery?.find(entry => entry.channel === 'slack');
    expect(slackFailure?.error).toBe('slack send failed');
  });

  it('uses single configured telegram group as fallback target when defaultTo is missing', async () => {
    const harness = await createHarness({
      githubAuthReady: true,
      githubIssues: [
        {
          title: 'Review release checklist',
          url: 'https://github.com/Kilo-Org/cloud/issues/789',
          updatedAt: '2026-04-24T13:00:00Z',
        },
      ],
      channelsConfig: {
        telegram: {
          enabled: true,
          groups: {
            '-5055658641': {
              requireMention: false,
            },
          },
        },
      },
    });

    const response = new FakeResponse();
    await harness.runHttpHandler({}, response);
    expect(response.statusCode).toBe(200);

    const payload = JSON.parse(response.body) as {
      ok: boolean;
      delivery?: Array<{ channel: string; status: string; target?: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.delivery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'telegram',
          status: 'sent',
          target: '-5055658641',
        }),
      ])
    );
  });

  it('skips with ambiguous_target when multiple fallback destinations are available', async () => {
    const harness = await createHarness({
      githubAuthReady: true,
      githubIssues: [
        {
          title: 'Investigate flaky integration test',
          url: 'https://github.com/Kilo-Org/cloud/issues/790',
          updatedAt: '2026-04-24T14:00:00Z',
        },
      ],
      channelsConfig: {
        telegram: {
          enabled: true,
          groups: {
            '-5055658641': {
              requireMention: false,
            },
            '-5055658642': {
              requireMention: false,
            },
          },
        },
      },
    });

    const response = new FakeResponse();
    await harness.runHttpHandler({}, response);
    expect(response.statusCode).toBe(200);

    const payload = JSON.parse(response.body) as {
      ok: boolean;
      delivery?: Array<{ channel: string; status: string; reason?: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.delivery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'telegram',
          status: 'skipped',
          reason: 'ambiguous_target',
        }),
      ])
    );
    expect(harness.sentMessages).toHaveLength(0);
  });

  it('uses runtime config channels for delivery without shelling out', async () => {
    const harness = await createHarness({
      githubAuthReady: true,
      githubIssues: [
        {
          title: 'Confirm runtime config path',
          url: 'https://github.com/Kilo-Org/cloud/issues/800',
          updatedAt: '2026-04-24T15:00:00Z',
        },
      ],
      channelsConfig: {
        telegram: {
          enabled: true,
          groups: {
            '-5055658641': {
              requireMention: false,
            },
          },
        },
      },
    });

    const response = new FakeResponse();
    await harness.runHttpHandler({}, response);
    expect(response.statusCode).toBe(200);

    const payload = JSON.parse(response.body) as {
      ok: boolean;
      delivery?: Array<{ channel: string; status: string; target?: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.delivery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'telegram', status: 'sent', target: '-5055658641' }),
      ])
    );
    expect(
      harness.runCommandWithTimeout.mock.calls.some(
        call =>
          Array.isArray(call[0]) &&
          call[0][0] === 'openclaw' &&
          call[0][1] === 'config' &&
          call[0][2] === 'get' &&
          call[0][3] === 'channels'
      )
    ).toBe(false);
  });

  it('falls back to CLI channel config when runtime channels are unavailable', async () => {
    const harness = await createHarness({
      githubAuthReady: true,
      githubIssues: [
        {
          title: 'Confirm CLI fallback path',
          url: 'https://github.com/Kilo-Org/cloud/issues/801',
          updatedAt: '2026-04-24T15:10:00Z',
        },
      ],
      channelsConfig: {
        telegram: {
          enabled: true,
          groups: {
            '-5055658641': {
              requireMention: false,
            },
          },
        },
      },
      omitRuntimeChannelsConfig: true,
    });

    const response = new FakeResponse();
    await harness.runHttpHandler({}, response);
    expect(response.statusCode).toBe(200);

    const payload = JSON.parse(response.body) as {
      ok: boolean;
      delivery?: Array<{ channel: string; status: string; target?: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.delivery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'telegram', status: 'sent', target: '-5055658641' }),
      ])
    );
    expect(
      harness.runCommandWithTimeout.mock.calls.some(
        call =>
          Array.isArray(call[0]) &&
          call[0][0] === 'openclaw' &&
          call[0][1] === 'config' &&
          call[0][2] === 'get' &&
          call[0][3] === 'channels'
      )
    ).toBe(true);
  });

  it('retries timed-out delivery once before marking send_failed', async () => {
    const harness = await createHarness({
      githubAuthReady: true,
      githubIssues: [
        {
          title: 'Retry flaky channel send',
          url: 'https://github.com/Kilo-Org/cloud/issues/900',
          updatedAt: '2026-04-25T00:00:00Z',
        },
      ],
      channelsConfig: {
        telegram: {
          enabled: true,
          defaultTo: '-5055658641',
        },
      },
      messageSendFailures: {
        telegram: 'The operation was aborted due to timeout',
      },
      messageSendFailureCounts: {
        telegram: 1,
      },
    });

    const response = new FakeResponse();
    await harness.runHttpHandler({}, response);
    expect(response.statusCode).toBe(200);

    const payload = JSON.parse(response.body) as {
      ok: boolean;
      delivery?: Array<{ channel: string; status: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.delivery).toEqual(
      expect.arrayContaining([expect.objectContaining({ channel: 'telegram', status: 'sent' })])
    );

    const sendCalls = harness.runCommandWithTimeout.mock.calls.filter(
      call =>
        Array.isArray(call[0]) &&
        call[0][0] === 'openclaw' &&
        call[0][1] === 'message' &&
        call[0][2] === 'send'
    );
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0]?.[1]).toMatchObject({ timeoutMs: 120_000 });
    expect(sendCalls[1]?.[1]).toMatchObject({ timeoutMs: 120_000 });
  });

  it('emits delivery outcome metric logs for sent/skipped/failed results', async () => {
    const harness = await createHarness({
      githubAuthReady: true,
      githubIssues: [
        {
          title: 'Delivery observability smoke check',
          url: 'https://github.com/Kilo-Org/cloud/issues/910',
          updatedAt: '2026-04-25T00:10:00Z',
        },
      ],
      channelsConfig: {
        telegram: {
          enabled: true,
          defaultTo: '-5055658641',
        },
        discord: {
          enabled: true,
        },
        slack: {
          enabled: true,
          defaultTo: 'channel:C123',
        },
      },
      messageSendFailures: {
        slack: 'slack send failed',
      },
    });

    const response = new FakeResponse();
    await harness.runHttpHandler({}, response);
    expect(response.statusCode).toBe(200);

    const infoMessages = harness.loggerInfo.mock.calls.map(call => String(call[0]));
    expect(
      infoMessages.some(message =>
        message.includes('event=morning_briefing_delivery_outcome outcome=sent channel=telegram')
      )
    ).toBe(true);
    expect(
      infoMessages.some(message =>
        message.includes('event=morning_briefing_delivery_outcome outcome=skipped channel=discord')
      )
    ).toBe(true);
    expect(
      infoMessages.some(message =>
        message.includes('event=morning_briefing_delivery_outcome outcome=failed channel=slack')
      )
    ).toBe(true);

    const warnMessages = harness.loggerWarn.mock.calls.map(call => String(call[0]));
    expect(
      warnMessages.some(message =>
        message.includes(
          'event=morning_briefing_delivery_failure channel=slack detail=slack send failed'
        )
      )
    ).toBe(true);
  });

  describe('github source diagnostics on empty results', () => {
    async function readGithubStatusSummary(stateDir: string): Promise<string | undefined> {
      const status = (await readJson(path.join(stateDir, 'morning-briefing', 'status.json'))) as {
        sourceSummary?: Array<{ source: string; summary: string }>;
      };
      return status.sourceSummary?.find(s => s.source === 'github')?.summary;
    }

    const telegramOnly = { telegram: { enabled: true, defaultTo: '-100123456' } };

    it('renders fine-grained PAT empty-result copy with accessible repo count', async () => {
      const harness = await createHarness({
        githubAuthReady: true,
        githubIssues: [],
        tokenEnv: { GITHUB_TOKEN: 'github_pat_11ABC_xxxxx' },
        githubDiagnostics: {
          login: 'astormsocbot',
          accessibleRepoCount: 3,
        },
        channelsConfig: telegramOnly,
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const sent = harness.sentMessages[0]?.message ?? '';
      expect(sent).toContain('No open issues involving you were found');
      expect(sent).toContain('astormsocbot');
      expect(sent).toContain('fine-grained PAT');
      expect(sent).toContain('3 repositories');
      expect(sent).toContain('switch to a classic PAT');

      expect(await readGithubStatusSummary(harness.stateDir)).toBe(
        '0 issues — fine-grained PAT for astormsocbot sees 3 repos'
      );
    });

    it('renders classic PAT empty-result with missing scope when repo not granted', async () => {
      const harness = await createHarness({
        githubAuthReady: true,
        githubIssues: [],
        tokenEnv: { GITHUB_TOKEN: 'ghp_xxxxxxxx' },
        githubDiagnostics: {
          login: 'astormsocbot',
          oauthScopes: ['public_repo', 'read:user'],
        },
        channelsConfig: telegramOnly,
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const sent = harness.sentMessages[0]?.message ?? '';
      expect(sent).toContain('classic PAT');
      expect(sent).toContain('Granted scopes: public_repo, read:user');
      expect(sent).toContain('Missing scopes useful for KiloClaw: repo');
      expect(sent).toContain('gh auth refresh -h github.com');

      expect(await readGithubStatusSummary(harness.stateDir)).toBe(
        '0 issues — classic PAT missing scopes: repo'
      );
    });

    it('renders classic PAT happy-path empty copy when all scopes are present', async () => {
      const harness = await createHarness({
        githubAuthReady: true,
        githubIssues: [],
        tokenEnv: { GITHUB_TOKEN: 'ghp_xxxxxxxx' },
        githubDiagnostics: {
          login: 'astormsocbot',
          oauthScopes: ['repo', 'read:org'],
        },
        channelsConfig: telegramOnly,
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const sent = harness.sentMessages[0]?.message ?? '';
      expect(sent).toContain('classic PAT');
      expect(sent).toContain('Token has the scopes the brief needs');
      expect(sent).not.toContain('Missing scopes');
      expect(sent).not.toContain('gh auth refresh');

      expect(await readGithubStatusSummary(harness.stateDir)).toBe(
        '0 issues involving astormsocbot'
      );
    });

    it('falls back to unknown-token copy when diagnostics fail to resolve a token type', async () => {
      const harness = await createHarness({
        githubAuthReady: true,
        githubIssues: [],
        // No tokenEnv -> readGithubTokenFromEnv returns undefined ->
        // classify returns 'unknown'.
        githubDiagnostics: {
          login: 'astormsocbot',
        },
        channelsConfig: telegramOnly,
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const sent = harness.sentMessages[0]?.message ?? '';
      expect(sent).toContain('unknown token');
      expect(sent).toContain('Could not determine accessible repositories or scopes');
    });

    it('issues the scoped flag-form gh search query (involves @me, sort updated desc)', async () => {
      const harness = await createHarness({
        githubAuthReady: true,
        githubIssues: [
          {
            title: 'Issue 1',
            url: 'https://github.com/foo/bar/issues/1',
            updatedAt: '2026-05-14T00:00:00Z',
          },
        ],
        tokenEnv: { GITHUB_TOKEN: 'ghp_xxxxxxxx' },
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const searchCall = harness.runCommandWithTimeout.mock.calls.find(
        ([argv]) => Array.isArray(argv) && argv[0] === 'gh' && argv[1] === 'search'
      );
      expect(searchCall).toBeDefined();
      const argv = searchCall?.[0] as string[];
      expect(argv).toContain('--involves');
      expect(argv).toContain('@me');
      expect(argv).toContain('--state');
      expect(argv).toContain('open');
      expect(argv).toContain('--sort');
      expect(argv).toContain('updated');
      expect(argv).toContain('--order');
      expect(argv).toContain('desc');
      expect(argv).not.toContain('is:open sort:updated-desc');
    });
  });

  describe('linear source', () => {
    async function readGithubAndLinearStatus(
      stateDir: string
    ): Promise<Array<{ source: string; summary: string }>> {
      const status = (await readJson(path.join(stateDir, 'morning-briefing', 'status.json'))) as {
        sourceSummary?: Array<{ source: string; summary: string }>;
      };
      return status.sourceSummary ?? [];
    }

    const telegramOnly = { telegram: { enabled: true, defaultTo: '-100123456' } };

    it('queries with assignee:me + limit:8 + orderBy:updatedAt and uses the correct workspace cwd', async () => {
      const harness = await createHarness({
        linearApiKey: 'lin_api_abc',
        linearIssues: [],
        channelsConfig: telegramOnly,
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const linearCall = harness.runCommandWithTimeout.mock.calls.find(
        ([argv]) => Array.isArray(argv) && argv[0] === 'mcporter' && argv[3] === 'list_issues'
      );
      expect(linearCall).toBeDefined();
      const [argv, opts] = linearCall as [string[], { cwd?: string }];
      expect(argv).toContain('assignee:me');
      expect(argv).toContain('limit:8');
      expect(argv).toContain('orderBy:updatedAt');
      expect(argv).toEqual(expect.arrayContaining(['mcporter', 'call', 'linear', 'list_issues']));
      expect(opts.cwd).toMatch(/workspace$/);
    });

    it('renders empty-result diagnostic when assignee:me returns no issues', async () => {
      const harness = await createHarness({
        linearApiKey: 'lin_api_abc',
        linearIssues: [],
        channelsConfig: telegramOnly,
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const sent = harness.sentMessages[0]?.message ?? '';
      expect(sent).toContain('No issues assigned to you in Linear');
      expect(sent).toContain('mcporter call linear list_issues assignee:me');

      const summaries = await readGithubAndLinearStatus(harness.stateDir);
      const linearSummary = summaries.find(s => s.source === 'linear');
      expect(linearSummary?.summary).toBe('0 issues assigned to you in Linear');
    });

    it('renders priority + labels + due date in the issue line, hiding Low when high-signal exists', async () => {
      const harness = await createHarness({
        linearApiKey: 'lin_api_abc',
        linearIssues: [
          {
            id: 'KIL-8',
            title: 'My test issue',
            status: 'Todo',
            url: 'https://linear.app/x/issue/KIL-8',
            updatedAt: '2026-05-14T23:13:00.450Z',
            priority: { value: 1, name: 'Urgent' },
            labels: ['Bug'],
            dueDate: '2026-05-15',
          },
          {
            id: 'KIL-7',
            title: 'Add Discord button',
            status: 'Todo',
            url: 'https://linear.app/x/issue/KIL-7',
            updatedAt: '2026-05-12',
            priority: { value: 4, name: 'Low' },
            labels: [],
          },
        ],
        channelsConfig: telegramOnly,
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const sent = harness.sentMessages[0]?.message ?? '';
      // KIL-8 has Urgent + Bug + due date — all surfaced.
      expect(sent).toContain('KIL-8');
      expect(sent).toContain('Urgent, Bug');
      expect(sent).toContain('due 2026-05-15');
      // KIL-7 has Low priority — hidden because KIL-8 carries high signal.
      expect(sent).toContain('KIL-7');
      expect(sent).toContain('Add Discord button');
      expect(sent).not.toContain('Low');

      const summaries = await readGithubAndLinearStatus(harness.stateDir);
      const linearSummary = summaries.find(s => s.source === 'linear');
      expect(linearSummary?.summary).toBe('Fetched 2 Linear issues assigned to you');
    });

    it('shows Low / None priority badges when nothing in the brief is high-signal', async () => {
      const harness = await createHarness({
        linearApiKey: 'lin_api_abc',
        linearIssues: [
          {
            id: 'KIL-1',
            title: 'Lower priority task',
            status: 'Todo',
            url: 'https://linear.app/x/issue/KIL-1',
            updatedAt: '2026-05-12',
            priority: { value: 4, name: 'Low' },
            labels: [],
          },
          {
            id: 'KIL-2',
            title: 'No priority set',
            status: 'Todo',
            url: 'https://linear.app/x/issue/KIL-2',
            updatedAt: '2026-05-11',
            priority: { value: 0, name: 'None' },
            labels: ['Backend'],
          },
        ],
        channelsConfig: telegramOnly,
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const sent = harness.sentMessages[0]?.message ?? '';
      // When the whole brief is Low / None, surface those badges so the
      // reader knows priority is set, not just absent.
      expect(sent).toContain('Low');
      expect(sent).toContain('None');
      expect(sent).toContain('Backend');
    });

    it('treats mcporter failure as an error source without breaking the brief', async () => {
      const harness = await createHarness({
        linearApiKey: 'lin_api_abc',
        linearMcpFailure: {
          stdout: JSON.stringify({
            server: 'linear',
            tool: 'list_issues',
            error: 'SSE error: Non-200 status code (401)',
            issue: { kind: 'auth', statusCode: 401 },
          }),
        },
        githubAuthReady: true,
        githubIssues: [
          {
            title: 'GH issue',
            url: 'https://github.com/x/y/issues/1',
            updatedAt: '2026-05-12',
          },
        ],
        channelsConfig: telegramOnly,
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const summaries = await readGithubAndLinearStatus(harness.stateDir);
      const linearSummary = summaries.find(s => s.source === 'linear');
      expect(linearSummary?.summary).toBe(
        'Linear authentication failed (check LINEAR_API_KEY and redeploy)'
      );
    });
  });

  describe('local news source', () => {
    const telegramOnly = { telegram: { enabled: true, defaultTo: '-100123456' } };

    async function readAllSourceStatus(
      stateDir: string
    ): Promise<Array<{ source: string; summary: string; configured: boolean; ok: boolean }>> {
      const status = (await readJson(path.join(stateDir, 'morning-briefing', 'status.json'))) as {
        sourceSummary?: Array<{
          source: string;
          summary: string;
          configured: boolean;
          ok: boolean;
        }>;
      };
      return status.sourceSummary ?? [];
    }

    function preloadInterestsConfig(topics: string[]): Record<string, unknown> {
      return {
        enabled: true,
        cronJobId: null,
        cron: '0 7 * * *',
        timezone: 'UTC',
        interestTopics: topics,
        updatedAt: new Date().toISOString(),
      };
    }

    it('omits the local-news source entirely when "Local News" is not in interests', async () => {
      const harness = await createHarness({
        preloadedConfig: preloadInterestsConfig(['Tech', 'AI']),
        userLocationEnv: { KILOCLAW_USER_LOCATION: 'San Francisco, CA' },
        // Need at least one configured source so the brief doesn't
        // throw "no usable sources". Web search with an empty default
        // counts as configured+ok.
        webSearch: { providers: [{ id: 'brave' }] },
        channelsConfig: telegramOnly,
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const summaries = await readAllSourceStatus(harness.stateDir);
      expect(summaries.find(s => s.source === 'local-news')).toBeUndefined();

      const sent = harness.sentMessages[0]?.message ?? '';
      expect(sent).not.toContain('Local News');
    });

    it('renders a "set a location" message when interest is selected but no env vars are set', async () => {
      const harness = await createHarness({
        preloadedConfig: preloadInterestsConfig(['Local News']),
        // No userLocationEnv → both KILOCLAW_USER_LOCATION and
        // KILOCLAW_USER_TIMEZONE are empty.
        webSearch: {
          providers: [{ id: 'brave' }],
        },
        channelsConfig: telegramOnly,
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const sent = harness.sentMessages[0]?.message ?? '';
      expect(sent).toContain('Local News');
      expect(sent).toContain('Set a location in Settings');

      const summaries = await readAllSourceStatus(harness.stateDir);
      const localNewsSummary = summaries.find(s => s.source === 'local-news');
      expect(localNewsSummary).toBeDefined();
      expect(localNewsSummary?.configured).toBe(false);
      expect(localNewsSummary?.summary).toContain('No location');
    });

    it('renders explicit-location section with results when tier 1 returns ≥ 3 unique items', async () => {
      const harness = await createHarness({
        preloadedConfig: preloadInterestsConfig(['Local News']),
        userLocationEnv: { KILOCLAW_USER_LOCATION: 'San Francisco, CA' },
        webSearch: {
          providers: [{ id: 'brave' }],
          resultsPerQuery: {
            'local news in San Francisco, CA within 100 miles from the last 24 hours': {
              provider: 'brave',
              results: [
                { title: 'SF article 1', url: 'https://sfchronicle.com/1' },
                { title: 'SF article 2', url: 'https://sfchronicle.com/2' },
                { title: 'SF article 3', url: 'https://sfchronicle.com/3' },
              ],
            },
          },
        },
        channelsConfig: telegramOnly,
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const sent = harness.sentMessages[0]?.message ?? '';
      expect(sent).toContain('Local News (San Francisco, CA)');
      expect(sent).toContain('SF article 1');
      expect(sent).toContain('SF article 2');
      expect(sent).toContain('SF article 3');

      const summaries = await readAllSourceStatus(harness.stateDir);
      const localNewsSummary = summaries.find(s => s.source === 'local-news');
      expect(localNewsSummary?.ok).toBe(true);
      expect(localNewsSummary?.summary).toContain('3 local news');
      expect(localNewsSummary?.summary).toContain('1 tier');
    });

    it('escalates through tiers until it accumulates 3 unique items', async () => {
      const harness = await createHarness({
        preloadedConfig: preloadInterestsConfig(['Local News']),
        userLocationEnv: { KILOCLAW_USER_LOCATION: 'San Francisco, CA' },
        webSearch: {
          providers: [{ id: 'brave' }],
          resultsPerQuery: {
            'local news in San Francisco, CA within 100 miles from the last 24 hours': {
              provider: 'brave',
              results: [{ title: 'Hyperlocal 1', url: 'https://a.com/1' }],
            },
            'local news in San Francisco, CA within 250 miles from the last 3 days': {
              provider: 'brave',
              results: [
                { title: 'Hyperlocal 1', url: 'https://a.com/1' }, // dup, should be deduped
                { title: 'Regional 1', url: 'https://b.com/1' },
              ],
            },
            'local news in San Francisco, CA from the last 7 days': {
              provider: 'brave',
              results: [
                { title: 'Last week 1', url: 'https://c.com/1' },
                { title: 'Last week 2', url: 'https://c.com/2' },
              ],
            },
          },
        },
        channelsConfig: telegramOnly,
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const sent = harness.sentMessages[0]?.message ?? '';
      expect(sent).toContain('Hyperlocal 1');
      expect(sent).toContain('Regional 1');
      expect(sent).toContain('Last week 1');

      const summaries = await readAllSourceStatus(harness.stateDir);
      const localNewsSummary = summaries.find(s => s.source === 'local-news');
      expect(localNewsSummary?.ok).toBe(true);
      // After 3 tiers, accumulated count is 4 (1 from tier 1, 1 from
      // tier 2 after dedupe, 2 from tier 3). Min items is 3, so loop
      // bails after tier 3.
      expect(localNewsSummary?.summary).toContain('3 tier');
    });

    it('emits the no-location nudge with timezone context when only KILOCLAW_USER_TIMEZONE is set', async () => {
      // Regression test for the bug where the brief treated IANA
      // timezone city names like `America/Los_Angeles` as a stand-in
      // location and queried "local news in Los Angeles" for users
      // who actually lived hundreds of miles from LA. Now: no
      // queries fire, the brief surfaces a nudge with the timezone
      // mentioned as context.
      const harness = await createHarness({
        preloadedConfig: preloadInterestsConfig(['Local News']),
        userLocationEnv: { KILOCLAW_USER_TIMEZONE: 'America/Los_Angeles' },
        webSearch: { providers: [{ id: 'brave' }] },
        channelsConfig: telegramOnly,
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const sent = harness.sentMessages[0]?.message ?? '';
      // Section header is bare — no city in parens.
      expect(sent).toContain('Local News');
      expect(sent).not.toContain('(Los Angeles');
      expect(sent).not.toContain('from timezone');
      // Body nudges toward Settings and mentions the timezone as context.
      expect(sent).toContain('Set a location in Settings');
      expect(sent).toContain('America/Los_Angeles');
      expect(sent).toContain('city or address');

      const summaries = await readAllSourceStatus(harness.stateDir);
      const localNewsSummary = summaries.find(s => s.source === 'local-news');
      expect(localNewsSummary?.configured).toBe(false);
      expect(localNewsSummary?.ok).toBe(true);
      expect(localNewsSummary?.summary).toContain('No location');
    });

    it('returns "no local news found" message when all tiers come back empty', async () => {
      const harness = await createHarness({
        preloadedConfig: preloadInterestsConfig(['Local News']),
        userLocationEnv: { KILOCLAW_USER_LOCATION: 'Smallville, KS' },
        webSearch: {
          providers: [{ id: 'brave' }],
          // No resultsPerQuery keys — all tiers fall through to the
          // default empty result.
          defaultResult: { provider: 'brave', results: [] },
        },
        channelsConfig: telegramOnly,
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const sent = harness.sentMessages[0]?.message ?? '';
      expect(sent).toContain('Local News (Smallville, KS)');
      expect(sent).toContain('No local news found near Smallville, KS');

      const summaries = await readAllSourceStatus(harness.stateDir);
      const localNewsSummary = summaries.find(s => s.source === 'local-news');
      expect(localNewsSummary?.ok).toBe(true);
      expect(localNewsSummary?.summary).toContain('0 local news');
    });

    it('reports search failure as an [error] without breaking the brief', async () => {
      const harness = await createHarness({
        preloadedConfig: preloadInterestsConfig(['Local News']),
        userLocationEnv: { KILOCLAW_USER_LOCATION: 'San Francisco, CA' },
        webSearch: {
          // No providers → readiness check fails before tier loop runs.
          providers: [],
        },
        githubAuthReady: true,
        githubIssues: [
          {
            title: 'GH placeholder',
            url: 'https://github.com/x/y/issues/1',
            updatedAt: '2026-05-15',
          },
        ],
        channelsConfig: telegramOnly,
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const summaries = await readAllSourceStatus(harness.stateDir);
      const localNewsSummary = summaries.find(s => s.source === 'local-news');
      expect(localNewsSummary?.configured).toBe(false);
      expect(localNewsSummary?.ok).toBe(false);
      expect(localNewsSummary?.summary).toContain('No web search provider');
    });

    it('swallows webSearch.search() throws across all tiers and reports 0 results', async () => {
      // collectLocalNews → runLocalNewsTiers catches per-tier errors
      // and continues, so a throw on every search call just produces
      // an empty accumulated list rather than tanking the brief.
      const harness = await createHarness({
        preloadedConfig: preloadInterestsConfig(['Local News']),
        userLocationEnv: { KILOCLAW_USER_LOCATION: 'Novato, CA' },
        webSearch: {
          providers: [{ id: 'brave' }],
          searchThrows: new Error('rate limit exceeded'),
        },
        channelsConfig: telegramOnly,
      });

      const response = new FakeResponse();
      await harness.runHttpHandler({}, response);
      expect(response.statusCode).toBe(200);

      const sent = harness.sentMessages[0]?.message ?? '';
      expect(sent).toContain('No local news found near Novato, CA');

      const summaries = await readAllSourceStatus(harness.stateDir);
      const localNewsSummary = summaries.find(s => s.source === 'local-news');
      expect(localNewsSummary?.configured).toBe(true);
      expect(localNewsSummary?.ok).toBe(true);
      expect(localNewsSummary?.summary).toContain('0 local news results');
    });
  });

  describe('user-location HTTP route', () => {
    it('writes a string location to config.json and echoes it back', async () => {
      const harness = await createHarness();
      const response = new FakeResponse();

      await harness.userLocationHttpHandler(
        createJsonRequest({ userLocation: 'Novato, CA' }),
        response
      );

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body) as Record<string, unknown>;
      expect(payload.ok).toBe(true);
      expect(payload.userLocation).toBe('Novato, CA');

      const stored = (await readJson(
        path.join(harness.stateDir, 'morning-briefing', 'config.json')
      )) as { userLocation?: string | null };
      expect(stored.userLocation).toBe('Novato, CA');
    });

    it('clears the override when userLocation is null', async () => {
      const harness = await createHarness({
        preloadedConfig: {
          enabled: false,
          cronJobId: null,
          cron: '0 7 * * *',
          timezone: 'UTC',
          interestTopics: [],
          userLocation: 'Old Place, XX',
          updatedAt: new Date().toISOString(),
        },
      });
      const response = new FakeResponse();

      await harness.userLocationHttpHandler(createJsonRequest({ userLocation: null }), response);

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body) as Record<string, unknown>;
      expect(payload.ok).toBe(true);
      expect(payload.userLocation).toBeNull();

      const stored = (await readJson(
        path.join(harness.stateDir, 'morning-briefing', 'config.json')
      )) as { userLocation?: string | null };
      expect(stored.userLocation).toBeNull();
    });

    it('treats an empty / whitespace-only string as a clear', async () => {
      const harness = await createHarness({
        preloadedConfig: {
          enabled: false,
          cronJobId: null,
          cron: '0 7 * * *',
          timezone: 'UTC',
          interestTopics: [],
          userLocation: 'Old Place, XX',
          updatedAt: new Date().toISOString(),
        },
      });
      const response = new FakeResponse();

      await harness.userLocationHttpHandler(createJsonRequest({ userLocation: '   ' }), response);

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body) as Record<string, unknown>;
      expect(payload.userLocation).toBeNull();
    });

    it('trims surrounding whitespace before persisting', async () => {
      const harness = await createHarness();
      const response = new FakeResponse();

      await harness.userLocationHttpHandler(
        createJsonRequest({ userLocation: '  San Francisco, CA  ' }),
        response
      );

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body) as Record<string, unknown>;
      expect(payload.userLocation).toBe('San Francisco, CA');
    });

    it('returns 400 when userLocation is the wrong type', async () => {
      const harness = await createHarness();
      const response = new FakeResponse();

      await harness.userLocationHttpHandler(createJsonRequest({ userLocation: 42 }), response);

      expect(response.statusCode).toBe(400);
      const payload = JSON.parse(response.body) as Record<string, unknown>;
      expect(payload.ok).toBe(false);
      expect(payload.error).toContain('string or null');
    });

    it('returns 400 when userLocation exceeds the length cap', async () => {
      const harness = await createHarness();
      const response = new FakeResponse();

      await harness.userLocationHttpHandler(
        createJsonRequest({ userLocation: 'a'.repeat(201) }),
        response
      );

      expect(response.statusCode).toBe(400);
      const payload = JSON.parse(response.body) as Record<string, unknown>;
      expect(payload.ok).toBe(false);
      expect(payload.error).toContain('200 characters');
    });

    it('preserves enabled / cron / timezone / interestTopics when only location updates', async () => {
      const harness = await createHarness({
        preloadedConfig: {
          enabled: true,
          cronJobId: 'job-1',
          cron: '0 8 * * *',
          timezone: 'America/New_York',
          interestTopics: ['Tech', 'AI'],
          userLocation: null,
          updatedAt: new Date().toISOString(),
        },
      });
      const response = new FakeResponse();

      await harness.userLocationHttpHandler(
        createJsonRequest({ userLocation: 'Boston, MA' }),
        response
      );

      expect(response.statusCode).toBe(200);
      const stored = (await readJson(
        path.join(harness.stateDir, 'morning-briefing', 'config.json')
      )) as Record<string, unknown>;
      expect(stored.enabled).toBe(true);
      expect(stored.cronJobId).toBe('job-1');
      expect(stored.cron).toBe('0 8 * * *');
      expect(stored.timezone).toBe('America/New_York');
      expect(stored.interestTopics).toEqual(['Tech', 'AI']);
      expect(stored.userLocation).toBe('Boston, MA');
    });
  });

  describe('interests HTTP route', () => {
    it('writes topics to config.json and echoes them on the response', async () => {
      const harness = await createHarness();
      const response = new FakeResponse();

      await harness.interestsHttpHandler(
        createJsonRequest({ topics: ['Tech', 'AI', 'Local News'] }),
        response
      );

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body) as Record<string, unknown>;
      expect(payload.ok).toBe(true);
      expect(payload.interestTopics).toEqual(['Tech', 'AI', 'Local News']);

      const configPath = path.join(harness.stateDir, 'morning-briefing', 'config.json');
      const stored = (await readJson(configPath)) as { interestTopics: unknown };
      expect(stored.interestTopics).toEqual(['Tech', 'AI', 'Local News']);
    });

    it('preserves enabled/cron/timezone when only interests are updated', async () => {
      const now = new Date().toISOString();
      const harness = await createHarness({
        preloadedConfig: {
          enabled: true,
          cronJobId: 'cron-1',
          cron: '0 8 * * *',
          timezone: 'America/Los_Angeles',
          interestTopics: [],
          updatedAt: now,
        },
      });

      const response = new FakeResponse();
      await harness.interestsHttpHandler(createJsonRequest({ topics: ['Finance'] }), response);

      expect(response.statusCode).toBe(200);
      const configPath = path.join(harness.stateDir, 'morning-briefing', 'config.json');
      const stored = (await readJson(configPath)) as Record<string, unknown>;
      expect(stored.enabled).toBe(true);
      expect(stored.cron).toBe('0 8 * * *');
      expect(stored.timezone).toBe('America/Los_Angeles');
      expect(stored.cronJobId).toBe('cron-1');
      expect(stored.interestTopics).toEqual(['Finance']);
    });

    it('accepts an empty array to clear interests', async () => {
      const now = new Date().toISOString();
      const harness = await createHarness({
        preloadedConfig: {
          enabled: false,
          cronJobId: null,
          cron: '0 7 * * *',
          timezone: 'UTC',
          interestTopics: ['Tech', 'AI'],
          updatedAt: now,
        },
      });

      const response = new FakeResponse();
      await harness.interestsHttpHandler(createJsonRequest({ topics: [] }), response);

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body) as Record<string, unknown>;
      expect(payload.interestTopics).toEqual([]);

      const configPath = path.join(harness.stateDir, 'morning-briefing', 'config.json');
      const stored = (await readJson(configPath)) as { interestTopics: unknown };
      expect(stored.interestTopics).toEqual([]);
    });

    it('returns 400 when topics is missing', async () => {
      const harness = await createHarness();
      const response = new FakeResponse();

      await harness.interestsHttpHandler(createJsonRequest({}), response);

      expect(response.statusCode).toBe(400);
      const payload = JSON.parse(response.body) as Record<string, unknown>;
      expect(payload.ok).toBe(false);
      expect(payload.error).toBe('topics must be an array of strings');
    });

    it('returns 400 when topics contains non-strings', async () => {
      const harness = await createHarness();
      const response = new FakeResponse();

      await harness.interestsHttpHandler(
        createJsonRequest({ topics: ['Tech', 42, null] as unknown[] }),
        response
      );

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when topics exceeds the array cap', async () => {
      const harness = await createHarness();
      const response = new FakeResponse();

      // 21 topics — one past the 20-cap. Defense in depth against a
      // direct gateway call that bypasses the worker's Zod validation.
      const topics = Array.from({ length: 21 }, (_, i) => `Topic${i}`);
      await harness.interestsHttpHandler(createJsonRequest({ topics }), response);

      expect(response.statusCode).toBe(400);
      const payload = JSON.parse(response.body) as Record<string, unknown>;
      expect(payload.ok).toBe(false);
      expect(String(payload.error)).toContain('must not exceed');
    });

    it('returns 400 when a single topic exceeds the length cap', async () => {
      const harness = await createHarness();
      const response = new FakeResponse();

      // 65 chars — one past the 64-cap.
      const tooLong = 'x'.repeat(65);
      await harness.interestsHttpHandler(
        createJsonRequest({ topics: ['Tech', tooLong] }),
        response
      );

      expect(response.statusCode).toBe(400);
      const payload = JSON.parse(response.body) as Record<string, unknown>;
      expect(payload.ok).toBe(false);
      expect(String(payload.error)).toContain('characters or fewer');
    });

    it('trims whitespace around topics before persisting', async () => {
      const harness = await createHarness();
      const response = new FakeResponse();

      await harness.interestsHttpHandler(
        createJsonRequest({ topics: ['  Tech  ', '\tAI\n'] }),
        response
      );

      expect(response.statusCode).toBe(200);
      const configPath = path.join(harness.stateDir, 'morning-briefing', 'config.json');
      const stored = (await readJson(configPath)) as { interestTopics: string[] };
      expect(stored.interestTopics).toEqual(['Tech', 'AI']);
    });

    it('silently drops empty / whitespace-only entries', async () => {
      const harness = await createHarness();
      const response = new FakeResponse();

      await harness.interestsHttpHandler(
        createJsonRequest({ topics: ['Tech', '   ', '', '\t'] }),
        response
      );

      expect(response.statusCode).toBe(200);
      const configPath = path.join(harness.stateDir, 'morning-briefing', 'config.json');
      const stored = (await readJson(configPath)) as { interestTopics: string[] };
      expect(stored.interestTopics).toEqual(['Tech']);
    });

    it('preserves an interests write that lands while a slow reconcile holds a stale config', async () => {
      // The production race the per-config-path write queue protects
      // against: reconcile reads `StoredConfig`, awaits `ensureCronJob`
      // (which is slow because it shells out to the cron system), then
      // writes a `{ ...stale, cronJobId, cron, timezone }` spread. If
      // an interests handler writes during that window, the reconcile's
      // final spread overwrites the fresh interestTopics with the
      // stale base it read at the start.
      //
      // The barrier holds reconcile inside `cron add` so this test
      // deterministically lands the interests write during the race
      // window. Without `queueConfigWrite`, the assertions below would
      // see `interestTopics: []` (clobbered by reconcile's stale base);
      // with the queue, both edits land cleanly.
      let releaseCronAdd: () => void = () => {};
      const cronAddBarrier = new Promise<void>(resolve => {
        releaseCronAdd = resolve;
      });
      const preloadedAt = new Date(Date.now() - 60_000).toISOString();
      const harness = await createHarness({
        cronAddBarrier,
        preloadedConfig: {
          enabled: false,
          cronJobId: null,
          cron: '0 8 * * *',
          timezone: 'America/Chicago',
          interestTopics: [],
          updatedAt: preloadedAt,
        },
      });

      // Trigger reconcile: enableHttpHandler writes the config and
      // kicks off the reconcile loop in the background. The cron `add`
      // call inside reconcile now blocks on `cronAddBarrier`.
      await harness.enableHttpHandler(createJsonRequest({}), new FakeResponse());

      // Fire interests update while reconcile is paused. With the
      // queue this Promise blocks on the lock; without the queue it
      // completes immediately on the stale base.
      const interestsResponse = new FakeResponse();
      const interestsDone = harness.interestsHttpHandler(
        createJsonRequest({ topics: ['Tech', 'AI'] }),
        interestsResponse
      );

      // Give the interests handler a tick to enqueue (without
      // releasing reconcile).
      await new Promise(resolve => setTimeout(resolve, 20));

      // Release reconcile; it finishes its write and the interests
      // handler then takes the lock.
      releaseCronAdd();
      await interestsDone;
      await waitForReconcileState(harness.stateDir, 'succeeded');

      expect(interestsResponse.statusCode).toBe(200);

      const configPath = path.join(harness.stateDir, 'morning-briefing', 'config.json');
      const stored = (await readJson(configPath)) as Record<string, unknown>;
      // Reconcile's enable spread + interests write both landed.
      expect(stored.enabled).toBe(true);
      expect(stored.interestTopics).toEqual(['Tech', 'AI']);
      // Unrelated fields are preserved through the serialised writes.
      expect(stored.cron).toBe('0 8 * * *');
      expect(stored.timezone).toBe('America/Chicago');
      expect(typeof stored.cronJobId).toBe('string');
      expect(stored.cronJobId).not.toBe(null);
    });
  });

  describe('status snapshot', () => {
    it('surfaces interestTopics from stored config', async () => {
      const now = new Date().toISOString();
      const harness = await createHarness({
        preloadedConfig: {
          enabled: false,
          cronJobId: null,
          cron: '0 7 * * *',
          timezone: 'UTC',
          interestTopics: ['Tech', 'Design'],
          updatedAt: now,
        },
      });

      const response = new FakeResponse();
      await harness.statusHttpHandler({}, response);

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body) as Record<string, unknown>;
      expect(payload.interestTopics).toEqual(['Tech', 'Design']);
    });

    it('defaults interestTopics to [] when config has no field (legacy file)', async () => {
      const now = new Date().toISOString();
      const harness = await createHarness({
        preloadedConfig: {
          enabled: false,
          cronJobId: null,
          cron: '0 7 * * *',
          timezone: 'UTC',
          updatedAt: now,
        },
      });

      const response = new FakeResponse();
      await harness.statusHttpHandler({}, response);

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body) as Record<string, unknown>;
      expect(payload.interestTopics).toEqual([]);
    });
  });
});
