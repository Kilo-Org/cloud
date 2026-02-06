import { Hono } from 'hono';
import { z } from 'zod';
import { zodJsonValidator } from './util/validation';
import { getClientName } from './client-secrets';
import { captureApiMetrics } from './posthog';
import { writeApiMetricsDataPoint } from './o11y-analytics';
import { evaluateAlerts } from './alerting/evaluate';

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
	requestedModel: z.string().min(1),
	resolvedModel: z.string().min(1),
	toolsAvailable: z.array(z.string().min(1)),
	toolsUsed: z.array(z.string().min(1)),
	ttfbMs: z.number().int().nonnegative(),
	completeRequestMs: z.number().int().nonnegative(),
	statusCode: z.number().int().min(100).max(599),
	ipAddress: z.union([z.string().ipv4(), z.string().ipv6()]).optional(),
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
		return c.json({ success: false, error: 'Authentication failed' }, 403);
	}

	c.executionCtx.waitUntil(captureApiMetrics(params, clientName, c.env));
	writeApiMetricsDataPoint(params, clientName, c.env);
	return c.body(null, 204);
});

export default {
	fetch: app.fetch,
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(evaluateAlerts(env));
	},
};
