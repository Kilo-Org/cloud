import type { Hono } from 'hono';
import { z } from 'zod';
import { zodJsonValidator } from './util/validation';
import { writeApiMetricsDataPoint } from './o11y-analytics';

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

// TODO: Remove clientSecret body check once all clients send the X-O11Y-ADMIN-TOKEN header.
// At that point, use requireAdmin middleware instead (like other admin routes).
async function hasValidAuth(c: { req: { header: (name: string) => string | undefined }; env: Env }): Promise<boolean> {
	const secret = await c.env.O11Y_KILO_GATEWAY_CLIENT_SECRET.get();
	if (!secret) return false;

	const headerToken = c.req.header('X-O11Y-ADMIN-TOKEN');
	if (headerToken === secret) return true;

	// Backwards compat: accept clientSecret in body (parsed by zodJsonValidator before this runs)
	const body = c.req as unknown as { valid: (target: 'json') => { clientSecret?: string } };
	const clientSecret = body.valid('json').clientSecret;
	return clientSecret === secret;
}

export function registerApiMetricsRoutes(app: Hono<{ Bindings: Env }>): void {
	app.post('/ingest/api-metrics', zodJsonValidator(ApiMetricsParamsSchema), async (c) => {
		if (!(await hasValidAuth(c))) {
			return c.json({ success: false, error: 'Unauthorized' }, 401);
		}

		const params = c.req.valid('json');
		writeApiMetricsDataPoint(params, 'kilo-gateway', c.env);
		return c.body(null, 204);
	});
}
