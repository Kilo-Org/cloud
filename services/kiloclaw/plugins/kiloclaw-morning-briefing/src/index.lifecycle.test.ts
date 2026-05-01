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
  channelsConfig?: Record<string, unknown>;
  messageSendFailures?: Partial<Record<'telegram' | 'discord' | 'slack', string>>;
  messageSendFailureCounts?: Partial<Record<'telegram' | 'discord' | 'slack', number>>;
  omitRuntimeChannelsConfig?: boolean;
}): Promise<TestHarness> {
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
  let runHttpHandler: ((_req: unknown, res: FakeResponse) => Promise<void>) | null = null;
  const loggerInfo = vi.fn();
  const loggerWarn = vi.fn();

  morningBriefingPlugin.register({
    runtime: {
      state: { resolveStateDir: () => stateDir },
      system: { runCommandWithTimeout },
      webSearch: {
        listProviders: () => [],
        search: async () => ({ provider: 'none', result: {} }),
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
      } else if (route.path.endsWith('/run')) {
        runHttpHandler = route.handler;
      }
    },
    registerTool: vi.fn(),
    on: vi.fn(),
  } as never);

  if (!commandHandler || !statusHttpHandler || !enableHttpHandler || !runHttpHandler) {
    throw new Error('Failed to register command or HTTP handlers');
  }

  return {
    stateDir,
    commandHandler,
    statusHttpHandler,
    enableHttpHandler,
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
});
