/**
 * PipelineOrchestrator — Durable Object managing the kilo-context pipeline lifecycle.
 *
 * State: SQLite database with a `runs` table recording every pipeline run.
 *
 * Routes (all relative to the service's root path):
 *   POST /trigger  — spawn a new pipeline run (idempotent: rejects if already running)
 *   GET  /status   — current run state + last run summary
 *   GET  /runs     — run history (last N runs, default 20)
 *
 * Flow:
 *   1. POST /trigger creates a run record (status=running) in SQLite.
 *   2. ctx.waitUntil spawns spawnPipeline() in the background:
 *      a. Creates a PipelineContainer DO instance using the run UUID as name.
 *      b. POSTs { env: { KB_ROOT, KILO_API_TOKEN, ... } } to the container's /run.
 *      c. Reads the streaming response line by line, accumulates a log tail.
 *      d. Detects the __PIPELINE_COMPLETE__ sentinel to determine exit code.
 *      e. Updates the run record (status=success|failed) in SQLite.
 *      f. On success, calls /_invalidate on the KB Worker via service binding.
 *   3. GET /status and GET /runs read from SQLite — no live container state needed.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

// ── SQLite row shapes ────────────────────────────────────────────────────────

interface RunRow {
  id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  exit_code: number | null;
  log_tail: string | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum bytes of log output to keep per run (last N bytes). */
const LOG_MAX_BYTES = 50_000;

/** How many bytes of the log tail to surface in GET /runs responses. */
const LOG_PREVIEW_BYTES = 2_000;

