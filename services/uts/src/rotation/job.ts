import type { ManagerClient } from '../manager/client';
import { rotationSecretName } from '../manager/client';
import {
  type LoginName,
  type OriginPin,
  originMatches,
  POOL_LOGINS,
  ROTATION_POOLS,
  type RotationPool,
  type RotationTiming,
} from './config';
import {
  directTarget,
  type HyperdriveOrigin,
  type HyperdriveRead,
  type HyperdriveSwitch,
} from './hyperdrive';
import type { AlterResult, DirectTarget } from './postgres';
import type { JobState, RotationState, StoredRotation } from './state';
import type { Sealed } from './vault';

/** Everything the job reaches outside its own state; the rotation object wires the real ones. */
export type RotationPorts = {
  now(): number;
  /** The origin each pool's config must hold before it receives a password (`ORIGIN_PINS`). */
  pins: Readonly<Record<RotationPool, OriginPin>>;
  readConfig(pool: RotationPool): Promise<HyperdriveRead>;
  switchLogin(
    pool: RotationPool,
    current: HyperdriveOrigin,
    login: LoginName,
    password: string
  ): Promise<HyperdriveSwitch>;
  alter(
    target: DirectTarget,
    login: LoginName,
    current: string,
    pending: string
  ): Promise<AlterResult>;
  manager: Pick<
    ManagerClient,
    'createIdentityStoreSecret' | 'describeIdentityStoreSecret' | 'readLoginSeed'
  >;
  newPassword(): string;
  seal(login: LoginName, password: string): Promise<Sealed>;
  open(login: LoginName, sealed: Sealed): Promise<string>;
};

/** The stored state; `commit` replaces it only while the stored revision is still `expected`. */
export type RotationStore = {
  load(): Promise<StoredRotation>;
  commit(expected: number, next: RotationState): Promise<boolean>;
};

type Step = { state: RotationState; wait: boolean };

type Failure = { status: 'unreachable' | 'refused'; detail: string };

function log(
  level: 'log' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown>
): void {
  console[level](JSON.stringify({ event: `uts.login_rotation.${event}`, ...fields }));
}

/** A retryable failure waits `retryMs` and warns; a refusal waits `refusedRetryMs` and errors. */
function failureWait(
  failure: Failure,
  timing: RotationTiming,
  now: number,
  fields: Record<string, unknown>
): number {
  const refused = failure.status === 'refused';
  log(refused ? 'error' : 'warn', refused ? 'refused' : 'retry', {
    ...fields,
    detail: failure.detail,
  });
  return now + (refused ? timing.refusedRetryMs : timing.retryMs);
}

function withJob(state: RotationState, job: JobState): RotationState {
  return { ...state, job };
}

/** The start of the next off-peak window at or after `now`, or `now` inside one. */
export function nextSwitchWindow(now: number, timing: RotationTiming): number {
  const window = timing.offPeakUtcHours;
  if (window === null) return now;
  const hour = new Date(now).getUTCHours();
  if (hour >= window.start && hour < window.end) return now;
  const start = new Date(now);
  start.setUTCHours(window.start, 0, 0, 0);
  if (start.getTime() <= now) start.setUTCDate(start.getUTCDate() + 1);
  return start.getTime();
}

function lastSwitch(state: RotationState): number | null {
  const times = ROTATION_POOLS.flatMap(pool => state.switchedAt[pool] ?? []);
  return times.length === 0 ? null : Math.max(...times);
}

/**
 * The pool a new cycle takes: the due pool that switched longest ago (never switched counts as
 * oldest), so a pool that is due again never keeps the next one waiting.
 */
export function duePool(
  state: RotationState,
  timing: RotationTiming,
  now: number
): RotationPool | undefined {
  const [pool] = ROTATION_POOLS.filter(candidate => {
    const switched = state.switchedAt[candidate];
    return switched === undefined || now - switched >= timing.periodMs;
  }).sort((left, right) => (state.switchedAt[left] ?? -1) - (state.switchedAt[right] ?? -1));
  return pool;
}

/** Whether a run at `now` has a transition to make; the object builds no client otherwise. */
export function isDue(state: RotationState, timing: RotationTiming, now: number): boolean {
  const job = state.job;
  switch (job.phase) {
    case 'idle':
      return job.nextAttemptAt <= now && duePool(state, timing, now) !== undefined;
    case 'altering':
    case 'storing':
    case 'switching':
      return job.nextAttemptAt <= now;
    case 'awaiting_approval':
    case 'lost':
      return job.nextCheckAt <= now;
  }
}

