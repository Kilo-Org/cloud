import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isTransientScenarioFailure,
  parseMatrixArgs,
  resolveParallelism,
  runScenario,
  sandboxBudget,
  scopeFor,
  selectJobs,
} from '../../e2e/matrix.js';
import { resolveProfile } from '../../e2e/run.js';
import type { ScenarioEnvironment } from '../../e2e/scenario-capabilities.js';
import { SHARED_SCENARIOS } from '../../e2e/scenarios-shared.js';

vi.mock(import('node:child_process'), async importOriginal => ({
  ...(await importOriginal()),
  spawn: vi.fn(),
}));

const GIB = 1024 ** 3;

describe('sandboxBudget', () => {
  it('leaves room for the stack and divides the rest by the sandbox footprint', () => {
    expect(sandboxBudget(12 * GIB)).toBe(6);
    expect(sandboxBudget(8 * GIB)).toBe(3);
  });

  it('never drops below one sandbox', () => {
    expect(sandboxBudget(2 * GIB)).toBe(1);
  });
});

describe('resolveParallelism', () => {
  const base = { total: 30, sandboxBudget: undefined };

  it('defaults to four on a profile without a sandbox budget', () => {
    expect(resolveParallelism({ ...base, requested: undefined })).toEqual({ size: 4 });
  });

  it('defaults to the sandbox budget when that is smaller than four', () => {
    expect(resolveParallelism({ ...base, requested: undefined, sandboxBudget: 3 })).toEqual({
      size: 3,
    });
    expect(resolveParallelism({ ...base, requested: undefined, sandboxBudget: 9 })).toEqual({
      size: 4,
    });
  });

  it('never exceeds the number of jobs', () => {
    expect(resolveParallelism({ ...base, total: 2, requested: undefined })).toEqual({ size: 2 });
    expect(resolveParallelism({ ...base, total: 2, requested: 'all' })).toEqual({ size: 2 });
  });

  it('honours an explicit size above the budget with a warning naming both', () => {
    const result = resolveParallelism({ ...base, requested: '8', sandboxBudget: 5 });
    expect(result).toMatchObject({ size: 8 });
    expect(result).toHaveProperty('warning', expect.stringContaining('pool of 8'));
    expect(result).toHaveProperty('warning', expect.stringContaining('5 sandboxes'));
  });

  it('accepts all and a serial pool', () => {
    expect(resolveParallelism({ ...base, requested: 'all' })).toEqual({ size: 30 });
    expect(resolveParallelism({ ...base, requested: '1' })).toEqual({ size: 1 });
  });

  it('rejects a size that is not a positive integer', () => {
    for (const requested of ['0', '-2', '2.5', 'many']) {
      expect(resolveParallelism({ ...base, requested })).toHaveProperty('error');
    }
  });
});

describe('parseMatrixArgs', () => {
  it('reads spaced and inline flags', () => {
    expect(parseMatrixArgs(['--profile', 'local', '--parallel=2'])).toEqual({
      profile: 'local',
      parallel: '2',
    });
    expect(parseMatrixArgs([])).toEqual({});
  });

  it('splits --only into scenario names', () => {
    expect(parseMatrixArgs(['--only', 'cold,worktree-chat'])).toEqual({
      only: ['cold', 'worktree-chat'],
    });
    expect(parseMatrixArgs(['--only=cold'])).toEqual({ only: ['cold'] });
  });

  it('rejects an unknown flag or a flag without a value', () => {
    expect(parseMatrixArgs(['--bogus', 'x'])).toBeNull();
    expect(parseMatrixArgs(['--profile'])).toBeNull();
  });
});

describe('resolveProfile', () => {
  it('selects local by default and honours the three names', () => {
    expect(resolveProfile({})).toBe('local');
    expect(resolveProfile({ E2E_PROFILE: 'local' })).toBe('local');
    expect(resolveProfile({ E2E_PROFILE: 'local-http' })).toBe('local-http');
    expect(resolveProfile({ E2E_PROFILE: 'deployed' })).toBe('deployed');
  });

  it('keeps E2E_LOCAL_HTTP=1 as an alias for a local selection only', () => {
    expect(resolveProfile({ E2E_LOCAL_HTTP: '1' })).toBe('local-http');
    expect(resolveProfile({ E2E_PROFILE: 'deployed', E2E_LOCAL_HTTP: '1' })).toBe('deployed');
  });
});

