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
 *   E2E_PARALLEL=4 pnpm --filter cloud-agent-next run e2e:parallel
 *   E2E_PARALLEL=all pnpm --filter cloud-agent-next run e2e:parallel
 *
 * `E2E_PARALLEL` accepts a positive integer or `all` (every supported scenario
 * at once); it defaults to 4. Exit policy: `1` if any scenario failed, else `2`
 * if any scenario was unsupported that the deployed profile did not already
 * report as a capability gap, else `0`. Capability-gated scenarios are filtered
 * out up front and are not spawned.
 *
 * Cold boots contend on container provisioning, so `all` maximises the chance
 * of a container cold-start timeout (240 s/turn budget) showing up as a false
 * failure. A modest default (4) trades wall time for stability.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { bootstrapDeployedProfile } from './deployed-auth.js';
import { createDeployedScenarioEnvironment } from './capabilities-deployed.js';
import { isScenarioSupported } from './scenario-capabilities.js';
import { SHARED_SCENARIOS } from './scenarios-shared.js';
import { requireScenarioApi } from './run.js';

const SERVICE_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const DEFAULT_PARALLEL = 4;

type Job = {
  name: string;
  conversation: string;
  api: string;
  timeoutMs: number | undefined;
};

type Outcome = 'pass' | 'failure' | 'unsupported';

type JobResult = {
  job: Job;
  outcome: Outcome;
  exitCode: number;
  durationMs: number;
};

function resolveParallelism(total: number): number {
  const raw = process.env.E2E_PARALLEL;
  if (raw === undefined || raw === '') return Math.min(DEFAULT_PARALLEL, total);
  if (raw.trim().toLowerCase() === 'all') return total;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`E2E_PARALLEL must be a positive integer or "all"; got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return Math.min(parsed, total);
}

function buildJobs(): Job[] {
  const profile = bootstrapDeployedProfile();
  const env = createDeployedScenarioEnvironment({
    surfaceUrl: profile.workerUrl,
    bearerToken: profile.auth.token,
    internalApiSecret: profile.e2eInternalApiSecret,
  });

  const jobs: Job[] = [];
  for (const [name, definition] of Object.entries(SHARED_SCENARIOS)) {
    if (!isScenarioSupported(definition, env)) {
      console.log(`skipping unsupported on this profile: ${name}`);
      continue;
    }
    jobs.push({
      name,
      conversation: definition.defaultConversation,
      api: requireScenarioApi(definition, undefined),
      timeoutMs: definition.defaultTimeoutMs,
    });
  }
  return jobs;
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

    const settle = (exitCode: number): void => {
      const durationMs = Date.now() - startedAt;
      const outcome: Outcome = exitCode === 0 ? 'pass' : exitCode === 2 ? 'unsupported' : 'failure';
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
  const jobs = buildJobs();
  if (jobs.length === 0) {
    console.log('No supported scenarios to run.');
    process.exit(0);
  }
  const parallelism = resolveParallelism(jobs.length);
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
  const unsupported = results.filter(result => result.outcome === 'unsupported');
  const failures = results.filter(result => result.outcome === 'failure');
  console.log(
    `\nSummary: ${pass.length} passed, ${failures.length} failed, ${unsupported.length} unsupported (wall time ${wallSeconds}s)`
  );
  for (const result of failures)
    console.log(`failed: ${result.job.name} (exit=${result.exitCode})`);
  for (const result of unsupported) console.log(`unsupported: ${result.job.name}`);

  if (failures.length > 0) process.exit(1);
  if (unsupported.length > 0) process.exit(2);
  process.exit(0);
}

main().catch(error => {
  console.error('parallel deployed smoke driver failed:', error);
  process.exit(1);
});
