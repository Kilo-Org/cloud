import type { MiddlewareHandler } from 'hono';

export const requireAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
	const secret = await c.env.O11Y_KILO_GATEWAY_CLIENT_SECRET.get();
	const token = c.req.header('X-O11Y-ADMIN-TOKEN');
	if (!secret || token !== secret) {
		return c.json({ success: false, error: 'Unauthorized' }, 401);
	}

	return next();
};
