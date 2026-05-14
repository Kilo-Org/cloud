import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import { timingSafeTokenEqual } from '../auth';
import { atomicWrite } from '../atomic-write';
import { getBearerToken } from './gateway';

// ── Types ─────────────────────────────────────────────────────────────

type DoctorRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

type DoctorRunMetadata = {
  hasRun: true;
  runId: string;
  status: DoctorRunStatus;
  fix: boolean;
  exitCode: number | null;
  startedAt: string;
  completedAt: string | null;
  timedOut: boolean;
  outputBytes: number;
  outputTruncated: boolean;
};

type DoctorRunStatusResponse = {
  hasRun: boolean;
  runId: string | null;
  status: DoctorRunStatus | null;
  fix: boolean | null;
  output: string | null;
  outputBytes: number;
  outputTruncated: boolean;
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  timedOut: boolean;
};

type ActiveRun = {
  process: ChildProcess;
  runId: string;
  outputBytes: number;
  outputTruncated: boolean;
  finalStatus: DoctorRunStatus | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
  metadataFlushTimer: ReturnType<typeof setTimeout> | null;
  terminated: boolean;
};

// ── Constants ─────────────────────────────────────────────────────────

let DOCTOR_RUN_DIR = '/root/.openclaw/.kiloclaw/doctor-runs';
let METADATA_PATH = path.join(DOCTOR_RUN_DIR, 'current.json');
let LOG_PATH = path.join(DOCTOR_RUN_DIR, 'current.log');

/** Cap output at ~1MB to prevent unbounded persistent logs. */
const MAX_OUTPUT_BYTES = 1_048_576;

/** Hard cap on a single doctor invocation. */
const DOCTOR_TIMEOUT_MS = 120_000;

/** Time between SIGTERM and SIGKILL on timeout or explicit cancel. */
const SIGTERM_GRACE_MS = 5_000;

const OUTPUT_TRUNCATED_MARKER = '… [output truncated] …\n';
const METADATA_FLUSH_INTERVAL_MS = 1_000;

// ── Module-level state (one run at a time per machine) ────────────────

let activeRun: ActiveRun | null = null;
let startQueue: Promise<void> = Promise.resolve();

// ── Request schemas ───────────────────────────────────────────────────

const DoctorRunBodySchema = z.object({
  fix: z.boolean().optional(),
});

const DoctorRunMetadataSchema = z.object({
  hasRun: z.literal(true),
  runId: z.string().min(1),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'timed_out']),
  fix: z.boolean(),
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  timedOut: z.boolean(),
  outputBytes: z.number().int().min(0),
  outputTruncated: z.boolean(),
});

// ── Helpers ───────────────────────────────────────────────────────────

function configureDoctorRunPaths(runDir: string): void {
  DOCTOR_RUN_DIR = runDir;
  METADATA_PATH = path.join(DOCTOR_RUN_DIR, 'current.json');
  LOG_PATH = path.join(DOCTOR_RUN_DIR, 'current.log');
}

function ensureRunDir(): void {
  fs.mkdirSync(DOCTOR_RUN_DIR, { recursive: true });
}

function noRunStatus(): DoctorRunStatusResponse {
  return {
    hasRun: false,
    runId: null,
    status: null,
    fix: null,
    output: null,
    outputBytes: 0,
    outputTruncated: false,
    exitCode: null,
    startedAt: null,
    completedAt: null,
    timedOut: false,
  };
}

function writeMetadata(metadata: DoctorRunMetadata): void {
  ensureRunDir();
  atomicWrite(METADATA_PATH, JSON.stringify(metadata, null, 2) + '\n');
}

