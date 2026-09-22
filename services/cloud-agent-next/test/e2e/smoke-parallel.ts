/**
 * Parallel deployed matrix runner.
 *
 * Runs the same shared scenarios as `smoke-deployed.ts`, but one scenario per
 * child process with a bounded concurrency pool. Each child gets its own
 * `E2E_FAKE_SCOPE`; the shared fake attributes that child's completions to the
 * scope, so the `fetchFakeRequests` "unchanged"/"increased" assertions stay
 * meaningful while other shards dispatch to the same fake.
 *
 * Usage:
 *   E2E_BATCH=<name> pnpm --filter cloud-agent-next run e2e:parallel
 *   E2E_PARALLEL=4 pnpm --filter cloud-agent-next run e2e:parallel
 *   E2E_PARALLEL=all pnpm --filter cloud-agent-next run e2e:parallel
 *
 * `E2E_BATCH` selects one batch from `E2E_BATCHES` (declared order preserved);
 * unset runs every scenario, so job selection is unchanged. `E2E_PARALLEL`
 * accepts a positive integer or `all` (every selected scenario at once) and is
 * an explicit override; when it is unset, a selected batch uses its own
 * `parallel` and the all-scenarios mode defaults to 4.
 *
 * Batch membership is validated unconditionally against the real registry
 * before any scenario runs; an unknown batch, a duplicate or missing scenario,
 * or an out-of-range `parallel` prints every error and exits `2`. A scenario
 * added to `SHARED_SCENARIOS` without a batch therefore fails here (both modes)
 * until it is batched.
 *
 * Capability-gated scenarios are filtered out up front and are not spawned, so
 * a child's non-zero exit is a failure: exit `1` when any scenario failed, else
 * `0`. A child that does not exit within its watchdog deadline is killed and
 * reported as a failure.
 *
 * End-of-run output (one `Batch:` header, one `unsupported:` line per
 * capability-filtered scenario, one `Summary:`, one `Wall time:`):
 *
 *   Batch: <name> (<n> scenarios, concurrency <p>)
 *   unsupported: <name>
 *   Summary: <pass> passed, <fail> failed, <unsupported> unsupported
 *   Wall time: <seconds>s
 *
 * `<n>` is the selected registry-key count before capability filtering; the
 * runner asserts `pass + fail + unsupported === n` and exits `2` otherwise.
 *
 * Cold boots contend on container provisioning, so `all` maximises the chance
 * of a container cold-start timeout (240 s/turn budget) showing up as a false
 * failure. A modest default trades wall time for stability.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { bootstrapDeployedProfile } from './deployed-auth.js';
import { createDeployedScenarioEnvironment } from './capabilities-deployed.js';
import { isScenarioSupported } from './scenario-capabilities.js';
import { E2E_BATCHES, resolveBatch, validateScenarioBatches } from './scenarios-batches.js';
import { SHARED_SCENARIOS } from './scenarios-shared.js';
import { requireScenarioApi } from './run.js';

const SERVICE_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const DEFAULT_PARALLEL = 4;
/** Fallback child budget when the scenario declares no `defaultTimeoutMs`. */
const DEFAULT_CHILD_TIMEOUT_MS = 30 * 60_000;
/** Extra time over the scenario budget for child startup, cleanup and exit. */
const CHILD_WATCHDOG_SLACK_MS = 10 * 60_000;

type Job = {
  name: string;
  conversation: string;
  api: string;
  timeoutMs: number | undefined;
};

type Outcome = 'pass' | 'failure';

type JobResult = {
  job: Job;
  outcome: Outcome;
  exitCode: number;
  durationMs: number;
};

