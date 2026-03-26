import { spawn, execSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { Hono } from 'hono';
import { z } from 'zod';
import { timingSafeTokenEqual } from '../auth';
import { getBearerToken } from './gateway';

// ── Types ─────────────────────────────────────────────────────────────

type RunState = {
  process: ChildProcess;
  output: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  exitCode: number | null;
  startedAt: string;
  completedAt: string | null;
  prompt: string;
};

// ── Constants ─────────────────────────────────────────────────────────

/** Cap output buffer at ~1MB to prevent OOM from verbose agent runs. */
const MAX_OUTPUT_BYTES = 1_048_576;

// ── Module-level state (one run at a time per machine) ────────────────

let activeRun: RunState | null = null;

// ── Request schemas ───────────────────────────────────────────────────

const StartRunBodySchema = z.object({
  prompt: z.string().min(1).max(10_000),
});

// ── Helpers ───────────────────────────────────────────────────────────

function appendOutput(run: RunState, chunk: string): void {
  run.output += chunk;
  // Truncate from the front to keep the newest output
  if (run.output.length > MAX_OUTPUT_BYTES) {
    const truncateAt = run.output.length - MAX_OUTPUT_BYTES;
    run.output = '… [output truncated] …\n' + run.output.slice(truncateAt);
  }
}

function cleanupRun(
  run: RunState,
  exitCode: number | null,
  status: 'completed' | 'failed' | 'cancelled'
): void {
  run.exitCode = exitCode;
  run.status = status;
  run.completedAt = new Date().toISOString();
  // Don't null out activeRun — keep it for status queries until a new run starts
}

// ── Route registration ────────────────────────────────────────────────

export function registerKiloCliRunRoutes(app: Hono, expectedToken: string): void {
  // Auth middleware for all kilo-cli-run routes
  app.use('/_kilo/cli-run/*', async (c, next) => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  // POST /_kilo/cli-run/start — spawn `kilo run --auto "<prompt>"`
  app.post('/_kilo/cli-run/start', async c => {
    // Gate on feature flag and API key
    if (process.env.KILOCLAW_KILO_CLI !== 'true') {
      return c.json({ error: 'Kilo CLI is not enabled on this instance' }, 400);
    }
    if (!process.env.KILO_API_KEY) {
      return c.json({ error: 'KILO_API_KEY is not configured' }, 400);
    }

    // Enforce one-at-a-time
    if (activeRun?.status === 'running') {
      return c.json({ error: 'A kilo CLI run is already in progress' }, 409);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = StartRunBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body', details: parsed.error.flatten() }, 400);
    }

    const { prompt } = parsed.data;

    // ── Debug: log environment and config before spawning ──────────
    const kiloConfigDir = '/root/.config/kilo';
    const kiloConfigFile = `${kiloConfigDir}/opencode.json`;

    const debugInfo: string[] = [
      '=== Kilo CLI Run Debug Info ===',
      `KILO_API_KEY: ${process.env.KILO_API_KEY ? `set (${process.env.KILO_API_KEY.length} chars, starts with ${process.env.KILO_API_KEY.slice(0, 8)}...)` : 'NOT SET'}`,
      `KILOCODE_API_KEY: ${process.env.KILOCODE_API_KEY ? `set (${process.env.KILOCODE_API_KEY.length} chars)` : 'NOT SET'}`,
      `KILOCODE_API_BASE_URL: ${process.env.KILOCODE_API_BASE_URL ?? 'NOT SET'}`,
      `KILOCLAW_KILO_CLI: ${process.env.KILOCLAW_KILO_CLI ?? 'NOT SET'}`,
      `HOME: ${process.env.HOME ?? 'NOT SET'}`,
      `PATH (first 200): ${(process.env.PATH ?? '').slice(0, 200)}`,
    ];

    // Check if kilo binary is on PATH
    try {
      const kiloPath = execSync('which kilo', { encoding: 'utf8', timeout: 5000 }).trim();
      debugInfo.push(`kilo binary: ${kiloPath}`);
      try {
        const kiloVersion = execSync('kilo version 2>&1 || true', {
          encoding: 'utf8',
          timeout: 10_000,
        }).trim();
        debugInfo.push(`kilo version: ${kiloVersion.slice(0, 200)}`);
      } catch (e) {
        debugInfo.push(`kilo version: failed (${e instanceof Error ? e.message : String(e)})`);
      }
    } catch {
      debugInfo.push('kilo binary: NOT FOUND on PATH');
    }

    // Check kilo config
    if (fs.existsSync(kiloConfigFile)) {
      try {
        const configRaw = fs.readFileSync(kiloConfigFile, 'utf8');
        const config = JSON.parse(configRaw);
        // Log config structure without sensitive values
        const safeConfig = JSON.parse(JSON.stringify(config));
        if (safeConfig.provider?.kilo?.options?.apiKey) {
          safeConfig.provider.kilo.options.apiKey = '[REDACTED]';
        }
        debugInfo.push(`kilo config (${kiloConfigFile}): ${JSON.stringify(safeConfig, null, 2)}`);
      } catch (e) {
        debugInfo.push(
          `kilo config: exists but failed to read (${e instanceof Error ? e.message : String(e)})`
        );
      }
    } else {
      debugInfo.push(`kilo config: ${kiloConfigFile} DOES NOT EXIST`);
      // Check if the directory exists
      debugInfo.push(`kilo config dir: ${fs.existsSync(kiloConfigDir) ? 'exists' : 'MISSING'}`);
    }

    debugInfo.push('=== End Debug Info ===\n');
    const debugOutput = debugInfo.join('\n');
    console.log('[kilo-cli-run]', debugOutput);

    // Spawn the kilo CLI process
    // The prompt is passed as a separate argument to avoid shell injection
    const child = spawn('kilo', ['run', '--auto', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    const run: RunState = {
      process: child,
      output: debugOutput + '\n',
      status: 'running',
      exitCode: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      prompt,
    };

    activeRun = run;

    // Capture stdout
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      appendOutput(run, text);
    });

    // Capture stderr (merge into same output buffer)
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      appendOutput(run, text);
    });

    child.once('error', err => {
      console.error('[kilo-cli-run] Process error:', err.message);
      if (run.status === 'running') {
        appendOutput(run, `\n[process error: ${err.message}]\n`);
        cleanupRun(run, null, 'failed');
      }
    });

    child.once('close', (code, signal) => {
      if (run.status !== 'running') return; // already handled by error event
      console.log(`[kilo-cli-run] Process exited: code=${code} signal=${signal}`);
      cleanupRun(run, code, code === 0 ? 'completed' : 'failed');
    });

    console.log(`[kilo-cli-run] Started: pid=${child.pid}, prompt="${prompt.slice(0, 100)}..."`);

    return c.json({
      ok: true,
      startedAt: run.startedAt,
    });
  });

  // GET /_kilo/cli-run/status — poll for current run status and output
  app.get('/_kilo/cli-run/status', c => {
    if (!activeRun) {
      return c.json({
        hasRun: false,
        status: null,
        output: null,
        exitCode: null,
        startedAt: null,
        completedAt: null,
        prompt: null,
      });
    }

    return c.json({
      hasRun: true,
      status: activeRun.status,
      output: activeRun.output,
      exitCode: activeRun.exitCode,
      startedAt: activeRun.startedAt,
      completedAt: activeRun.completedAt,
      prompt: activeRun.prompt,
    });
  });

  // POST /_kilo/cli-run/cancel — kill the active run
  app.post('/_kilo/cli-run/cancel', c => {
    if (!activeRun || activeRun.status !== 'running') {
      return c.json({ error: 'No active run to cancel' }, 404);
    }

    try {
      activeRun.process.kill('SIGTERM');
      // Give it 5s to exit gracefully, then SIGKILL
      const run = activeRun;
      setTimeout(() => {
        if (run.status === 'running') {
          run.process.kill('SIGKILL');
        }
      }, 5_000);
      appendOutput(activeRun, '\n[cancelled by user]\n');
      cleanupRun(activeRun, null, 'cancelled');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Failed to cancel: ${message}` }, 500);
    }

    return c.json({ ok: true });
  });
}

/** Exported for testing. */
export function _getActiveRun(): RunState | null {
  return activeRun;
}

/** Exported for testing. */
export function _resetActiveRun(): void {
  activeRun = null;
}
