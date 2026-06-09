import { Hono } from 'hono';
import {
  backendAuthMiddleware,
  createErrorHandler,
  createNotFoundHandler,
} from '@kilocode/worker-utils';
import { mirrorPayloadSchema, parseClassifierInput } from './classifier-input';

type HonoEnv = { Bindings: Env };

export const app = new Hono<HonoEnv>();

app.use(
  '*',
  backendAuthMiddleware<HonoEnv>(c => c.env.BACKEND_AUTH_TOKEN)
);

app.get('/health', c => c.json({ status: 'ok', service: 'auto-model-classifier' }));

app.post('/classify', async c => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = mirrorPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid classifier payload' }, 400);
  }

  const classifierInput = parseClassifierInput(parsed.data);
  if (!classifierInput.success) {
    return c.json({ error: classifierInput.error }, 400);
  }

  return c.json({ ok: true, normalized: classifierInput.data });
});

app.notFound(createNotFoundHandler());
app.onError(createErrorHandler());

export default app;