const ORIGIN_MISMATCH: Failure = {
  status: 'refused',
  detail: 'config origin differs from the pinned origin',
};

async function startCycle(
  state: RotationState,
  ports: RotationPorts,
  timing: RotationTiming,
  now: number
): Promise<Step> {
  const pool = duePool(state, timing, now);
  if (pool === undefined) return { state, wait: true };
  const read = await ports.readConfig(pool);
  if (read.status !== 'ok') {
    const nextAttemptAt = failureWait(read, timing, now, { step: 'read_config', pool });
    return { state: withJob(state, { phase: 'idle', nextAttemptAt }), wait: true };
  }
  const [first, second] = POOL_LOGINS[pool];
  if (read.origin.user !== first && read.origin.user !== second) {
    const nextAttemptAt = failureWait(
      { status: 'refused', detail: 'config uses a login outside its pair' },
      timing,
      now,
      { step: 'read_config', pool }
    );
    return { state: withJob(state, { phase: 'idle', nextAttemptAt }), wait: true };
  }
  const login = read.origin.user === first ? second : first;
  let logins = state.logins;
  if (logins[login] === undefined) {
    // The object holds no password for the idle login: read its seed from `/db-switch/uts`.
    const seed = await ports.manager.readLoginSeed(login);
    if (seed.status !== 'present') {
      const failure: Failure =
        seed.status === 'missing'
          ? { status: 'refused', detail: 'idle login has no password and no seed' }
          : seed;
      const nextAttemptAt = failureWait(failure, timing, now, { step: 'seed', pool, login });
      return { state: withJob(state, { phase: 'idle', nextAttemptAt }), wait: true };
    }
    logins = { ...logins, [login]: await ports.seal(login, seed.value) };
    log('log', 'seed_adopted', { pool, login });
  }
  const pending = await ports.seal(login, ports.newPassword());
  log('log', 'cycle_started', { pool, login });
  return {
    state: {
      ...state,
      logins,
      job: { phase: 'altering', pool, login, startedAt: now, pending, nextAttemptAt: now },
    },
    wait: false,
  };
}

async function alter(
  state: RotationState,
  job: Extract<JobState, { phase: 'altering' }>,
  ports: RotationPorts,
  timing: RotationTiming,
  now: number
): Promise<Step> {
  const fields = { step: 'alter', pool: job.pool, login: job.login };
  const primary = await ports.readConfig('app');
  if (primary.status !== 'ok') {
    return {
      state: withJob(state, { ...job, nextAttemptAt: failureWait(primary, timing, now, fields) }),
      wait: true,
    };
  }
  // The ALTER sends the current and the pending password: only to the pinned primary.
  if (!originMatches(ports.pins.app, primary.origin)) {
    return {
      state: withJob(state, {
        ...job,
        nextAttemptAt: failureWait(ORIGIN_MISMATCH, timing, now, fields),
      }),
      wait: true,
    };
  }
  const sealedCurrent = state.logins[job.login];
  const pending = await ports.open(job.login, job.pending);
  const result: AlterResult =
    sealedCurrent === undefined
      ? { status: 'auth_failed' }
      : await ports.alter(
          directTarget(primary.origin),
          job.login,
          await ports.open(job.login, sealedCurrent),
          pending
        );
  switch (result.status) {
    case 'altered':
    case 'already_applied': {
      log('log', 'altered', { ...fields, result: result.status });
      return {
        state: {
          ...state,
          logins: { ...state.logins, [job.login]: job.pending },
          job: {
            phase: 'storing',
            pool: job.pool,
            login: job.login,
            startedAt: job.startedAt,
            secretName: rotationSecretName(job.login, new Date(now)),
            nextAttemptAt: now,
          },
        },
        wait: false,
      };
    }
    case 'auth_failed':
      log('error', 'login_lost', fields);
      return {
        state: withJob(state, {
          phase: 'lost',
          pool: job.pool,
          login: job.login,
          startedAt: job.startedAt,
          pending: job.pending,
          since: now,
          nextCheckAt: now + timing.approvalCheckMs,
        }),
        wait: true,
      };
    case 'unreachable':
    case 'refused':
      return {
        state: withJob(state, { ...job, nextAttemptAt: failureWait(result, timing, now, fields) }),
        wait: true,
      };
  }
}