describe('selectJobs', () => {
  const allCapabilities: ScenarioEnvironment = {
    profile: 'local',
    requireControlPlaneSession: false,
    sandbox: {
      snapshotContainerIds: async () => new Set(),
      waitForOwnedContainer: async () => null,
      waitForNewContainer: async () => null,
    },
    sessionSandbox: { waitForContainer: async () => null, currentContainer: async () => null },
    callbacks: {} as ScenarioEnvironment['callbacks'],
    gates: { parkedStreamsSupported: true },
    sandboxFaults: {} as ScenarioEnvironment['sandboxFaults'],
    controlPlaneV2: { ready: true },
    controlPlaneRuntime: {} as ScenarioEnvironment['controlPlaneRuntime'],
    credentialContainment: { enabled: true },
    attachments: {} as ScenarioEnvironment['attachments'],
    reports: {} as ScenarioEnvironment['reports'],
  };
  const keys = Object.keys(SHARED_SCENARIOS);

  it('accounts for every registry scenario as a job or unsupported', () => {
    const { jobs, unsupported } = selectJobs(keys, 'local', allCapabilities);
    const names = new Set([...jobs.map(job => job.name), ...unsupported]);
    expect(names.size).toBe(keys.length);
  });

  it('runs the scenarios that stop or freeze a container last', () => {
    const { jobs } = selectJobs(keys, 'local', allCapabilities);
    const isFault = (name: string): boolean =>
      SHARED_SCENARIOS[name]?.requires.includes('sandboxFaults') === true;
    const firstFault = jobs.findIndex(job => isFault(job.name));
    expect(firstFault).toBeGreaterThan(0);
    expect(jobs.slice(firstFault).every(job => isFault(job.name))).toBe(true);
  });

  it('adds the legacy cold-hot variant on the local profile only', () => {
    const local = selectJobs(keys, 'local', allCapabilities).jobs;
    expect(local.filter(job => job.name === 'cold-hot').map(job => job.label)).toEqual([
      'cold-hot',
      'cold-hot[legacy]',
    ]);
    const http = selectJobs(keys, 'local-http', {
      ...allCapabilities,
      profile: 'local-http',
    }).jobs;
    expect(http.filter(job => job.name === 'cold-hot')).toHaveLength(1);
  });

  it('filters a scenario whose capability the profile lacks and never spawns it', () => {
    const { jobs, unsupported } = selectJobs(keys, 'local', {
      ...allCapabilities,
      sandboxFaults: undefined,
    });
    expect(unsupported).toContain('external-kill');
    expect(jobs.map(job => job.name)).not.toContain('external-kill');
  });

  it('uses each scenario default conversation and timeout', () => {
    const { jobs } = selectJobs(keys, 'local', allCapabilities);
    const queue = jobs.find(job => job.name === 'queue-while-busy');
    expect(queue?.conversation).toBe(SHARED_SCENARIOS['queue-while-busy']?.defaultConversation);
    expect(queue?.timeoutMs).toBe(SHARED_SCENARIOS['queue-while-busy']?.defaultTimeoutMs);
  });
});

describe('scopeFor', () => {
  const job = (label: string) => ({
    name: label,
    label,
    conversation: '_',
    api: 'unified' as const,
    timeoutMs: undefined,
  });

  it('yields a valid fake-LLM scope for an API variant label', () => {
    expect(scopeFor(job('cold-hot[legacy]'), 'ab12cd34')).toBe('cold-hot-legacy-ab12cd34');
  });

  it('stays within 64 characters and keeps the nonce', () => {
    const scope = scopeFor(job('x'.repeat(100)), 'ab12cd34');
    expect(scope).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(scope.endsWith('-ab12cd34')).toBe(true);
  });
});

