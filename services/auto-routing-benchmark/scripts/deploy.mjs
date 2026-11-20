import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse as parseJsonc } from 'jsonc-parser';
import { z } from 'zod';

const directory = fileURLToPath(new URL('..', import.meta.url));
const config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const token = randomUUID();
const abort = new AbortController();
const startedAt = Date.now();
let phase = 'configuration';
let failure;
let deadlineTimer;
const transientRenewalFailures = new Set([
  'command_failed',
  'command_start_failed',
  'command_timeout',
  'invalid_d1_response',
]);

class DeploymentError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function report(event, fields = {}) {
  console.log(
    JSON.stringify({
      event: `benchmark_deploy_${event}`,
      phase,
      elapsedMs: Date.now() - startedAt,
      ...fields,
    })
  );
}

function stop(code) {
  failure ??= new DeploymentError(code);
  abort.abort();
}

function duration(name, fallback) {
  const raw = process.env[`BENCHMARK_DEPLOY_${name}_MS`];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new DeploymentError('invalid_configuration');
  }
  return value;
}

function runWrangler(args, timeoutMs, signal = abort.signal, capture = false) {
  if (signal.aborted) return Promise.reject(failure ?? new DeploymentError('interrupted'));
  return new Promise((resolve, reject) => {
    const child = spawn('wrangler', ['--config', config, '--env', '', ...args], {
      cwd: directory,
      env: { ...process.env, CI: '1', CLOUDFLARE_ENV: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let commandFailure;
    let killTimer;
    const terminate = code => {
      commandFailure ??= new DeploymentError(code);
      const kill = signalName => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signalName);
        } catch (error) {
          if (error?.code !== 'ESRCH') child.kill(signalName);
        }
      };
      kill('SIGTERM');
      killTimer ??= setTimeout(() => kill('SIGKILL'), 250);
    };
    const onAbort = () => terminate(failure?.code ?? 'interrupted');
    const timer = setTimeout(() => terminate('command_timeout'), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (!capture) return;
      if (stdout.length + chunk.length > 1_048_576) terminate('invalid_d1_response');
      else stdout += chunk;
    });
    child.stderr.resume();
    child.on('error', () => {
      commandFailure ??= new DeploymentError('command_start_failed');
    });
    child.on('close', code => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      if (commandFailure) reject(commandFailure);
      else if (code !== 0) reject(new DeploymentError('command_failed'));
      else resolve(stdout);
    });
  });
}

const d1Response = z
  .array(z.object({ success: z.literal(true), results: z.array(z.unknown()) }))
  .length(1);
const leaseRows = z.array(z.object({ lease_until: z.number().int().positive() })).max(1);
const ownerRows = z
  .array(z.object({ token: z.string().nullable(), lease_until: z.number().int() }))
  .max(1);
const OPERATOR_PAUSE_PREFIX = 'operator-pause-';
const CONTAINER_INPUTS_PREFIX = 'container-inputs:';
const MAX_TIMER_MS = 2_147_483_647;
const sqlString = value => `'${value.replaceAll("'", "''")}'`;
const occupancyRows = z
  .array(
    z.object({
      queued: z.number().int().nonnegative(),
      active: z.number().int().nonnegative(),
      expired: z.number().int().nonnegative(),
    })
  )
  .length(1);
const workerConfig = z.object({
  name: z.string().min(1),
  containers: z
    .array(
      z
        .object({
          class_name: z.string().min(1),
          name: z.string().min(1).optional(),
          image: z.string().min(1),
          image_build_context: z.string().min(1).optional(),
        })
        .passthrough()
    )
    .min(1),
});
const isoTime = z
  .string()
  .transform(value => Date.parse(value))
  .pipe(z.number().finite());