async function store(
  state: RotationState,
  job: Extract<JobState, { phase: 'storing' }>,
  ports: RotationPorts,
  timing: RotationTiming,
  now: number
): Promise<Step> {
  const fields = { step: 'store', pool: job.pool, login: job.login };
  const toSwitching = (): RotationState =>
    withJob(state, {
      phase: 'switching',
      pool: job.pool,
      login: job.login,
      startedAt: job.startedAt,
      secretName: job.secretName,
      nextAttemptAt: now,
    });
  // A create whose answer was lost may have landed: describe first, so a retry never asks twice.
  const described = await ports.manager.describeIdentityStoreSecret(job.secretName);
  if (described.status === 'present') return { state: toSwitching(), wait: false };
  if (described.status !== 'missing') {
    return {
      state: withJob(state, { ...job, nextAttemptAt: failureWait(described, timing, now, fields) }),
      wait: true,
    };
  }
  const sealed = state.logins[job.login];
  if (sealed === undefined) throw new Error('a storing login holds its new password');
  const created = await ports.manager.createIdentityStoreSecret(
    job.secretName,
    await ports.open(job.login, sealed)
  );
  switch (created.status) {
    case 'created':
      log('log', 'secret_created', fields);
      return { state: toSwitching(), wait: false };
    case 'approval_pending':
      log('log', 'approval_pending', fields);
      return {
        state: withJob(state, {
          phase: 'awaiting_approval',
          pool: job.pool,
          login: job.login,
          startedAt: job.startedAt,
          secretName: job.secretName,
          requestedAt: now,
          nextCheckAt: now + timing.approvalCheckMs,
          lastAlertAt: null,
        }),
        wait: true,
      };
    case 'unreachable':
    case 'refused':
      return {
        state: withJob(state, { ...job, nextAttemptAt: failureWait(created, timing, now, fields) }),
        wait: true,
      };
  }
}

async function checkApproval(
  state: RotationState,
  job: Extract<JobState, { phase: 'awaiting_approval' }>,
  ports: RotationPorts,
  timing: RotationTiming,
  now: number
): Promise<Step> {
  const fields = { step: 'approval', pool: job.pool, login: job.login };
  const described = await ports.manager.describeIdentityStoreSecret(job.secretName);
  if (described.status === 'present') {
    log('log', 'approved', fields);
    return {
      state: withJob(state, {
        phase: 'switching',
        pool: job.pool,
        login: job.login,
        startedAt: job.startedAt,
        secretName: job.secretName,
        nextAttemptAt: now,
      }),
      wait: false,
    };
  }
  if (described.status !== 'missing') {
    const retryAt = failureWait(described, timing, now, fields);
    return {
      state: withJob(state, {
        ...job,
        nextCheckAt: Math.min(retryAt, now + timing.approvalCheckMs),
      }),
      wait: true,
    };
  }
  const waitingMs = now - job.requestedAt;
  if (waitingMs >= timing.approvalExpiryMs) {
    // A rejected or expired change request never appears: ask again under a new name with the
    // same password, which the login already has.
    log('error', 'approval_expired', { ...fields, waitingMs });
    return {
      state: withJob(state, {
        phase: 'storing',
        pool: job.pool,
        login: job.login,
        startedAt: job.startedAt,
        secretName: rotationSecretName(job.login, new Date(now)),
        nextAttemptAt: now,
      }),
      wait: false,
    };
  }
  const alertDue =
    waitingMs >= timing.approvalAlertMs &&
    (job.lastAlertAt === null || now - job.lastAlertAt >= timing.approvalAlertMs);
  if (alertDue) log('error', 'approval_overdue', { ...fields, waitingMs });
  return {
    state: withJob(state, {
      ...job,
      nextCheckAt: now + timing.approvalCheckMs,
      lastAlertAt: alertDue ? now : job.lastAlertAt,
    }),
    wait: true,
  };
}

