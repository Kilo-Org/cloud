import { spawn, type ChildProcess } from 'node:child_process';
import type { Hono } from 'hono';
import { z } from 'zod';
import { timingSafeTokenEqual } from '../auth';
import { getBearerToken } from './gateway';

// ── Types ─────────────────────────────────────────────────────────────

type DoctorRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

type DoctorRunState = {
  process: ChildProcess;
  output: string;
  status: DoctorRunStatus;
  exitCode: number | null;
  fix: boolean;
  startedAt: string;
  completedAt: string | null;
  timedOut: boolean;
  /** Set when the child emits `close` or `error`; the SIGKILL timer is a no-op after this. */
  terminated: boolean;
  completed: Promise<void>;
  resolveCompleted: () => void;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
};

// ── Constants ─────────────────────────────────────────────────────────

/** Cap output buffer at ~1MB to prevent OOM from verbose doctor runs. */
const MAX_OUTPUT_BYTES = 1_048_576;

/** Hard cap on a single doctor invocation. */
const DOCTOR_TIMEOUT_MS = 120_000;

/** Time between SIGTERM and SIGKILL on timeout or client disconnect. */
const SIGTERM_GRACE_MS = 5_000;

// ── Module-level state (one run at a time per machine) ────────────────

let activeRun: DoctorRunState | null = null;
let startQueue: Promise<void> = Promise.resolve();

// ── Request schemas ───────────────────────────────────────────────────

