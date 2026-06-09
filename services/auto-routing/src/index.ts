import { Hono } from 'hono';
import { createErrorHandler, createNotFoundHandler } from '@kilocode/worker-utils';
import { authMiddleware } from './auth';
import { decideHandler } from './decide';
import type { HonoEnv } from './hono-env';

export const app = new Hono<HonoEnv>();

app.use('*', authMiddleware);

app.get('/health', c => c.json({ status: 'ok', service: 'auto-routing' }));

app.post('/decide', decideHandler);

app.notFound(createNotFoundHandler());
app.onError(createErrorHandler());

export default app;
