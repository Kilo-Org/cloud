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
  cronJobs: CronJob[];
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
  const runCommandWithTimeout = vi.fn(async (argv: string[]) => {
    if (argv[0] === 'gh' && argv[1] === 'auth' && argv[2] === 'status') {
      return { stdout: '', stderr: 'not authenticated', code: 1 };
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
    },
    logger: { warn: vi.fn() },
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
      }
    },
    registerTool: vi.fn(),
    on: vi.fn(),
  } as never);

  if (!commandHandler || !statusHttpHandler || !enableHttpHandler) {
    throw new Error('Failed to register command or HTTP handlers');
  }

  return {
    stateDir,
    commandHandler,
    statusHttpHandler,
    enableHttpHandler,
    cronJobs,
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
});