export class PipelineOrchestrator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Create the runs table once on first instantiation.
    // new_sqlite_classes in migrations ensures this DO has a SQLite database.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id           TEXT    PRIMARY KEY,
        status       TEXT    NOT NULL,   -- 'running' | 'success' | 'failed'
        started_at   TEXT    NOT NULL,   -- ISO-8601
        completed_at TEXT,               -- ISO-8601, null while running
        exit_code    INTEGER,            -- null while running
        log_tail     TEXT                -- last ${LOG_MAX_BYTES} bytes of stdout+stderr
      );
    `);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/trigger') {
      return this.handleTrigger();
    }
    if (request.method === 'GET' && url.pathname === '/status') {
      return this.handleStatus();
    }
    if (request.method === 'GET' && url.pathname === '/runs') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
      return this.handleRuns(limit);
    }

    return new Response('Not found', { status: 404 });
  }

  // ── Route handlers ──────────────────────────────────────────────────────────

  private handleTrigger(): Response {
    // Reject concurrent runs.
    const running = [
      ...this.ctx.storage.sql.exec<RunRow>(
        `SELECT id FROM runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`
      ),
    ];
    if (running.length > 0) {
      return Response.json(
        { error: 'Run already in progress', runId: running[0].id },
        { status: 409 }
      );
    }

    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    this.ctx.storage.sql.exec(
      `INSERT INTO runs (id, status, started_at) VALUES (?, ?, ?)`,
      runId,
      'running',
      startedAt
    );

    // Kick off pipeline in the background so this HTTP response returns immediately.
    this.ctx.waitUntil(this.spawnPipeline(runId));

    return Response.json({ runId, status: 'running', startedAt });
  }

  private handleStatus(): Response {
    const rows = [
      ...this.ctx.storage.sql.exec<RunRow>(
        `SELECT id, status, started_at, completed_at, exit_code FROM runs
         ORDER BY started_at DESC LIMIT 1`
      ),
    ];
    if (rows.length === 0) {
      return Response.json({ status: 'idle', lastRun: null });
    }
    const r = rows[0];
    return Response.json({
      status: r.status,
      lastRun: {
        id: r.id,
        status: r.status,
        startedAt: r.started_at,
        completedAt: r.completed_at ?? null,
        exitCode: r.exit_code ?? null,
        durationMs: r.completed_at
          ? new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()
          : null,
      },
    });
  }

  private handleRuns(limit: number): Response {
    const rows = [
      ...this.ctx.storage.sql.exec<RunRow>(
        `SELECT id, status, started_at, completed_at, exit_code, log_tail
         FROM runs ORDER BY started_at DESC LIMIT ?`,
        limit
      ),
    ];
    return Response.json({
      runs: rows.map(r => ({
        id: r.id,
        status: r.status,
        startedAt: r.started_at,
        completedAt: r.completed_at ?? null,
        exitCode: r.exit_code ?? null,
        durationMs:
          r.completed_at
            ? new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()
            : null,
        // Surface the last LOG_PREVIEW_BYTES of the log in list responses.
        logPreview: r.log_tail ? r.log_tail.slice(-LOG_PREVIEW_BYTES) : null,
      })),
    });
  }

  // ── Pipeline spawning ────────────────────────────────────────────────────────

  /**
   * Create a Container DO instance for this run, send POST /run, read the
   * streaming response, then update the run record on completion.
   *
   * Runs entirely inside ctx.waitUntil — the Trigger response has already
   * been returned to the caller before this method makes any awaited calls.
   */
  private async spawnPipeline(runId: string): Promise<void> {
    try {
      // Each run gets its own Container DO instance (keyed by run UUID).
      // The Container starts when the first request arrives.
      const containerId = this.env.PIPELINE_CONTAINER.idFromName(runId);
      const container = this.env.PIPELINE_CONTAINER.get(containerId);

      // Build a per-run workspace directory so concurrent runs (if ever) don't clash.
      const kbRoot = `/workspace/${runId}`;

      // Collect all credentials to inject into the subprocess environment.
      const pipelineEnv: Record<string, string> = {
        KB_ROOT: kbRoot,
        KILO_API_TOKEN: this.env.KILO_API_TOKEN,
        KILO_ORG_ID: this.env.KILO_ORG_ID,
        SLACK_USER_TOKEN: this.env.SLACK_USER_TOKEN,
        R2_ACCESS_KEY_ID: this.env.R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY: this.env.R2_SECRET_ACCESS_KEY,
      };
      if (this.env.GDRIVE_FOLDER_ID) {
        pipelineEnv.GDRIVE_FOLDER_ID = this.env.GDRIVE_FOLDER_ID;
      }
      if (this.env.GDRIVE_TOKEN_JSON) {
        pipelineEnv.GDRIVE_TOKEN_JSON = this.env.GDRIVE_TOKEN_JSON;
      }

      const response = await container.fetch(
        new Request('http://container/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ env: pipelineEnv }),
        })
      );

      if (!response.ok) {
        const errText = await response.text();
        this.markRunFailed(runId, null, `Container /run returned ${response.status}: ${errText}`);
        return;
      }

      // Read the streaming response and capture a log tail.
      const { exitCode, logTail } = await this.consumeStream(response);

      const status = exitCode === 0 ? 'success' : 'failed';
      this.markRunComplete(runId, status, exitCode, logTail);

      if (status === 'success') {
        await this.invalidateMcpCache();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[orchestrator] Run ${runId} failed:`, message);
      this.markRunFailed(runId, null, message);
    }
  }

  /**
   * Consume a streaming response from the container, accumulating a log tail
   * and extracting the exit code from the __PIPELINE_COMPLETE__ sentinel line.
   */
  private async consumeStream(
    response: Response
  ): Promise<{ exitCode: number | null; logTail: string }> {
    let logBuffer = '';
    let exitCode: number | null = null;

    if (!response.body) {
      return { exitCode: null, logTail: '(no response body)' };
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        logBuffer += chunk;

        // Trim to last LOG_MAX_BYTES to avoid unbounded memory use.
        if (logBuffer.length > LOG_MAX_BYTES) {
          logBuffer = logBuffer.slice(logBuffer.length - LOG_MAX_BYTES);
        }

        // Detect __PIPELINE_COMPLETE__ <status> <exitCode>
        const match = logBuffer.match(/__PIPELINE_COMPLETE__ (\w+) (-?\d+)/);
        if (match) {
          exitCode = parseInt(match[2], 10);
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { exitCode, logTail: logBuffer };
  }

  // ── SQLite helpers ───────────────────────────────────────────────────────────

  private markRunComplete(
    runId: string,
    status: 'success' | 'failed',
    exitCode: number | null,
    logTail: string
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE runs
       SET status = ?, completed_at = ?, exit_code = ?, log_tail = ?
       WHERE id = ?`,
      status,
      new Date().toISOString(),
      exitCode,
      logTail.slice(-LOG_MAX_BYTES),
      runId
    );
  }

  private markRunFailed(runId: string, exitCode: number | null, logTail: string): void {
    this.markRunComplete(runId, 'failed', exitCode, logTail);
  }

  // ── MCP cache invalidation ────────────────────────────────────────────────────

  /**
   * Tell the KB Worker to drop its in-memory index cache.
   * Called via Cloudflare service binding (same-account, internal network).
   * The KB Worker accepts X-Pipeline-Token for this internal call, bypassing
   * the standard MCP_AUTH_TOKEN requirement.
   */
  private async invalidateMcpCache(): Promise<void> {
    try {
      const res = await this.env.KB_WORKER.fetch(
        new Request('https://kilo-context.workers.dev/_invalidate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Pipeline-Token': this.env.PIPELINE_SERVICE_TOKEN,
          },
        })
      );
      if (res.ok) {
        console.log('[orchestrator] KB cache invalidated successfully');
      } else {
        console.error('[orchestrator] KB cache invalidation returned', res.status);
      }
    } catch (err) {
      // Non-fatal: the cache version pointer in R2 will still trigger a reload
      // on the next request to the KB Worker within 60 seconds.
      console.error('[orchestrator] KB cache invalidation failed:', err);
    }
  }
}
