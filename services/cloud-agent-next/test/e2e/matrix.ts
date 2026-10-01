/**
 * The one matrix runner. It runs every entry in `SHARED_SCENARIOS`, one scenario
 * per child process (`run.ts`), under one concurrency pool; `--parallel 1` is a
 * serial run. Each child gets its own `E2E_FAKE_SCOPE`, so the shared fake
 * attributes that child's completions to the scope and the `fetchFakeRequests`
 * "unchanged"/"increased" assertions stay meaningful while other shards dispatch
 * to the same fake.
 *
 * Usage:
 *   tsx test/e2e/matrix.ts [--profile local|local-http|deployed] [--parallel <n>|all]
 *                          [--only <name>[,<name>...]]
 *
 *   pnpm --filter cloud-agent-next run e2e:parallel      deployed, pool of 4 (CI)
 *   pnpm --filter cloud-agent-next run e2e:deployed      deployed, serial
 *   pnpm --filter cloud-agent-next run e2e:local         local Docker, pool sized to Docker memory
 *
 * Profile: `--profile`, else `E2E_PROFILE`, else `local`. Pool size:
 * `--parallel`, else `E2E_PARALLEL`, else 4 on `deployed` and the number of
 * sandboxes the Docker VM can hold (at most 4) on the local profiles.
 *
 * Capability-gated scenarios are filtered out up front and are not spawned, so
 * a child's non-zero exit is a failure: exit `1` when any scenario failed, else
 * `0`. A child that does not exit within its watchdog deadline is killed and
 * reported as a failure.
 *
 * End-of-run output (one `unsupported:` line per capability-filtered scenario,
 * one `Summary:`, one `Wall time:`):
 *
 *   unsupported: <name>
 *   Summary: <pass> passed, <fail> failed, <unsupported> unsupported
 *   Wall time: <seconds>s
 *
 * The runner asserts `pass + fail + unsupported` equals the scenarios it
 * selected and exits `2` otherwise. When `GITHUB_STEP_SUMMARY` is set it appends
 * the `Summary:` line to that file; a write failure is logged and never changes
 * the run result.
 *
 * Sandbox teardown is not this file's job: `runSharedScenario` releases each
 * child's sessions and, on the local profile, stops the sandbox primaries they
 * owned, together with their proxies: every local session has its own `ses-…`
 * sandbox. After a local run this file only reports the primaries and the
 * proxies still running (a child killed by its watchdog skips its own
 * teardown); it never removes them.
 *
 * Cold boots contend on container provisioning, so `all` maximises the chance
 * of a container cold-start timeout (240 s/turn budget) showing up as a false
 * failure. A modest default trades wall time for stability.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { bootstrapDeployedProfile } from './deployed-auth.js';
import { createDeployedScenarioEnvironment } from './capabilities-deployed.js';
import {
  createLocalScenarioEnvironment,
  credentialContainmentEnabled,
} from './capabilities-local.js';
import { createLocalHttpScenarioEnvironment } from './e2e-surface-client.js';
import { loadDevVars, loadRepoEnvFiles } from './auth.js';
import { findOrphanProxies, listSandboxContainers } from './sandbox-control.js';
import {
  isScenarioSupported,
  type Profile,
  type ScenarioEnvironment,
} from './scenario-capabilities.js';
import { SHARED_SCENARIOS } from './scenarios-shared.js';
import { requireScenarioApi, resolveProfile } from './run.js';
import type { ApiVersion } from './client.js';

const SERVICE_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const execFileAsync = promisify(execFile);

const DEFAULT_PARALLEL = 4;
/** Fallback child budget when the scenario declares no `defaultTimeoutMs`. */
const DEFAULT_CHILD_TIMEOUT_MS = 30 * 60_000;
/** Extra time over the scenario budget for child startup, cleanup and exit. */
const CHILD_WATCHDOG_SLACK_MS = 10 * 60_000;

const GIB = 1024 ** 3;
/**
 * Memory one sandbox holds (Kilo, the wrapper and their tools), measured at
 * about 1.5 GiB. A local pool larger than the Docker VM can hold gets its
 * sandboxes OOM-killed mid-scenario.
 */
const SANDBOX_MEMORY_BYTES = 1.5 * GIB;
/** Docker memory left for the stack's own containers (Postgres, Redis, proxies). */
const DOCKER_RESERVED_BYTES = 3 * GIB;

/** Extra runs of a scenario under another API surface, on the profiles that support it. */
const LOCAL_API_VARIANTS: ReadonlyArray<{
  name: string;
  api: ApiVersion;
  conversation: string;
}> = [{ name: 'cold-hot', api: 'legacy', conversation: 'echo:legacy' }];

