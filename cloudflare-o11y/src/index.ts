import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { registerApiMetricsRoutes } from './api-metrics-routes';
import { evaluateAlerts } from './alerting/evaluate';
import { registerAlertingConfigRoutes } from './alerting/config-routes';
import { SessionMetricsParamsSchema } from './session-metrics-schema';
import type { SessionMetricsParams } from './session-metrics-schema';
import { writeSessionMetricsDataPoint } from './session-metrics-analytics';

const app = new Hono<{ Bindings: Env }>();

registerApiMetricsRoutes(app);
registerAlertingConfigRoutes(app);

export default class extends WorkerEntrypoint<Env> {
	async fetch(request: Request): Promise<Response> {
		return app.fetch(request, this.env, this.ctx);
	}

	async scheduled(_controller: ScheduledController): Promise<void> {
		await evaluateAlerts(this.env);
	}

	/** RPC method called by session-ingest via service binding. */
	async ingestSessionMetrics(params: SessionMetricsParams): Promise<void> {
		const parsed = SessionMetricsParamsSchema.parse(params);
		writeSessionMetricsDataPoint(parsed, this.env);
	}
}
