import { Hono } from 'hono';
import { createErrorHandler, createNotFoundHandler } from '@kilocode/worker-utils';
import { authMiddleware } from './auth';
import { classifierAnalyticsHandler } from './admin-classifier-analytics';
import { getClassifierModelHandler, putClassifierModelHandler } from './admin-classifier-model';
import { decideHandler } from './decide';
import type { HonoEnv } from './hono-env';

export const app = new Hono<HonoEnv>();

app.use('*', authMiddleware);

app.get('/health', c => c.json({ status: 'ok', service: 'auto-routing' }));

app.get('/admin/classifier-model', getClassifierModelHandler);
app.put('/admin/classifier-model', putClassifierModelHandler);
app.get('/admin/classifier-analytics', classifierAnalyticsHandler);

app.post('/decide', decideHandler);

app.notFound(createNotFoundHandler());
app.onError(createErrorHandler());

export default app;
