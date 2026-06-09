import { Hono } from 'hono';
import { createErrorHandler, createNotFoundHandler } from '@kilocode/worker-utils';
import { authMiddleware } from './auth';
import { classifyHandler } from './classify';
import type { HonoEnv } from './hono-env';

export const app = new Hono<HonoEnv>();

app.use('*', authMiddleware);

app.get('/health', c => c.json({ status: 'ok', service: 'auto-model-classifier' }));

app.post('/classify', classifyHandler);

app.notFound(createNotFoundHandler());
app.onError(createErrorHandler());

export default app;