export type Job = {
  name: string;
  /** What the log line and the accounting call it; the variant's API is part of it. */
  label: string;
  conversation: string;
  api: ApiVersion;
  timeoutMs: number | undefined;
};

type Outcome = 'pass' | 'failure';

type JobResult = {
  job: Job;
  outcome: Outcome;
  exitCode: number;
  durationMs: number;
};

export type MatrixArgs = { profile?: string; parallel?: string; only?: string[] };

/** Parse `--profile`, `--parallel` and `--only`, each as `--flag value` or `--flag=value`. */
export function parseMatrixArgs(argv: readonly string[]): MatrixArgs | null {
  const args: MatrixArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const [flag, inline] = arg.split('=', 2);
    if (flag !== '--profile' && flag !== '--parallel' && flag !== '--only') return null;
    const value = inline ?? argv[++index];
    if (value === undefined || value === '') return null;
    if (flag === '--profile') args.profile = value;
    else if (flag === '--parallel') args.parallel = value;
    else args.only = value.split(',').filter(name => name !== '');
  }
  return args;
}

/** How many sandboxes a Docker VM of `dockerMemoryBytes` holds beside the stack itself. */
export function sandboxBudget(dockerMemoryBytes: number): number {
  return Math.max(
    1,
    Math.floor((dockerMemoryBytes - DOCKER_RESERVED_BYTES) / SANDBOX_MEMORY_BYTES)
  );
}

export type Parallelism = { size: number; warning?: string };

/**
 * The pool size. An explicit request is honoured even above the sandbox budget,
 * with a warning that names the numbers; the default never exceeds either the
 * budget or `DEFAULT_PARALLEL`.
 */
export function resolveParallelism(input: {
  requested: string | undefined;
  total: number;
  sandboxBudget: number | undefined;
}): Parallelism | { error: string } {
  const { requested, total, sandboxBudget: budget } = input;
  if (requested === undefined || requested.trim() === '') {
    const ceiling = budget === undefined ? DEFAULT_PARALLEL : Math.min(DEFAULT_PARALLEL, budget);
    return { size: Math.max(1, Math.min(ceiling, total)) };
  }
  const trimmed = requested.trim();
  const size = trimmed.toLowerCase() === 'all' ? total : Number(trimmed);
  if (!/^(all|\d+)$/i.test(trimmed) || !Number.isInteger(size) || size < 1) {
    return {
      error: `--parallel / E2E_PARALLEL must be a positive integer or "all"; got ${requested}`,
    };
  }
  const bounded = Math.min(size, total);
  if (budget !== undefined && bounded > budget) {
    return {
      size: bounded,
      warning:
        `a pool of ${bounded} exceeds the ${budget} sandboxes this Docker VM holds; ` +
        'expect OOM kills and false failures',
    };
  }
  return { size: bounded };
}

async function dockerMemoryBytes(): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('docker', ['info', '--format', '{{.MemTotal}}']);
    const bytes = Number(stdout.trim());
    return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The fake-LLM scope for one job. It must match `[A-Za-z0-9_-]{1,64}`, so a
 * variant label such as `cold-hot[legacy]` is sanitized; the nonce keeps two
 * runs of the same job apart.
 */
export function scopeFor(job: Job, nonce: string): string {
  const label = job.label.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+$/, '');
  return `${label.slice(0, 64 - nonce.length - 1)}-${nonce}`;
}

/** Kill the child's process group so `pnpm` and its `tsx`/`node` tree all stop. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

export type JobSelection = {
  jobs: Job[];
  /** Selected scenarios this profile cannot run, in selection order. */
  unsupported: string[];
};

/**
 * Split the registry into runnable jobs and capability-gated scenarios. The
 * scenarios that stop or freeze a real container run last, so a fault cannot
 * disturb a healthy scenario that is still starting.
 */
