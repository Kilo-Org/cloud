import { spawn, type ChildProcess } from 'node:child_process';
import type { Hono } from 'hono';
import { z } from 'zod';
import { timingSafeTokenEqual } from '../auth';
import { getBearerToken } from './gateway';
import { CONFIG_FILE, KILO_CONFIG_DIR } from '../kilo-cli-config';
import { DEFAULT_MCPORTER_CONFIG_PATH } from '../config-writer';

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

// ── Prompt template ───────────────────────────────────────────────────

/**
 * Wrap the user's prompt with system context so the agent knows where
 * things are and how to diagnose / fix issues on this KiloClaw machine.
 */
export function buildRunPrompt(userPrompt: string): string {
  return `You are a system repair agent on a KiloClaw instance — an OpenClaw AI assistant running on a Fly.io machine. Your job is to diagnose and fix the issue described below. These issues are usually configuration errors or broken integrations and are often straightforward to fix once you find the root cause.

## Key Paths

- OpenClaw config: \`/root/.openclaw/openclaw.json\` (the main config file — validated on load)
- Config backups: \`/root/.openclaw/openclaw.json.bak.*\` (timestamped, up to 5 kept)
- MCP servers: \`${DEFAULT_MCPORTER_CONFIG_PATH}\`
- Agent workspace: \`/root/clawd/\` (current working directory)
- Kilo CLI config: \`${KILO_CONFIG_DIR}/${CONFIG_FILE}\`

## Architecture

The OpenClaw gateway process listens on \`127.0.0.1:3001\` (loopback), managed by a Node.js controller on port \`18789\` (externally exposed). The controller handles auth, config management, and proxies traffic to the gateway.

## Diagnostics

- Gateway readiness: \`curl -sf http://127.0.0.1:3001/ready\`
- Controller state: \`curl -sf http://127.0.0.1:18789/_kilo/health\`
- Process check: \`ps aux | grep openclaw\`
- Validate config JSON: \`cat /root/.openclaw/openclaw.json | jq .\`
- Logs are NOT written to disk — they go to stdout/stderr (Fly log aggregation). The user may paste log excerpts in the task description below.
- Run \`openclaw doctor\` to check for common issues.

## How to Fix

- Edit \`/root/.openclaw/openclaw.json\` to correct config issues.
- After config changes, restart the gateway: \`kill -USR1 $(pgrep -f "openclaw gateway")\`
- The supervisor auto-restarts the gateway on crashes with exponential backoff.
- If the gateway process is missing entirely, the supervisor will respawn it.

## Task

${userPrompt}`;
}

// ── Module-level state (one run at a time per machine) ────────────────

let activeRun: RunState | null = null;
let startQueue: Promise<void> = Promise.resolve();

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

/**
 * This chains each start attempt behind the previous one.
 *
 * `then(fn, fn)` ensures the next attempt runs regardless of whether the
 * previous one resolved or rejected — the queue must never stall.
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

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = StartRunBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body', details: z.treeifyError(parsed.error) }, 400);
    }

    const { prompt } = parsed.data;

    return runStartExclusive(async () => {
      if (activeRun?.status === 'running') {
        return c.json(
          {
            code: 'kilo_cli_run_already_active',
            error: 'A Kilo CLI run is already in progress',
          },
          409
        );
      }

      const fullPrompt = buildRunPrompt(prompt);

      // Spawn the kilo CLI process
      // The prompt is passed as a separate argument to avoid shell injection
      const child = spawn('kilo', ['run', '--auto', fullPrompt], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      const run: RunState = {
        process: child,
        output: '',
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
      return c.json({ code: 'kilo_cli_run_no_active_run', error: 'No active run to cancel' }, 409);
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

/** Exported for testing. */
export function _resetStartQueue(): void {
  startQueue = Promise.resolve();
}