describe('isTransientScenarioFailure', () => {
  it.each([
    '❌ hot/echo:hi (15647ms): threw: tRPC start failed: 500 Internal Server Error — INTERNAL_SERVER_ERROR: Failed query: begin',
    '❌ chunked-streaming/slow:5:50 (43571ms): start session: tRPC start failed: 500 Internal Server Error — INTERNAL_SERVER_ERROR: Failed query: begin',
    '❌ queue-rapid-fire-no-gate/_ (15409ms): threw: tRPC start failed: 500 Internal Server Error — INTERNAL_SERVER_ERROR: Failed query: select "id" from "agent_environment_profiles"',
    '❌ callback-completion/echo:done (71649ms): threw: Stream did not connect for workspace_df479885',
    '❌ hot/echo:hi (12ms): threw: fetch failed',
    '❌ hot/echo:hi (12ms): threw: tRPC start failed: 503 Service Unavailable',
    '❌ hot/echo:hi (12ms): threw: connect ETIMEDOUT 10.0.0.1:5432',
  ])('recognizes an infrastructure failure: %s', line => {
    expect(isTransientScenarioFailure(line)).toBe(true);
  });

  it.each([
    '❌ hot/echo:hi (12ms): threw: tRPC start failed: 400 Bad Request — BAD_REQUEST: Selected model is not available for this cloud agent session',
    '❌ hot/echo:hi (12ms): threw: tRPC start failed: 400 Bad Request — BAD_REQUEST: fetch failed',
    '❌ queue-full/_ (12ms): filled 9 before rejection: TOO_MANY_REQUESTS: Pending message queue is full (10)',
    '❌ hot/echo:hi (12ms): threw: tRPC start failed: 500 Internal Server Error — INTERNAL_SERVER_ERROR: boom',
    '❌ preview-http/_ (28ms): preview-http: closed-port GET / status=500 was not 502',
    '❌ preview-http/_ (28ms): preview-http: unexpected body; closedPort=8080:502(12ms)',
    '❌ preview-http/_ (28ms): preview-http: GET / status=503 was not 200',
    '❌ preview-http/_ (28ms): preview-http: body={"status":503}',
    '❌ hot/echo:hi (504ms): expected sameContainer=true, received false',
    '❌ hot/echo:hi (12ms): assertion failed after 504 ms',
  ])('does not retry assertion failures, 4xx or a 500 without a marker: %s', line => {
    expect(isTransientScenarioFailure(line)).toBe(false);
  });
});

describe('runScenario retry eligibility', () => {
  function startChild() {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 1234,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(spawn).mockReturnValueOnce(child as ReturnType<typeof spawn>);
    const result = runScenario(
      { name: 'hot', label: 'hot', conversation: 'echo:hi', api: 'unified', timeoutMs: 1 },
      'deployed',
      'hot-test',
      1,
      0
    );
    return { child, result };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('ignores recovered errors on both streams before an assertion failure', async () => {
    const { child, result } = startChild();
    child.stdout.write('warning: fetch failed; reconnecting\n');
    child.stderr.write('session stream connection failed Error: ECONNRESET\n');
    child.stdout.write('❌ hot/echo:hi (12ms): expected sameContainer=true, received false\n');
    child.stdout.write('   events (0): (none)\n');
    child.emit('close', 1);
    await expect(result).resolves.toMatchObject({ outcome: 'failure', transient: false });
  });

  it('keeps the result line eligible despite the event summary', async () => {
    const { child, result } = startChild();
    child.stdout.write('❌ hot/echo:hi (12ms): threw: fetch failed\n');
    child.stdout.write('   events (0): (none)\n');
    child.emit('close', 1);
    await expect(result).resolves.toMatchObject({ outcome: 'failure', transient: true });
  });

  it.each([null, 1])(
    'does not retry a watchdog kill even with a transient result (exit=%s)',
    async code => {
      vi.useFakeTimers();
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      const { child, result } = startChild();
      child.stdout.write('❌ hot/echo:hi (12ms): threw: fetch failed\n');
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
      expect(kill).toHaveBeenCalledWith(-1234, 'SIGKILL');
      child.emit('close', code);
      await expect(result).resolves.toMatchObject({ outcome: 'failure', transient: false });
    }
  );
});