export function selectJobs(
  selectedKeys: readonly string[],
  profile: Profile,
  env: ScenarioEnvironment
): JobSelection {
  const jobs: Job[] = [];
  const unsupported: string[] = [];
  const faultJobs: Job[] = [];
  const add = (job: Job, faults: boolean): void => {
    (faults ? faultJobs : jobs).push(job);
  };
  for (const name of selectedKeys) {
    const definition = SHARED_SCENARIOS[name];
    if (definition === undefined) {
      // Selection is derived from the registry, so this is a programming error.
      throw new Error(`selected scenario "${name}" is not in SHARED_SCENARIOS`);
    }
    if (!isScenarioSupported(definition, env)) {
      unsupported.push(name);
      continue;
    }
    const api = requireScenarioApi(definition, undefined);
    add(
      {
        name,
        label: name,
        conversation: definition.defaultConversation,
        api,
        timeoutMs: definition.defaultTimeoutMs,
      },
      definition.requires.includes('sandboxFaults')
    );
    if (profile !== 'local') continue;
    for (const variant of LOCAL_API_VARIANTS) {
      if (variant.name !== name) continue;
      add(
        {
          name,
          label: `${name}[${variant.api}]`,
          conversation: variant.conversation,
          api: requireScenarioApi(definition, variant.api),
          timeoutMs: definition.defaultTimeoutMs,
        },
        definition.requires.includes('sandboxFaults')
      );
    }
  }
  return { jobs: [...jobs, ...faultJobs], unsupported };
}

async function scenarioEnvironment(profile: Profile): Promise<ScenarioEnvironment> {
  if (profile === 'deployed') {
    const deployed = bootstrapDeployedProfile();
    return createDeployedScenarioEnvironment({
      surfaceUrl: deployed.workerUrl,
      bearerToken: deployed.auth.token,
      internalApiSecret: deployed.e2eInternalApiSecret,
    });
  }
  // The local Worker's own settings decide credential containment, and the
  // report capability needs the Postgres URL the children will also load.
  loadRepoEnvFiles(SERVICE_PACKAGE_DIR);
  const containment = credentialContainmentEnabled(loadDevVars(SERVICE_PACKAGE_DIR));
  if (profile === 'local') {
    return createLocalScenarioEnvironment({ credentialContainmentEnabled: containment });
  }
  const deployed = bootstrapDeployedProfile();
  return createLocalHttpScenarioEnvironment({
    surfaceUrl: deployed.workerUrl,
    bearerToken: deployed.auth.token,
    internalApiSecret: deployed.e2eInternalApiSecret,
    credentialContainmentEnabled: containment,
  });
}

function runScenario(
  job: Job,
  profile: Profile,
  scope: string,
  total: number,
  index: number
): Promise<JobResult> {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const args = [
      'exec',
      'tsx',
      'test/e2e/run.ts',
      `--api=${job.api}`,
      ...(job.timeoutMs === undefined ? [] : [`--timeout-ms=${job.timeoutMs}`]),
      job.name,
      job.conversation,
    ];
    console.log(
      `\n=== [${index + 1}/${total}] ${job.label} start (scope=${scope}, api=${job.api}) ===`
    );
    const child = spawn('pnpm', args, {
      cwd: SERVICE_PACKAGE_DIR,
      env: { ...process.env, E2E_PROFILE: profile, E2E_FAKE_SCOPE: scope },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group so the watchdog can kill the whole `pnpm`/`tsx` tree.
      detached: true,
    });

    const prefix = `[${job.label}] `;
    const forward = (stream: NodeJS.ReadableStream): void => {
      stream.setEncoding('utf8');
      let buffered = '';
      stream.on('data', (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) console.log(`${prefix}${line}`);
      });
      stream.on('end', () => {
        if (buffered.length > 0) console.log(`${prefix}${buffered}`);
      });
    };
    forward(child.stdout);
    forward(child.stderr);

    let settled = false;
    const watchdogMs = (job.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS) + CHILD_WATCHDOG_SLACK_MS;
    const watchdog = setTimeout(() => {
      console.error(
        `${prefix}watchdog: no exit after ${Math.round(watchdogMs / 1000)}s; killing child`
      );
      killTree(child);
    }, watchdogMs);
    watchdog.unref();

    const settle = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      const durationMs = Date.now() - startedAt;
      const outcome: Outcome = exitCode === 0 ? 'pass' : 'failure';
      console.log(
        `--- ${job.label} ${outcome} (exit=${exitCode}, ${Math.round(durationMs / 1000)}s) ---`
      );
      resolve({ job, outcome, exitCode, durationMs });
    };

    child.on('error', error => {
      console.error(`${prefix}spawn failed: ${error.message}`);
      settle(1);
    });
    child.on('close', code => settle(code ?? 1));
  });
}

/**
 * Append the run's `Summary:` line to the GitHub Actions job summary when
 * `GITHUB_STEP_SUMMARY` names a file. A write failure is logged and ignored:
 * the runner's exit code stays authoritative.
 */