async function switchConfig(
  state: RotationState,
  job: Extract<JobState, { phase: 'switching' }>,
  ports: RotationPorts,
  timing: RotationTiming,
  now: number
): Promise<Step> {
  const fields = { step: 'switch', pool: job.pool, login: job.login };
  const previous = lastSwitch(state);
  const spacedAt = previous === null ? now : previous + timing.switchSpacingMs;
  const allowedAt = nextSwitchWindow(Math.max(now, spacedAt), timing);
  if (allowedAt > now) {
    return { state: withJob(state, { ...job, nextAttemptAt: allowedAt }), wait: true };
  }
  const read = await ports.readConfig(job.pool);
  if (read.status !== 'ok') {
    return {
      state: withJob(state, { ...job, nextAttemptAt: failureWait(read, timing, now, fields) }),
      wait: true,
    };
  }
  // The PATCH sends the new password: only to a config that still holds its pinned origin.
  if (!originMatches(ports.pins[job.pool], read.origin)) {
    return {
      state: withJob(state, {
        ...job,
        nextAttemptAt: failureWait(ORIGIN_MISMATCH, timing, now, fields),
      }),
      wait: true,
    };
  }
  const finished = (): Step => {
    log('log', 'switched', fields);
    return {
      state: {
        ...state,
        switchedAt: { ...state.switchedAt, [job.pool]: now },
        job: { phase: 'idle', nextAttemptAt: now },
      },
      wait: true,
    };
  };
  // An earlier switch that landed before its answer was lost leaves nothing to do.
  if (read.origin.user === job.login) return finished();
  const sealed = state.logins[job.login];
  if (sealed === undefined) throw new Error('a switching login holds its new password');
  const switched = await ports.switchLogin(
    job.pool,
    read.origin,
    job.login,
    await ports.open(job.login, sealed)
  );
  if (switched.status === 'switched') return finished();
  return {
    state: withJob(state, { ...job, nextAttemptAt: failureWait(switched, timing, now, fields) }),
    wait: true,
  };
}

async function recover(
  state: RotationState,
  job: Extract<JobState, { phase: 'lost' }>,
  ports: RotationPorts,
  timing: RotationTiming,
  now: number
): Promise<Step> {
  const fields = { step: 'recover', pool: job.pool, login: job.login };
  const seed = await ports.manager.readLoginSeed(job.login);
  if (seed.status !== 'present') {
    log('error', 'login_lost', {
      ...fields,
      sinceMs: now - job.since,
      seed: seed.status === 'missing' ? 'missing' : seed.detail,
    });
    return {
      state: withJob(state, { ...job, nextCheckAt: now + timing.approvalCheckMs }),
      wait: true,
    };
  }
  // The `ALTER` tries the pending password, then this seed; a wrong seed comes back here.
  log('log', 'seed_adopted', fields);
  return {
    state: {
      ...state,
      logins: { ...state.logins, [job.login]: await ports.seal(job.login, seed.value) },
      job: {
        phase: 'altering',
        pool: job.pool,
        login: job.login,
        startedAt: job.startedAt,
        pending: job.pending,
        nextAttemptAt: now,
      },
    },
    wait: false,
  };
}

/** One transition from `state`; `wait` is true when nothing more can happen before a later run. */
export async function advance(
  state: RotationState,
  ports: RotationPorts,
  timing: RotationTiming
): Promise<Step> {
  const now = ports.now();
  const job = state.job;
  switch (job.phase) {
    case 'idle':
      return job.nextAttemptAt > now
        ? { state, wait: true }
        : await startCycle(state, ports, timing, now);
    case 'altering':
      return job.nextAttemptAt > now
        ? { state, wait: true }
        : await alter(state, job, ports, timing, now);
    case 'storing':
      return job.nextAttemptAt > now
        ? { state, wait: true }
        : await store(state, job, ports, timing, now);
    case 'awaiting_approval':
      return job.nextCheckAt > now
        ? { state, wait: true }
        : await checkApproval(state, job, ports, timing, now);
    case 'switching':
      return job.nextAttemptAt > now
        ? { state, wait: true }
        : await switchConfig(state, job, ports, timing, now);
    case 'lost':
      return job.nextCheckAt > now
        ? { state, wait: true }
        : await recover(state, job, ports, timing, now);
  }
}

/** A cycle has five transitions at most; the bound stops a run that would loop. */
const MAX_STEPS_PER_RUN = 8;

export type RunResult =
  | { status: 'ran'; phase: JobState['phase']; steps: number }
  /** Another writer committed first; this run's result was dropped and the next run starts over. */
  | { status: 'stale'; phase: JobState['phase'] };

/**
 * Runs transitions until the job waits, committing each one, so a crash resumes from the last
 * committed phase. A result whose base revision is no longer stored is dropped: a late result
 * never overwrites newer state.
 */
export async function runRotation(
  store: RotationStore,
  ports: RotationPorts,
  timing: RotationTiming
): Promise<RunResult> {
  let current = await store.load();
  let steps = 0;
  while (steps < MAX_STEPS_PER_RUN) {
    const step = await advance(current.state, ports, timing);
    if (step.state === current.state) break;
    if (!(await store.commit(current.revision, step.state))) {
      log('warn', 'stale_result', { phase: step.state.job.phase });
      return { status: 'stale', phase: step.state.job.phase };
    }
    current = { revision: current.revision + 1, state: step.state };
    steps += 1;
    if (step.wait) break;
  }
  return { status: 'ran', phase: current.state.job.phase, steps };
}
