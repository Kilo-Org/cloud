import { Hono } from 'hono';
import { createErrorHandler, createNotFoundHandler } from '@kilocode/worker-utils';
import { mirrorPayloadSchema, parseClassifierInput } from './classifier-input';

type HonoEnv = { Bindings: Env };

export const app = new Hono<HonoEnv>();

app.use('*', async (c, next) => {
  const authToken = await getSecretValue(c.env.INTERNAL_API_SECRET_PROD);
  if (!authToken || authToken.trim() === '') {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const bearerToken = getBearerToken(c.req.header('authorization') ?? null);
  if (!bearerToken || !(await timingSafeEqual(bearerToken, authToken))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return next();
});

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

function getSecretValue(secret: string | SecretsStoreSecret) {
  return typeof secret === 'string' ? secret : secret.get();
}

function getBearerToken(authorization: string | null) {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

async function timingSafeEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);

  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let diff = 0;
  for (let index = 0; index < leftBytes.length; index++) {
    diff |= leftBytes[index] ^ rightBytes[index];
  }

  return diff === 0;
}