const workerDeployments = z.array(
  z.object({
    created_on: isoTime,
    versions: z.array(z.object({ version_id: z.string().min(1), percentage: z.number() })),
  })
);
const workerVersion = z.object({
  annotations: z.object({ 'workers/message': z.string().optional() }).passthrough().optional(),
});
const containerApplications = z.array(
  z.object({ id: z.string().min(1), name: z.string(), updated_at: isoTime })
);
const containerApplication = z.object({ active_rollout_id: z.string().nullish() });

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function filesUnder(root) {
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  return entries.flatMap(entry => {
    const path = join(root, entry.name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/**
 * Hashes everything `wrangler deploy` turns into the container application: the
 * `containers` configuration and every file in each local image's build context.
 */
function containerInputs() {
  const errors = [];
  const parsed = workerConfig.safeParse(
    parseJsonc(readFileSync(config, 'utf8'), errors, { allowTrailingComma: true })
  );
  if (errors.length > 0 || !parsed.success) throw new DeploymentError('invalid_configuration');
  const hash = createHash('sha256').update(canonicalJson(parsed.data.containers));
  const base = dirname(config);
  for (const container of parsed.data.containers) {
    const image = resolve(base, container.image);
    if (!existsSync(image)) continue;
    const context = container.image_build_context
      ? resolve(base, container.image_build_context)
      : dirname(image);
    for (const file of filesUnder(context)) {
      const content = readFileSync(file);
      hash.update(`\0${relative(base, file)}\0${content.length}\0`).update(content);
    }
  }
  return {
    hash: hash.digest('hex'),
    applications: new Set(
      parsed.data.containers.map(
        container => container.name ?? `${parsed.data.name}-${container.class_name}`
      )
    ),
  };
}

async function execute(sql, timeoutMs, signal = abort.signal) {
  const stdout = await runWrangler(
    ['d1', 'execute', 'BENCH_DB', '--remote', '--json', '--command', sql],
    timeoutMs,
    signal,
    true
  );
  try {
    return d1Response.parse(JSON.parse(stdout))[0].results;
  } catch {
    throw new DeploymentError('invalid_d1_response');
  }
}

async function deploy() {
  if (process.argv.length !== 2) throw new DeploymentError('unsupported_arguments');
  const lockTimeoutMs = duration('LOCK_TIMEOUT', 60_000);
  const drainTimeoutMs = duration('DRAIN_TIMEOUT', 1_200_000);
  const leaseMs = duration('LEASE', 120_000);
  const pollMs = duration('POLL_INTERVAL', 5_000);
  const commandTimeoutMs = duration('COMMAND_TIMEOUT', 30_000);
  const migrationTimeoutMs = duration('MIGRATION_TIMEOUT', 300_000);
  const deployTimeoutMs = duration('DEPLOY_TIMEOUT', 600_000);
  const rolloutTimeoutMs = duration('ROLLOUT_TIMEOUT', 900_000);
  const renewalMs = Math.floor(leaseMs / 4);
  const safetyMs = Math.min(1_000, Math.floor(leaseMs / 10));
  if (commandTimeoutMs >= leaseMs / 2 || renewalMs < 1 || safetyMs < 1) {
    throw new DeploymentError('invalid_configuration');
  }
  const inputs = containerInputs();
  let attempted = false;
  let deployed = false;
  let pauseToken;
  let maintenance;
  let renewal;
  const maintenanceAbort = new AbortController();
  const lossCode = () => {
    if (pauseToken === undefined) return deployed ? 'deployed_lease_unverified' : 'lease_lost';
    return deployed ? 'deployed_operator_pause_unverified' : 'operator_pause_lost';
  };
  const acceptLease = rows => {
    const parsed = leaseRows.safeParse(rows);
    if (!parsed.success) throw new DeploymentError('invalid_d1_response');
    const until = parsed.data[0]?.lease_until;
    if (until === undefined) return false;
    const remainingMs = until - Date.now() - safetyMs;
    if (remainingMs <= 0) throw new DeploymentError(lossCode());
    clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(() => stop(lossCode()), Math.min(remainingMs, MAX_TIMER_MS));
    return true;
  };
  const renewOnce = async () => {
    const now = Date.now();
    const sql =
      pauseToken === undefined
        ? `UPDATE scheduler_dispatch_lock SET lease_until = ${now + leaseMs}
        WHERE id = 1 AND token = '${token}' AND lease_until > ${now} RETURNING lease_until`
        : `SELECT lease_until FROM scheduler_dispatch_lock
        WHERE id = 1 AND token = ${sqlString(pauseToken)} AND lease_until > ${now}`;
    if (!acceptLease(await execute(sql, commandTimeoutMs))) throw new DeploymentError(lossCode());
  };
  const renew = () => {
    renewal ??= (async () => {
      while (true) {
        if (abort.signal.aborted) throw failure;
        try {
          await renewOnce();
          report(pauseToken === undefined ? 'lease_renewed' : 'operator_pause_retained');
          return;
        } catch (error) {
          if (
            abort.signal.aborted ||
            !(error instanceof DeploymentError) ||
            !transientRenewalFailures.has(error.code)
          ) {
            throw error;
          }
          report('lease_renewal_retry', { reason: error.code });
          await sleep(Math.min(pollMs, renewalMs), undefined, { signal: abort.signal });
        }
      }
    })()
      .catch(error => {
        if (!maintenanceAbort.signal.aborted) stop(lossCode());
        throw failure ?? error;
      })
      .finally(() => {
        renewal = undefined;
      });
    return renewal;
  };
  const executeBeforeDeadline = async (sql, deadline, reason) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new DeploymentError(reason);
    try {
      return await execute(sql, Math.min(commandTimeoutMs, remainingMs));
    } catch (error) {
      if (
        error instanceof DeploymentError &&
        error.code === 'command_timeout' &&
        Date.now() >= deadline
      ) {
        throw new DeploymentError(reason);
      }
      throw error;
    }
  };
  const readJson = async (args, schema, timeoutMs) => {
    try {
      const parsed = schema.safeParse(
        JSON.parse(await runWrangler(args, timeoutMs, abort.signal, true))
      );
      return parsed.success ? parsed.data : undefined;
    } catch (error) {
      if (abort.signal.aborted) throw failure ?? error;
      return undefined;
    }
  };
  const trackedApplications = async timeoutMs => {
    const applications = await readJson(
      ['containers', 'list', '--json'],
      containerApplications,
      timeoutMs
    );
    if (applications === undefined) return undefined;
    const tracked = applications.filter(application => inputs.applications.has(application.name));
    return tracked.length === inputs.applications.size ? tracked : null;
  };
  /**
   * The container inputs the running containers were last rolled out from: the
   * marker of the Worker version that was live when the container application last
   * changed. A deploy whose image build, push or rollout never reached the
   * application leaves it unchanged, so its marker is never trusted. Anything
   * unreadable or ambiguous is unknown.
   */
  const rolledOutContainerInputs = async () => {
    const tracked = await trackedApplications(commandTimeoutMs);
    if (!tracked) return undefined;
    const changedAt = Math.min(...tracked.map(application => application.updated_at));
    const deployments = await readJson(
      ['deployments', 'list', '--json'],
      workerDeployments,
      commandTimeoutMs
    );
    const live = deployments
      ?.filter(deployment => deployment.created_on <= changedAt)
      .sort((a, b) => b.created_on - a.created_on)[0];
    if (live?.versions.length !== 1 || live.versions[0].percentage !== 100) return undefined;
    const version = await readJson(
      ['versions', 'view', live.versions[0].version_id, '--json'],
      workerVersion,
      commandTimeoutMs
    );
    const message = version?.annotations?.['workers/message'];
    return message?.startsWith(CONTAINER_INPUTS_PREFIX)
      ? message.slice(CONTAINER_INPUTS_PREFIX.length)
      : undefined;
  };
  const rollingApplications = async timeoutMs => {
    const tracked = await trackedApplications(timeoutMs);
    if (!tracked) return tracked;
    let rolling = 0;
    for (const application of tracked) {
      const state = await readJson(
        ['containers', 'info', application.id, '--json'],
        containerApplication,
        timeoutMs
      );
      if (state === undefined) return undefined;
      if (state.active_rollout_id) rolling += 1;
    }
    return rolling;
  };
  const awaitRollout = async () => {
    const deadline = Date.now() + rolloutTimeoutMs;
    while (true) {
      if (abort.signal.aborted) throw failure;
      const remainingMs = deadline - Date.now();
      const rolling =
        remainingMs > 0
          ? await rollingApplications(Math.min(commandTimeoutMs, remainingMs))
          : undefined;
      if (rolling === null) {
        report('rollout_unobservable');
        return;
      }
      report('rollout_progress', { rolling: rolling ?? null });
      if (rolling === 0) return;
      if (Date.now() >= deadline) {
        report('rollout_wait_timeout');
        return;
      }
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())), undefined, {
        signal: abort.signal,
      });
    }
  };
  try {
    phase = 'lock';
    report('waiting_for_lock', { timeoutMs: lockTimeoutMs });
    const lockDeadline = Date.now() + lockTimeoutMs;
    while (true) {
      if (Date.now() >= lockDeadline) throw new DeploymentError('lock_timeout');
      const now = Date.now();
      attempted = true;
      const rows = await executeBeforeDeadline(
        `INSERT INTO scheduler_dispatch_lock (id, token, lease_until)
        VALUES (1, '${token}', ${now + leaseMs})
        ON CONFLICT (id) DO UPDATE SET token = excluded.token, lease_until = excluded.lease_until
        WHERE scheduler_dispatch_lock.lease_until <= ${now} RETURNING lease_until`,
        lockDeadline,
        'lock_timeout'
      );
      if (acceptLease(rows)) break;
      const owner = ownerRows.safeParse(
        await executeBeforeDeadline(
          'SELECT token, lease_until FROM scheduler_dispatch_lock WHERE id = 1',
          lockDeadline,
          'lock_timeout'
        )
      );
      if (!owner.success) throw new DeploymentError('invalid_d1_response');
      const current = owner.data[0];
      if (current?.token?.startsWith(OPERATOR_PAUSE_PREFIX) && current.lease_until > Date.now()) {
        pauseToken = current.token;
        acceptLease([{ lease_until: current.lease_until }]);
        break;
      }
      report('lock_contended');
      await sleep(Math.min(pollMs, Math.max(1, lockDeadline - Date.now())), undefined, {
        signal: abort.signal,
      });
    }
    report(pauseToken === undefined ? 'lock_acquired' : 'operator_pause_retained');
    maintenance = (async () => {
      while (!maintenanceAbort.signal.aborted) {
        try {
          await sleep(renewalMs, undefined, { signal: maintenanceAbort.signal });
          await renew();
        } catch {
          if (!maintenanceAbort.signal.aborted) stop(lossCode());
          break;
        }
      }
    })();
    phase = 'drain';
    const drainDeadline = Date.now() + drainTimeoutMs;
    while (true) {
      if (abort.signal.aborted) throw failure;
      const now = Date.now();
      const rows = await executeBeforeDeadline(
        `SELECT
        COUNT(CASE WHEN status = 'queued' AND lease_until > ${now} THEN 1 END) AS queued,
        COUNT(CASE WHEN status = 'active' THEN 1 END) AS active,
        COUNT(CASE WHEN status = 'queued' AND lease_until <= ${now} THEN 1 END) AS expired
        FROM scheduler_chunks WHERE status IN ('queued', 'active')`,
        drainDeadline,
        'drain_timeout'
      );
      const parsed = occupancyRows.safeParse(rows);
      if (!parsed.success) throw new DeploymentError('invalid_d1_response');
      const [occupancy] = parsed.data;
      report('drain_progress', occupancy);
      if (occupancy.queued === 0 && occupancy.active === 0) break;
      if (Date.now() >= drainDeadline) throw new DeploymentError('drain_timeout');
      await sleep(Math.min(pollMs, Math.max(1, drainDeadline - Date.now())), undefined, {
        signal: abort.signal,
      });
    }
    await renew();
    phase = 'migrations';
    report('started');
    await runWrangler(['d1', 'migrations', 'apply', 'BENCH_DB', '--remote'], migrationTimeoutMs);
    report('completed');
    await renew();
    phase = 'deploy';
    const rolledOut = await rolledOutContainerInputs();
    const unchanged = rolledOut === inputs.hash;
    report('container_inputs', {
      inputs: inputs.hash,
      deployed: rolledOut === undefined ? 'unknown' : unchanged ? 'unchanged' : 'changed',
    });
    const deployArgs = ['deploy', '--message', `${CONTAINER_INPUTS_PREFIX}${inputs.hash}`];
    report('started', { containersRollout: unchanged ? 'none' : 'configured' });
    if (unchanged) {
      try {
        await runWrangler([...deployArgs, '--containers-rollout', 'none'], deployTimeoutMs);
      } catch (error) {
        if (
          abort.signal.aborted ||
          !(error instanceof DeploymentError) ||
          error.code !== 'command_failed'
        ) {
          throw error;
        }
        report('rollout_skip_failed');
        await renew();
        await runWrangler(deployArgs, deployTimeoutMs);
      }
    } else {
      await runWrangler(deployArgs, deployTimeoutMs);
    }
    report('completed');
    deployed = true;
    phase = 'rollout';
    await awaitRollout();
    phase = 'verify';
    // A renewal that started before this point already observed the earlier
    // lock. Wait it out, then start a new renewal so the final read is fresh
    // and still retries transient D1 failures.
    await renewal?.catch(() => {});
    try {
      await renew();
    } catch {
      failure = new DeploymentError(lossCode());
      throw failure;
    }
    report(
      pauseToken === undefined ? 'lease_held_through_deploy' : 'operator_pause_held_through_deploy'
    );
  } catch (error) {
    failure ??= error instanceof DeploymentError ? error : new DeploymentError('deployment_failed');
    throw failure;
  } finally {
    const finishedPhase = phase;
    maintenanceAbort.abort();
    abort.abort();
    await maintenance;
    await renewal?.catch(() => {});
    clearTimeout(deadlineTimer);
    if (attempted && pauseToken === undefined) {
      phase = 'release';
      try {
        const rows = await execute(
          `UPDATE scheduler_dispatch_lock SET token = NULL, lease_until = 0
          WHERE id = 1 AND token = '${token}' RETURNING id`,
          commandTimeoutMs,
          new AbortController().signal
        );
        report(rows.length === 1 ? 'lock_released' : 'lock_not_owned');
      } catch {
        report('release_failed', { recovery: 'lease_expiry' });
        failure ??= new DeploymentError('release_failed');
      }
    }
    phase = finishedPhase;
  }
  if (failure) throw failure;
}

const onSignal = () => stop('interrupted');
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);
try {
  await deploy();
} catch (error) {
  report('failed', {
    reason: failure?.code ?? (error instanceof DeploymentError ? error.code : 'deployment_failed'),
  });
  process.exitCode = 1;
} finally {
  clearTimeout(deadlineTimer);
  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);
}
