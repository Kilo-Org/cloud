import { spawn } from 'node:child_process';

export const BACKOFF_INITIAL_MS = 1_000;
export const BACKOFF_MAX_MS = 300_000;
export const BACKOFF_MULTIPLIER = 2;
export const HEALTHY_THRESHOLD_MS = 30_000;
export const SHUTDOWN_TIMEOUT_MS = 10_000;

export type SupervisorState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed'
  | 'shutting_down';

export type SupervisorLastExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: string;
};

export type SupervisorStats = {
  state: SupervisorState;
  pid: number | null;
  uptime: number;
  restarts: number;
  lastExit: SupervisorLastExit | null;
};

export type Supervisor = {
  start: () => Promise<boolean>;
  stop: () => Promise<boolean>;
  restart: () => Promise<boolean>;
  shutdown: (signal?: NodeJS.Signals) => Promise<void>;
  getState: () => SupervisorState;
  getStats: () => SupervisorStats;
};

type SpawnLike = typeof spawn;

type TimerLike = ReturnType<typeof setTimeout>;

type SupervisorOptions = {
  gatewayArgs: string[];
  command?: string;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  backoffMultiplier?: number;
  healthyThresholdMs?: number;
  shutdownTimeoutMs?: number;
  now?: () => number;
  spawnImpl?: SpawnLike;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

export function createSupervisor(options: SupervisorOptions): Supervisor {
  const {
    gatewayArgs,
    command = 'openclaw',
    backoffInitialMs = BACKOFF_INITIAL_MS,
    backoffMaxMs = BACKOFF_MAX_MS,
    backoffMultiplier = BACKOFF_MULTIPLIER,
    healthyThresholdMs = HEALTHY_THRESHOLD_MS,
    shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
    now = () => Date.now(),
    spawnImpl = spawn,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = options;

  let state: SupervisorState = 'stopped';
  let child: ReturnType<SpawnLike> | null = null;
  let restartTimer: TimerLike | null = null;
  let backoffMs = backoffInitialMs;
  let runningSinceMs: number | null = null;
  let restarts = 0;
  let lastExit: SupervisorLastExit | null = null;
  let stopRequested = false;
  let manualStop = false;
  let shuttingDown = false;

  let childExitPromise: Promise<void> | null = null;
  let resolveChildExit: (() => void) | null = null;
  let opQueue: Promise<void> = Promise.resolve();

  const clearRestartTimer = () => {
    if (restartTimer) {
      clearTimeoutImpl(restartTimer);
      restartTimer = null;
    }
  };

  const resetBackoff = () => {
    backoffMs = backoffInitialMs;
  };

  const resolveExitWaiters = () => {
    if (resolveChildExit) {
      resolveChildExit();
      resolveChildExit = null;
    }
    childExitPromise = null;
  };

  const scheduleRestart = () => {
    if (shuttingDown || manualStop) {
      return;
    }
    const delay = backoffMs;
    restartTimer = setTimeoutImpl(() => {
      restartTimer = null;
      if (shuttingDown || manualStop) {
        return;
      }
      void spawnGateway();
    }, delay);
    backoffMs = Math.min(backoffMaxMs, Math.floor(backoffMs * backoffMultiplier));
  };

  const handleChildExit = (
    exitedChild: ReturnType<SpawnLike>,
    code: number | null,
    signal: NodeJS.Signals | null
  ) => {
    if (child !== exitedChild) {
      return;
    }

    const runtimeMs = runningSinceMs === null ? 0 : now() - runningSinceMs;
    if (runtimeMs >= healthyThresholdMs) {
      resetBackoff();
    }

    lastExit = {
      code,
      signal,
      at: new Date().toISOString(),
    };

    child = null;
    runningSinceMs = null;
    resolveExitWaiters();

    if (shuttingDown) {
      state = 'shutting_down';
      stopRequested = false;
      return;
    }

    if (stopRequested || manualStop) {
      state = 'stopped';
      stopRequested = false;
      return;
    }

    state = 'crashed';
    restarts += 1;
    scheduleRestart();
  };

  const spawnGateway = async (): Promise<void> => {
    if (child || shuttingDown || manualStop) {
      return;
    }

    state = 'starting';
    stopRequested = false;

    const spawned = spawnImpl(command, ['gateway', ...gatewayArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    child = spawned;
    childExitPromise = new Promise(resolve => {
      resolveChildExit = resolve;
    });

    spawned.stdout?.pipe(process.stdout);
    spawned.stderr?.pipe(process.stderr);

    spawned.once('spawn', () => {
      if (child !== spawned) return;
      runningSinceMs = now();
      state = 'running';
    });

    spawned.once('error', err => {
      console.error('[controller] Failed to spawn openclaw gateway:', err);
      handleChildExit(spawned, 1, null);
    });

    spawned.once('exit', (code, signal) => {
      handleChildExit(spawned, code, signal);
    });
  };

  const stopInternal = async (manual: boolean): Promise<boolean> => {
    if (manual) {
      manualStop = true;
    }
    clearRestartTimer();

    if (!child) {
      if (!shuttingDown) {
        state = 'stopped';
      }
      return false;
    }

    const currentChild = child;
    stopRequested = true;
    if (!shuttingDown) {
      state = 'stopping';
    }

    currentChild.kill('SIGTERM');
    await (childExitPromise ?? Promise.resolve());

    if (!shuttingDown) {
      state = 'stopped';
    }
    return true;
  };

  const startInternal = async (): Promise<boolean> => {
    if (shuttingDown || state === 'shutting_down') {
      return false;
    }
    if (state === 'running' || state === 'starting' || state === 'stopping') {
      return false;
    }
    manualStop = false;
    clearRestartTimer();
    resetBackoff();
    await spawnGateway();
    return true;
  };

  const restartInternal = async (): Promise<boolean> => {
    if (shuttingDown || state === 'shutting_down') {
      return false;
    }
    manualStop = false;
    clearRestartTimer();
    resetBackoff();
    await stopInternal(false);
    await spawnGateway();
    return true;
  };

  const shutdownInternal = async (signal: NodeJS.Signals): Promise<void> => {
    shuttingDown = true;
    manualStop = true;
    state = 'shutting_down';
    clearRestartTimer();

    if (!child) {
      return;
    }

    const currentChild = child;
    stopRequested = true;
    currentChild.kill(signal);

    await Promise.race([
      childExitPromise ?? Promise.resolve(),
      new Promise<void>(resolve => {
        setTimeoutImpl(() => resolve(), shutdownTimeoutMs);
      }),
    ]);

    if (child === currentChild) {
      currentChild.kill('SIGKILL');
      await (childExitPromise ?? Promise.resolve());
    }
  };

  const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = opQueue.then(fn, fn);
    opQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  return {
    start: () => runExclusive(startInternal),
    stop: () => runExclusive(() => stopInternal(true)),
    restart: () => runExclusive(restartInternal),
    shutdown: (signal = 'SIGTERM') => runExclusive(() => shutdownInternal(signal)),
    getState: () => state,
    getStats: () => ({
      state,
      pid: child?.pid ?? null,
      uptime: runningSinceMs === null ? 0 : Math.floor((now() - runningSinceMs) / 1000),
      restarts,
      lastExit,
    }),
  };
}