function resolveParallelism(total: number, batchParallel: number | undefined): number {
  const raw = process.env.E2E_PARALLEL;
  if (raw === undefined || raw === '') return Math.min(batchParallel ?? DEFAULT_PARALLEL, total);
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === 'all') return total;
  const parsed = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`E2E_PARALLEL must be a positive integer or "all"; got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return Math.min(parsed, total);
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

type JobSelection = {
  jobs: Job[];
  /** Selected scenarios this profile cannot run, in selection order. */
  unsupported: string[];
};

function buildJobs(selectedKeys: readonly string[]): JobSelection {
  const profile = bootstrapDeployedProfile();
  const env = createDeployedScenarioEnvironment({
    surfaceUrl: profile.workerUrl,
    bearerToken: profile.auth.token,
    internalApiSecret: profile.e2eInternalApiSecret,
  });

  const jobs: Job[] = [];
  const unsupported: string[] = [];
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
    jobs.push({
      name,
      conversation: definition.defaultConversation,
      api: requireScenarioApi(definition, undefined),
      timeoutMs: definition.defaultTimeoutMs,
    });
  }
  return { jobs, unsupported };
}

function runScenario(job: Job, scope: string, total: number, index: number): Promise<JobResult> {
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
      `\n=== [${index + 1}/${total}] ${job.name} start (scope=${scope}, api=${job.api}) ===`
    );
    const child = spawn('pnpm', args, {
      cwd: SERVICE_PACKAGE_DIR,
      env: { ...process.env, E2E_PROFILE: 'deployed', E2E_FAKE_SCOPE: scope },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group so the watchdog can kill the whole `pnpm`/`tsx` tree.
      detached: true,
    });

    const prefix = `[${job.name}] `;
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
        `--- ${job.name} ${outcome} (exit=${exitCode}, ${Math.round(durationMs / 1000)}s) ---`
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

async function main(): Promise<void> {
  const registryKeys = Object.keys(SHARED_SCENARIOS);

  // Unconditional: a registry scenario that is not batched must fail both the
  // batch and the all-scenarios mode instead of being silently skipped.
  const validationErrors = validateScenarioBatches(E2E_BATCHES, registryKeys);
  if (validationErrors.length > 0) {
    for (const error of validationErrors) {
      console.error(`scenario-batch validation error: ${error}`);
    }
    process.exit(2);
  }

  const requestedBatch = process.env.E2E_BATCH;
  let batchName = 'all';
  let selectedKeys = registryKeys;
  let batchParallel: number | undefined;
  // Only an absent `E2E_BATCH` selects every scenario. Any supplied value,
  // including empty or whitespace-only, must name a known batch.
  if (requestedBatch !== undefined) {
    const resolved = resolveBatch(requestedBatch, registryKeys);
    if (resolved === null || !resolved.ok) {
      console.error(
        `E2E_BATCH must be one of ${JSON.stringify(Object.keys(E2E_BATCHES))}; got ${JSON.stringify(requestedBatch)}`
      );
      if (resolved !== null) {
        for (const error of resolved.errors) console.error(`batch resolution error: ${error}`);
      }
      process.exit(2);
    }
    batchName = resolved.name;
    selectedKeys = [...resolved.scenarios];
    batchParallel = resolved.parallel;
  }

  const { jobs, unsupported } = buildJobs(selectedKeys);
  const parallelism = resolveParallelism(jobs.length, batchParallel);
  console.log(
    `Running ${jobs.length} scenarios with concurrency ${parallelism} against ${process.env.WORKER_URL ?? '(unset WORKER_URL)'}`
  );

  const results: JobResult[] = [];
  let cursor = 0;
  const startedAt = Date.now();
  const worker = async (): Promise<void> => {
    while (cursor < jobs.length) {
      const index = cursor++;
      const job = jobs[index];
      const scope = `${job.name}-${randomUUID().slice(0, 8)}`;
      results.push(await runScenario(job, scope, jobs.length, index));
    }
  };
  await Promise.all(Array.from({ length: parallelism }, worker));
  const wallSeconds = Math.round((Date.now() - startedAt) / 1000);

  const pass = results.filter(result => result.outcome === 'pass');
  const failures = results.filter(result => result.outcome === 'failure');
  const scenarios = selectedKeys.length;
  if (pass.length + failures.length + unsupported.length !== scenarios) {
    console.error(
      `batch accounting error: ${pass.length} passed + ${failures.length} failed + ${unsupported.length} unsupported !== ${scenarios} selected`
    );
    process.exit(2);
  }

  console.log(`\nBatch: ${batchName} (${scenarios} scenarios, concurrency ${parallelism})`);
  for (const name of unsupported) console.log(`unsupported: ${name}`);
  console.log(
    `Summary: ${pass.length} passed, ${failures.length} failed, ${unsupported.length} unsupported`
  );
  console.log(`Wall time: ${wallSeconds}s`);

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('parallel deployed smoke driver failed:', error);
  process.exit(1);
});
