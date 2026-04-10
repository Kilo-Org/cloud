/**
 * kilo-context-pipeline — Cloudflare Worker entry point.
 *
 * Handles:
 *   - HTTP routes: /trigger, /status, /runs (proxied to PipelineOrchestrator DO)
 *   - Cron trigger: daily 06:00 UTC (triggers the Orchestrator for each active instance)
 *
 * The PipelineContainer and PipelineOrchestrator classes are re-exported here
 * so Wrangler can register them as Durable Objects.
 */

import { Hono } from 'hono';
import type { Env } from './types';

// Re-export Durable Object classes so Wrangler binds them.
export { PipelineContainer } from './pipeline.container';
export { PipelineOrchestrator } from './orchestrator.do';

type HonoEnv = { Bindings: Env };
const app = new Hono<HonoEnv>();

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', c =>
  c.json({ ok: true, service: 'kilo-context-pipeline', ts: new Date().toISOString() })
);

// ── Pipeline control routes (proxied to Orchestrator) ─────────────────────────

/**
 * POST /trigger — start a pipeline run (or 409 if already running).
 * Response: { runId, status: 'running', startedAt }
 */
app.post('/trigger', async c => {
  const stub = getOrchestratorStub(c.env);
  return stub.fetch(
    new Request('http://orchestrator/trigger', { method: 'POST' })
  );
});

/**
 * GET /status — current run state.
 * Response: { status: 'idle' | 'running' | 'success' | 'failed', lastRun: RunSummary | null }
 */
app.get('/status', async c => {
  const stub = getOrchestratorStub(c.env);
  return stub.fetch(
    new Request('http://orchestrator/status', { method: 'GET' })
  );
});

/**
 * GET /runs?limit=N — run history (newest first, max 100).
 * Response: { runs: RunSummary[] }
 */
app.get('/runs', async c => {
  const limit = c.req.query('limit') ?? '20';
  const stub = getOrchestratorStub(c.env);
  return stub.fetch(
    new Request(`http://orchestrator/runs?limit=${limit}`, { method: 'GET' })
  );
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getOrchestratorStub(env: Env): DurableObjectStub {
  const instanceId = env.PIPELINE_INSTANCE_ID ?? 'kilo-internal';
  const id = env.PIPELINE_ORCHESTRATOR.idFromName(instanceId);
  return env.PIPELINE_ORCHESTRATOR.get(id);
}

// ── Cron handler ──────────────────────────────────────────────────────────────

/**
 * Daily cron at 06:00 UTC: trigger the pipeline for the configured instance.
 * For Phase 1 there is one instance; multi-instance fan-out is Phase 2.
 */
async function handleCron(env: Env): Promise<void> {
  const instanceId = env.PIPELINE_INSTANCE_ID ?? 'kilo-internal';
  console.log(`[cron] Triggering pipeline for instance: ${instanceId}`);

  const id = env.PIPELINE_ORCHESTRATOR.idFromName(instanceId);
  const stub = env.PIPELINE_ORCHESTRATOR.get(id);

  try {
    const res = await stub.fetch(
      new Request('http://orchestrator/trigger', { method: 'POST' })
    );
    const body = await res.json();
    if (res.ok) {
      console.log(`[cron] Run triggered:`, JSON.stringify(body));
    } else {
      // 409 = already running — not an error
      console.warn(`[cron] Trigger returned ${res.status}:`, JSON.stringify(body));
    }
  } catch (err) {
    console.error(`[cron] Failed to trigger ${instanceId}:`, err);
  }
}

// ── Default export ────────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(handleCron(env));
  },
};
