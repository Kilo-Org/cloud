import { Hono } from 'hono';
import { timingSafeEqual } from '@kilocode/encryption';
import type { z } from 'zod';
import {
  onPremEnrollmentRequestSchema,
  onPremEnrollRequestSchema,
  onPremExchangeRequestSchema,
  onPremOrganizationIdSchema,
  onPremProviderBindingSchema,
  onPremRevokeRequestSchema,
  onPremSelectRequestSchema,
} from '../shared/onprem-protocol.js';
import { parseBearerCredential } from '../sandbox-control/credential.js';
import type { Env } from '../types.js';
import { projectOnPremError, withOnPremInstallation } from './client.js';

const MAX_BODY_BYTES = 64 * 1024;
const internalPath = '/internal/onprem/organizations/:organizationId';
const managementPath = '/onprem/organizations/:organizationId/installations/:installationId';
type OnPremRouteEnv = Pick<Env, 'ONPREM_INSTALLATION' | 'INTERNAL_API_SECRET'>;

async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  ) {
    throw new Error('onprem_invalid_request');
  }
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    throw new Error('onprem_body_too_large');
  }
  if (!request.body) throw new Error('onprem_invalid_request');
  const reader: ReadableStreamDefaultReader<unknown> = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('onprem_invalid_request');
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('onprem_body_too_large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof Error && error.message === 'onprem_body_too_large') throw error;
    throw new Error('onprem_invalid_request');
  } finally {
    reader.releaseLock();
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error('onprem_invalid_request');
  }
  const result = schema.safeParse(input);
  if (!result.success) throw new Error('onprem_invalid_request');
  return result.data;
}

export const onPremRoutes = new Hono<{
  Bindings: OnPremRouteEnv;
  Variables: { organizationId: string; installationId: string };
}>();

for (const path of ['/internal/onprem/*', '/onprem/*']) {
  onPremRoutes.use(path, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
}

onPremRoutes.use('/internal/onprem/*', async (c, next) => {
  if (!c.env.INTERNAL_API_SECRET) return c.json({ error: 'onprem_unavailable' }, 503);
  const key = c.req.header('x-internal-api-key');
  if (!key || key.length > 512 || !timingSafeEqual(key, c.env.INTERNAL_API_SECRET)) {
    return c.json({ error: 'onprem_unauthorized' }, 401);
  }
  await next();
});

for (const path of [internalPath, `${internalPath}/*`, `${managementPath}/*`]) {
  onPremRoutes.use(path, async (c, next) => {
    const organizationId = onPremOrganizationIdSchema.safeParse(c.req.param('organizationId'));
    if (!organizationId.success) return c.json({ error: 'onprem_invalid_request' }, 400);
    c.set('organizationId', organizationId.data);
    const installationId = c.req.param('installationId');
    if (installationId !== undefined) {
      const parsed = onPremProviderBindingSchema.shape.installationId.safeParse(installationId);
      if (!parsed.success) return c.json({ error: 'onprem_invalid_request' }, 400);
      c.set('installationId', parsed.data);
    }
    await next();
  });
}

onPremRoutes.get(internalPath, async c => {
  const organizationId = c.get('organizationId');
  const status = await withOnPremInstallation(
    c.env,
    organizationId,
    stub => stub.getStatus(organizationId),
    'getOnPremStatus'
  );
  return c.json(status);
});

onPremRoutes.post(`${internalPath}/enrollment`, async c => {
  const organizationId = c.get('organizationId');
  const input = await readJson(c.req.raw, onPremEnrollmentRequestSchema);
  const result = await withOnPremInstallation(
    c.env,
    organizationId,
    stub => stub.createEnrollment(organizationId, input),
    'createOnPremEnrollment'
  );
  return c.json(result);
});

onPremRoutes.post(`${internalPath}/select`, async c => {
  const organizationId = c.get('organizationId');
  const input = await readJson(c.req.raw, onPremSelectRequestSchema);
  const result = await withOnPremInstallation(
    c.env,
    organizationId,
    stub => stub.select(organizationId, input),
    'selectOnPremInstallation'
  );
  return c.json(result);
});

onPremRoutes.post(`${internalPath}/revoke`, async c => {
  const organizationId = c.get('organizationId');
  const input = await readJson(c.req.raw, onPremRevokeRequestSchema);
  const result = await withOnPremInstallation(
    c.env,
    organizationId,
    stub => stub.revoke(organizationId, input),
    'revokeOnPremInstallation'
  );
  return c.json(result);
});

onPremRoutes.post(`${managementPath}/enroll`, async c => {
  const credential = parseBearerCredential(c.req.header('Authorization') ?? null);
  if (!credential) return c.json({ error: 'onprem_unauthorized' }, 401);
  const input = await readJson(c.req.raw, onPremEnrollRequestSchema);
  const result = await withOnPremInstallation(
    c.env,
    c.get('organizationId'),
    stub => stub.enroll(c.get('installationId'), credential, input),
    'enrollOnPremInstallation'
  );
  return c.json(result);
});

onPremRoutes.post(`${managementPath}/exchange`, async c => {
  const credential = parseBearerCredential(c.req.header('Authorization') ?? null);
  if (!credential) return c.json({ error: 'onprem_unauthorized' }, 401);
  const input = await readJson(c.req.raw, onPremExchangeRequestSchema);
  const result = await withOnPremInstallation(
    c.env,
    c.get('organizationId'),
    stub => stub.exchange(c.get('installationId'), credential, input),
    'exchangeOnPremOperations'
  );
  return c.json(result);
});

onPremRoutes.onError((error, c) => {
  if (error.message === 'onprem_body_too_large') {
    return c.json({ error: 'onprem_body_too_large' }, 413);
  }
  const { code, status } = projectOnPremError(error);
  return c.json({ error: code }, status);
});