function readMetadata(): DoctorRunMetadata | null {
  try {
    const raw = fs.readFileSync(METADATA_PATH, 'utf8');
    const parsed = DoctorRunMetadataSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.data;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    console.warn(
      '[doctor] Failed to read metadata:',
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

function readLog(): string {
  try {
    return fs.readFileSync(LOG_PATH, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    console.warn('[doctor] Failed to read log:', error instanceof Error ? error.message : error);
    return '';
  }
}

function logSizeBytes(): number {
  try {
    return fs.statSync(LOG_PATH).size;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0;
    console.warn('[doctor] Failed to stat log:', error instanceof Error ? error.message : error);
    return 0;
  }
}

function rewriteLogTailWithMarker(): { outputBytes: number; outputTruncated: true } {
  const markerBytes = Buffer.byteLength(OUTPUT_TRUNCATED_MARKER, 'utf8');
  const keepBytes = Math.max(0, MAX_OUTPUT_BYTES - markerBytes);
  const current = fs.readFileSync(LOG_PATH);
  const next = Buffer.concat([
    Buffer.from(OUTPUT_TRUNCATED_MARKER, 'utf8'),
    current.subarray(Math.max(0, current.length - keepBytes)),
  ]);
  atomicWrite(LOG_PATH, next.toString('utf8'));
  return { outputBytes: next.length, outputTruncated: true };
}

function computeOutputFields(
  metadata: DoctorRunMetadata
): Pick<DoctorRunMetadata, 'outputBytes' | 'outputTruncated'> {
  const outputBytes = logSizeBytes();
  const outputTruncated = metadata.outputTruncated;
  return { outputBytes, outputTruncated };
}

function syncMetadataOutputFieldsFromOutput(
  metadata: DoctorRunMetadata,
  output: string
): DoctorRunMetadata {
  const outputBytes = Buffer.byteLength(output, 'utf8');
  if (metadata.outputBytes === outputBytes) return metadata;
  const next = { ...metadata, outputBytes };
  writeMetadata(next);
  return next;
}

function syncMetadataOutputFields(metadata: DoctorRunMetadata): DoctorRunMetadata {
  const fields = computeOutputFields(metadata);
  if (
    metadata.outputBytes === fields.outputBytes &&
    metadata.outputTruncated === fields.outputTruncated
  ) {
    return metadata;
  }
  const next = { ...metadata, ...fields };
  writeMetadata(next);
  return next;
}

function persistActiveRunOutput(run: ActiveRun): void {
  const metadata = readMetadata();
  if (!metadata || metadata.runId !== run.runId) return;
  writeMetadata({
    ...metadata,
    outputBytes: run.outputBytes,
    outputTruncated: run.outputTruncated,
  });
}

function scheduleMetadataFlush(run: ActiveRun): void {
  if (run.metadataFlushTimer) return;
  run.metadataFlushTimer = setTimeout(() => {
    run.metadataFlushTimer = null;
    persistActiveRunOutput(run);
  }, METADATA_FLUSH_INTERVAL_MS);
  run.metadataFlushTimer.unref?.();
}

function appendOutput(run: ActiveRun, text: string): void {
  ensureRunDir();
  const chunk = Buffer.from(text, 'utf8');
  fs.appendFileSync(LOG_PATH, chunk);
  run.outputBytes += chunk.length;

  if (run.outputBytes > MAX_OUTPUT_BYTES) {
    const truncated = rewriteLogTailWithMarker();
    run.outputBytes = truncated.outputBytes;
    run.outputTruncated = truncated.outputTruncated;
    persistActiveRunOutput(run);
    return;
  }

  scheduleMetadataFlush(run);
}

function clearTimers(run: ActiveRun): void {
  if (run.timeoutTimer) {
    clearTimeout(run.timeoutTimer);
    run.timeoutTimer = null;
  }
  if (run.killTimer) {
    clearTimeout(run.killTimer);
    run.killTimer = null;
  }
  if (run.metadataFlushTimer) {
    clearTimeout(run.metadataFlushTimer);
    run.metadataFlushTimer = null;
  }
}

function scheduleSigkill(run: ActiveRun): void {
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
  run.killTimer.unref?.();
}

function finalizeRun(run: ActiveRun, exitCode: number | null, status: DoctorRunStatus): void {
  const metadata = readMetadata();
  if (!metadata || metadata.runId !== run.runId || metadata.status !== 'running') return;

  run.finalStatus = status;

  writeMetadata({
    ...metadata,
    outputBytes: run.outputBytes,
    outputTruncated: run.outputTruncated,
    exitCode,
    status,
    completedAt: new Date().toISOString(),
    timedOut: status === 'timed_out' || metadata.timedOut,
  });
  if (run.timeoutTimer) {
    clearTimeout(run.timeoutTimer);
    run.timeoutTimer = null;
  }
  if (run.metadataFlushTimer) {
    clearTimeout(run.metadataFlushTimer);
    run.metadataFlushTimer = null;
  }
  if (run.terminated) {
    if (run.killTimer) {
      clearTimeout(run.killTimer);
      run.killTimer = null;
    }
    activeRun = null;
  }
}

function markInterruptedRunIfNeeded(): DoctorRunMetadata | null {
  const metadata = readMetadata();
  if (!metadata) return null;
  if (metadata.status !== 'running' || activeRun?.runId === metadata.runId) {
    return syncMetadataOutputFields(metadata);
  }

  fs.appendFileSync(LOG_PATH, '\n[doctor run interrupted by controller restart]\n');
  const fields = computeOutputFields(metadata);
  const interrupted = {
    ...metadata,
    ...fields,
    status: 'failed' as const,
    exitCode: null,
    completedAt: new Date().toISOString(),
  };
  writeMetadata(interrupted);
  return interrupted;
}

function statusResponse(): DoctorRunStatusResponse {
  const metadata = markInterruptedRunIfNeeded();
  if (!metadata) return noRunStatus();

  const output = readLog();
  const synced = syncMetadataOutputFieldsFromOutput(metadata, output);
  return {
    hasRun: true,
    runId: synced.runId,
    status: synced.status,
    fix: synced.fix,
    output,
    outputBytes: synced.outputBytes,
    outputTruncated: synced.outputTruncated,
    exitCode: synced.exitCode,
    startedAt: synced.startedAt,
    completedAt: synced.completedAt,
    timedOut: synced.timedOut,
  };
}

/**
 * Chain each start attempt behind the previous one so two concurrent POSTs
 * can never both observe `activeRun === null` and race into a double-spawn.
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

  app.post('/_kilo/doctor/start', async c => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      const rawBody = await c.req.text().catch(() => '');
      if (rawBody.trim()) {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }
      body = {};
    }

    const parsed = DoctorRunBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body', details: z.treeifyError(parsed.error) }, 400);
    }

    const fix = parsed.data.fix ?? true;

    return runStartExclusive(async () => {
      markInterruptedRunIfNeeded();
      if (activeRun) {
        return c.json(
          {
            code: 'openclaw_doctor_already_active',
            error: 'An openclaw doctor run is already in progress',
          },
          409
        );
      }

      ensureRunDir();
      fs.writeFileSync(LOG_PATH, '');

      const runId = crypto.randomUUID();
      const startedAt = new Date().toISOString();
      writeMetadata({
        hasRun: true,
        runId,
        status: 'running',
        fix,
        outputBytes: 0,
        outputTruncated: false,
        exitCode: null,
        startedAt,
        completedAt: null,
        timedOut: false,
      });

      const args = ['doctor', ...(fix ? ['--fix'] : []), '--non-interactive'];
      const child = spawn('openclaw', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      const run: ActiveRun = {
        process: child,
        runId,
        outputBytes: 0,
        outputTruncated: false,
        finalStatus: null,
        timeoutTimer: null,
        killTimer: null,
        metadataFlushTimer: null,
        terminated: false,
      };
      activeRun = run;

      child.stdout?.on('data', (chunk: Buffer | string) => {
        appendOutput(run, typeof chunk === 'string' ? chunk : chunk.toString());
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        appendOutput(run, typeof chunk === 'string' ? chunk : chunk.toString());
      });

      child.once('error', err => {
        console.error('[doctor] Process error:', err.message);
        run.terminated = true;
        appendOutput(run, `\n[process error: ${err.message}]\n`);
        finalizeRun(run, null, 'failed');
      });

      child.once('close', (code, signal) => {
        run.terminated = true;
        const metadata = readMetadata();
        console.log(`[doctor] Process exited: code=${code} signal=${signal}`);
        if (metadata?.runId === run.runId && metadata.status === 'running') {
          finalizeRun(run, code, code === 0 ? 'completed' : 'failed');
          return;
        }
        if (activeRun?.runId === run.runId && run.finalStatus !== null) {
          if (run.killTimer) {
            clearTimeout(run.killTimer);
            run.killTimer = null;
          }
          activeRun = null;
        }
      });

      run.timeoutTimer = setTimeout(() => {
        const metadata = readMetadata();
        if (!metadata || metadata.runId !== run.runId || metadata.status !== 'running') return;
        console.warn('[doctor] Run timed out after 120s, sending SIGTERM');
        appendOutput(run, '\n[doctor timed out after 120s]\n');
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore: child may already be gone.
        }
        scheduleSigkill(run);
        finalizeRun(run, null, 'timed_out');
      }, DOCTOR_TIMEOUT_MS);

      console.log(`[doctor] Started: pid=${child.pid}, fix=${fix}, runId=${runId}`);
      return c.json({ ok: true, runId, startedAt });
    });
  });

  app.get('/_kilo/doctor/status', c => c.json(statusResponse()));

  app.post('/_kilo/doctor/cancel', c => {
    const run = activeRun;
    if (!run) {
      return c.json(
        {
          code: 'openclaw_doctor_no_active_run',
          error: 'No active doctor run to cancel',
        },
        409
      );
    }

    appendOutput(run, '\n[cancelled by operator]\n');
    try {
      run.process.kill('SIGTERM');
    } catch {
      // Ignore: child may already be gone.
    }
    scheduleSigkill(run);
    finalizeRun(run, null, 'cancelled');

    return c.json({ ok: true });
  });
}

/** Exported for testing. */
export function _getActiveRun(): ActiveRun | null {
  return activeRun;
}

/** Exported for testing. */
export function _resetActiveRun(): void {
  if (activeRun) clearTimers(activeRun);
  activeRun = null;
}

/** Exported for testing. */
export function _resetStartQueue(): void {
  startQueue = Promise.resolve();
}

/** Exported for testing. */
export function _setDoctorRunDirForTest(runDir: string): void {
  configureDoctorRunPaths(runDir);
}
