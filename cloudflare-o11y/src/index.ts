import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { z } from 'zod';
import { zodJsonValidator } from './util/validation';
import { getClientName } from './client-secrets';
import { writeApiMetricsDataPoint } from './o11y-analytics';
import { evaluateAlerts } from './alerting/evaluate';
import { SessionMetricsParamsSchema } from './session-metrics-schema';
import type { SessionMetricsParams } from './session-metrics-schema';
import { writeSessionMetricsDataPoint } from './session-metrics-analytics';

const app = new Hono<{ Bindings: Env }>();

export const ApiMetricsParamsSchema = z.object({
	clientSecret: z.string().min(1),
	kiloUserId: z.string().min(1),
	organizationId: z.string().min(1).optional(),
	isAnonymous: z.boolean(),
	isStreaming: z.boolean(),
	userByok: z.boolean(),
	mode: z.string().min(1).optional(),
	provider: z.string().min(1),
	inferenceProvider: z.string().optional().default(''),
	requestedModel: z.string().min(1),
	resolvedModel: z.string().min(1),
	toolsAvailable: z.array(z.string().min(1)),
	toolsUsed: z.array(z.string().min(1)),
	ttfbMs: z.number().int().nonnegative(),
	completeRequestMs: z.number().int().nonnegative(),
	statusCode: z.number().int().min(100).max(599),
	tokens: z
		.object({
			inputTokens: z.number().int().nonnegative().optional(),
			outputTokens: z.number().int().nonnegative().optional(),
			cacheWriteTokens: z.number().int().nonnegative().optional(),
			cacheHitTokens: z.number().int().nonnegative().optional(),
			totalTokens: z.number().int().nonnegative().optional(),
		})
		.optional(),
});

app.get('/', (c) => c.text('Hello World!'));

app.post('/ingest/api-metrics', zodJsonValidator(ApiMetricsParamsSchema), async (c) => {
	const params = c.req.valid('json');

	const clientName = await getClientName(params.clientSecret, c.env);
	if (!clientName) {
		return c.json({ success: false, error: 'Unknown clientSecret' }, 403);
	}

	writeApiMetricsDataPoint(params, clientName, c.env);
	return c.body(null, 204);
});

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
