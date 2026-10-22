import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
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
const MAX_TIMER_MS = 2_147_483_647;
const sqlString = value => `'${value.replaceAll("'", "''")}'`;
const occupancyRows = z
  .array(
    z.object({ queued: z.number().int().nonnegative(), active: z.number().int().nonnegative() })
  )
  .length(1);

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
  const renewalMs = Math.floor(leaseMs / 4);
  const safetyMs = Math.min(1_000, Math.floor(leaseMs / 10));
  if (commandTimeoutMs >= leaseMs / 2 || renewalMs < 1 || safetyMs < 1) {
    throw new DeploymentError('invalid_configuration');
  }
  let attempted = false;
  let pauseToken;
  let maintenance;
  let renewal;
  const maintenanceAbort = new AbortController();
  const lossCode = () => (pauseToken === undefined ? 'lease_lost' : 'operator_pause_lost');
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
      const rows = await executeBeforeDeadline(
        `SELECT
        COUNT(CASE WHEN status = 'queued' THEN 1 END) AS queued,
        COUNT(CASE WHEN status = 'active' THEN 1 END) AS active
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
    report('started');
    await runWrangler(['deploy'], deployTimeoutMs);
    report('completed');
    phase = 'verify';
    try {
      await renew();
    } catch {
      failure = new DeploymentError(
        pauseToken === undefined
          ? 'deployed_lease_unverified'
          : 'deployed_operator_pause_unverified'
      );
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
