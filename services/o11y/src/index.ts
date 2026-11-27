import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { RESOURCE_METADATA_PATH, protectedResourceMetadata } from './admin-middleware';
import { registerApiMetricsRoutes } from './api-metrics-routes';
import { evaluateAlerts } from './alerting/evaluate';
import { registerAlertingConfigRoutes } from './alerting/config-routes';
import { SessionMetricsParamsSchema } from './session-metrics-schema';
import type { SessionMetricsParamsInput } from './session-metrics-schema';
import { writeSessionMetricsDataPoint } from './session-metrics-analytics';
import { summarizeInternalAuthCounter } from './internal-auth-counter';

export { AlertConfigDO } from './alerting/AlertConfigDO';

const app = new Hono<{ Bindings: Env }>();

// RFC 9728 metadata for the STS admin challenge; the ordinary 404 unless an STS mode is on.
app.get(RESOURCE_METADATA_PATH, c => protectedResourceMetadata(c.env) ?? c.notFound());
registerApiMetricsRoutes(app);
registerAlertingConfigRoutes(app);

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  async scheduled(_controller: ScheduledController): Promise<void> {
    try {
      await evaluateAlerts(this.env, this.ctx);
    } catch {
      // The counter summary below must run even when alert evaluation fails.
    }
    await summarizeInternalAuthCounter(this.env, this.ctx);
  }

  /** RPC method called by session-ingest via service binding. */
  async ingestSessionMetrics(params: SessionMetricsParamsInput): Promise<void> {
    const parsed = SessionMetricsParamsSchema.parse(params);
    await writeSessionMetricsDataPoint(parsed, this.env);
  }
}