const DoctorRunBodySchema = z.object({
  fix: z.boolean().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────

function appendOutput(run: DoctorRunState, chunk: string): void {
  run.output += chunk;
  if (run.output.length > MAX_OUTPUT_BYTES) {
    const truncateAt = run.output.length - MAX_OUTPUT_BYTES;
    run.output = '… [output truncated] …\n' + run.output.slice(truncateAt);
  }
}

function finalizeRun(run: DoctorRunState, exitCode: number | null, status: DoctorRunStatus): void {
  if (run.status !== 'running') return;
  run.exitCode = exitCode;
  run.status = status;
  run.completedAt = new Date().toISOString();
  if (run.timeoutTimer) {
    clearTimeout(run.timeoutTimer);
    run.timeoutTimer = null;
  }
  // Intentionally do NOT clear killTimer here — after SIGTERM we still need
  // the SIGKILL grace timer to fire if the child ignores the signal.
  run.resolveCompleted();
}

function scheduleSigkill(run: DoctorRunState): void {
  if (run.killTimer) return;
  run.killTimer = setTimeout(() => {
    if (!run.terminated) {
      try {
        run.process.kill('SIGKILL');
      } catch {
        // Child may already be gone — ignore.
      }
    }
  }, SIGTERM_GRACE_MS);
}

/**
 * Chain each start attempt behind the previous one so two concurrent POSTs
 * can never both observe `activeRun === null` and race into a double-spawn.
 *
 * Copied from routes/kilo-cli-run.ts — `then(fn, fn)` ensures the next attempt
 * runs regardless of whether the previous one resolved or rejected.
 */
function runStartExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = startQueue.then(fn, fn);
  startQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

// ── Route registration ────────────────────────────────────────────────

export function registerDoctorRoutes(app: Hono, expectedToken: string): void {
  app.use('/_kilo/doctor/*', async (c, next) => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  // POST /_kilo/doctor/run — synchronous buffered `openclaw doctor` invocation.
  // Blocks until the child exits (or the 120s cap trips, or the client aborts).
  app.post('/_kilo/doctor/run', async c => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      // An empty body is valid (fix defaults to true; see coalesce below).
      body = {};
    }

    const parsed = DoctorRunBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body', details: z.treeifyError(parsed.error) }, 400);
    }

    // Default is `true` to match the Fly-exec flow (which always passed --fix)
    // and the admin UI checkbox default. Explicit `false` opts into read-only
    // diagnostics.
    const fix = parsed.data.fix ?? true;

    const run = await runStartExclusive(async () => {
      if (activeRun?.status === 'running') {
        return null;
      }

      const args = ['doctor', ...(fix ? ['--fix'] : []), '--non-interactive'];

      // Use the same env as the supervisor spawns `openclaw gateway` with
      // (supervisor.ts:186-188). Bootstrap has already decrypted KILOCLAW_ENC_*
      // vars into plaintext env, so doctor sees identical KILOCODE_API_KEY,
      // OPENCLAW_GATEWAY_TOKEN, channel tokens, etc. as the live gateway.
      const child = spawn('openclaw', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      let resolveCompleted!: () => void;
      const completed = new Promise<void>(resolve => {
        resolveCompleted = resolve;
      });

      const newRun: DoctorRunState = {
        process: child,
        output: '',
        status: 'running',
        exitCode: null,
        fix,
        startedAt: new Date().toISOString(),
        completedAt: null,
        timedOut: false,
        terminated: false,
        completed,
        resolveCompleted,
        timeoutTimer: null,
        killTimer: null,
      };

      activeRun = newRun;

      child.stdout?.on('data', (chunk: Buffer | string) => {
        appendOutput(newRun, typeof chunk === 'string' ? chunk : chunk.toString());
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        appendOutput(newRun, typeof chunk === 'string' ? chunk : chunk.toString());
      });

      child.once('error', err => {
        console.error('[doctor] Process error:', err.message);
        newRun.terminated = true;
        if (newRun.status === 'running') {
          appendOutput(newRun, `\n[process error: ${err.message}]\n`);
          finalizeRun(newRun, null, 'failed');
        }
      });

      child.once('close', (code, signal) => {
        newRun.terminated = true;
        if (newRun.status !== 'running') return; // already handled
        console.log(`[doctor] Process exited: code=${code} signal=${signal}`);
        const nextStatus: DoctorRunStatus = code === 0 ? 'completed' : 'failed';
        finalizeRun(newRun, code, nextStatus);
      });

      newRun.timeoutTimer = setTimeout(() => {
        if (newRun.status !== 'running') return;
        console.warn('[doctor] Run timed out after 120s, sending SIGTERM');
        appendOutput(newRun, '\n[doctor timed out after 120s]\n');
        newRun.timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore: child may already be gone.
        }
        scheduleSigkill(newRun);
        // Finalize immediately so the awaiting request unblocks; the SIGKILL
        // timer will still fire if needed to reap the process.
        finalizeRun(newRun, null, 'timed_out');
      }, DOCTOR_TIMEOUT_MS);

      console.log(`[doctor] Started: pid=${child.pid}, fix=${fix}`);
      return newRun;
    });

    if (run === null) {
      return c.json(
        {
          code: 'openclaw_doctor_already_active',
          error: 'An openclaw doctor run is already in progress',
        },
        409
      );
    }

    // Client-disconnect abort: SIGTERM the child if the caller drops.
    // c.req.raw.signal is the AbortSignal plumbed through handleHttpRequest
    // from the underlying node req's 'close' event.
    const onAbort = () => {
      if (run.status !== 'running') return;
      console.warn('[doctor] Client disconnected, cancelling run');
      appendOutput(run, '\n[cancelled by client disconnect]\n');
      try {
        run.process.kill('SIGTERM');
      } catch {
        // Ignore: child may already be gone.
      }
      scheduleSigkill(run);
      finalizeRun(run, null, 'cancelled');
    };

    const signal = c.req.raw.signal;
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      await run.completed;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    const completedAt = run.completedAt;
    if (completedAt === null) {
      // finalizeRun is invoked on every path that resolves `run.completed`, so
      // this branch is unreachable — the explicit check narrows the type.
      throw new Error('doctor: completedAt not set after run completion');
    }

    return c.json(
      {
        ok: run.status === 'completed',
        status: run.status,
        fix: run.fix,
        output: run.output,
        exitCode: run.exitCode,
        startedAt: run.startedAt,
        completedAt,
        timedOut: run.timedOut,
      },
      200
    );
  });
}

/** Exported for testing. */
export function _getActiveRun(): DoctorRunState | null {
  return activeRun;
}

/** Exported for testing. */
export function _resetActiveRun(): void {
  activeRun = null;
}

/** Exported for testing. */
export function _resetStartQueue(): void {
  startQueue = Promise.resolve();
}