async function appendSummaryToStepSummary(summary: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath === '') return;
  try {
    await appendFile(summaryPath, `${summary}\n`);
  } catch (error) {
    console.warn(
      `failed to append the summary to GITHUB_STEP_SUMMARY: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function orphanProxyCount(): Promise<number> {
  try {
    return findOrphanProxies(await listSandboxContainers()).length;
  } catch {
    return 0;
  }
}

/** Ids of the primary sandbox containers running now. */
async function runningSandboxIds(): Promise<Set<string> | undefined> {
  try {
    const containers = await listSandboxContainers();
    return new Set(
      containers.filter(container => !container.isProxy).map(container => container.id)
    );
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const parsed = parseMatrixArgs(process.argv.slice(2));
  if (parsed === null) {
    console.error(
      'Usage: tsx test/e2e/matrix.ts [--profile local|local-http|deployed] [--parallel <n>|all] [--only <name>[,<name>...]]'
    );
    process.exit(2);
  }
  const profile = resolveProfile({
    ...process.env,
    ...(parsed.profile === undefined ? {} : { E2E_PROFILE: parsed.profile }),
  });
  const isLocal = profile !== 'deployed';

  const unknown = (parsed.only ?? []).filter(name => SHARED_SCENARIOS[name] === undefined);
  if (unknown.length > 0) {
    console.error(
      `unknown scenario(s) in --only: ${unknown.join(', ')}; expected: ${Object.keys(SHARED_SCENARIOS).join(', ')}`
    );
    process.exit(2);
  }
  const selectedKeys = parsed.only ?? Object.keys(SHARED_SCENARIOS);
  const { jobs, unsupported } = selectJobs(
    selectedKeys,
    profile,
    await scenarioEnvironment(profile)
  );
  const memoryBytes = isLocal ? await dockerMemoryBytes() : undefined;
  const parallelism = resolveParallelism({
    requested: parsed.parallel ?? process.env.E2E_PARALLEL,
    total: jobs.length,
    sandboxBudget: memoryBytes === undefined ? undefined : sandboxBudget(memoryBytes),
  });
  if ('error' in parallelism) {
    console.error(parallelism.error);
    process.exit(2);
  }
  if (parallelism.warning !== undefined) console.warn(`warning: ${parallelism.warning}`);
  console.log(
    `Running ${jobs.length} scenarios on the ${profile} profile with concurrency ${parallelism.size} against ${process.env.WORKER_URL ?? '(unset WORKER_URL)'}`
  );

  const before = isLocal ? await runningSandboxIds() : undefined;

  const results: JobResult[] = [];
  let cursor = 0;
  const startedAt = Date.now();
  const worker = async (): Promise<void> => {
    while (cursor < jobs.length) {
      const index = cursor++;
      const job = jobs[index];
      if (job === undefined) return;
      const scope = scopeFor(job, randomUUID().slice(0, 8));
      results.push(await runScenario(job, profile, scope, jobs.length, index));
    }
  };
  await Promise.all(Array.from({ length: parallelism.size }, worker));
  const wallSeconds = Math.round((Date.now() - startedAt) / 1000);

  if (isLocal) {
    const after = await runningSandboxIds();
    if (before !== undefined && after !== undefined) {
      const leftover = [...after].filter(id => !before.has(id));
      console.log(
        `Sandboxes still running from this run: ${leftover.length}` +
          (leftover.length > 0 ? ' (the idle stop reclaims them)' : '')
      );
    }
    const orphans = await orphanProxyCount();
    if (orphans > 0) {
      console.log(
        `Orphan sandbox proxies running: ${orphans} (not removed: a proxy can belong to a test that is still running)`
      );
    }
  }

  const pass = results.filter(result => result.outcome === 'pass');
  const failures = results.filter(result => result.outcome === 'failure');
  const selectedNames = new Set([...jobs.map(job => job.name), ...unsupported]);
  if (selectedNames.size !== selectedKeys.length || pass.length + failures.length !== jobs.length) {
    console.error(
      `scenario accounting error: ${selectedNames.size} of ${selectedKeys.length} registry scenarios selected; ` +
        `${pass.length} passed + ${failures.length} failed !== ${jobs.length} jobs`
    );
    process.exit(2);
  }

  for (const name of unsupported) console.log(`unsupported: ${name}`);
  const summary = `Summary: ${pass.length} passed, ${failures.length} failed, ${unsupported.length} unsupported`;
  console.log(summary);
  console.log(`Wall time: ${wallSeconds}s`);

  await appendSummaryToStepSummary(summary);

  process.exit(failures.length > 0 ? 1 : 0);
}

// Only run as a CLI when this file is executed directly, so tests can import
// the pure helpers above.
const invokedDirectly = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;
if (invokedDirectly) {
  main().catch(error => {
    console.error('matrix driver failed:', error);
    process.exit(1);
  });
}
