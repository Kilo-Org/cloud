import type { Hono } from 'hono';
import { z } from 'zod';
import { zodJsonValidator } from './util/validation';
import { writeApiMetricsDataPoint } from './o11y-analytics';
import { requireAdmin } from './admin-middleware';

export const ApiMetricsParamsSchema = z.object({
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

export function registerApiMetricsRoutes(app: Hono<{ Bindings: Env }>): void {
	app.post('/ingest/api-metrics', requireAdmin, zodJsonValidator(ApiMetricsParamsSchema), async (c) => {
		const params = c.req.valid('json');
		writeApiMetricsDataPoint(params, 'kilo-gateway', c.env, (p) => c.executionCtx.waitUntil(p));
		return c.body(null, 204);
	});
}
