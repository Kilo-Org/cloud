import { Hono, type Context } from 'hono';
import type { HonoContext } from '../index';
import type { TriggerDO } from '../dos/TriggerDO';
import { MAX_PAYLOAD_SIZE } from '../util/constants';
import { logger } from '../util/logger';
import { resError, resSuccess } from '../util/res';
import { withDORetry } from '../util/do-retry';
import { compareWebhookSecret, type StoredWebhookAuth } from '../util/webhook-auth';
import { decodeUserIdFromPath } from '../util/user-id-encoding';

type CaptureResult = { success: true; requestId: string } | { success: false; error: string };

const inbound = new Hono<HonoContext>();

inbound.all('/user/:userId/:triggerId', async c => {
  const { triggerId } = c.req.param();
  const userId = decodeUserIdFromPath(c.req.param('userId'));
  const namespace = `user/${userId}`;
  const doKey = buildDOKey(namespace, triggerId);

  return handleWebhookCapture(c, doKey, namespace, triggerId);
});

inbound.all('/org/:orgId/:triggerId', async c => {
  const { orgId, triggerId } = c.req.param();
  const namespace = `org/${orgId}`;
  const doKey = buildDOKey(namespace, triggerId);

  return handleWebhookCapture(c, doKey, namespace, triggerId);
});

type RouteContext = Context<HonoContext>;

async function handleWebhookCapture(
  c: RouteContext,
  doKey: string,
  namespace: string,
  triggerId: string
) {
  const contentType = c.req.header('Content-Type') ?? '';
  if (isUnsupportedContentType(contentType)) {
    return c.json(resError('Unsupported content type'), 415);
  }

  const contentLength = c.req.header('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_SIZE) {
    return c.json(resError('Payload too large'), 413);
  }

  const stubFactory = () => c.env.TRIGGER_DO.get(c.env.TRIGGER_DO.idFromName(doKey));

  try {
    const authConfig = await withDORetry<DurableObjectStub<TriggerDO>, StoredWebhookAuth | null>(
      stubFactory,
      stub => stub.getAuthConfig(),
      'getAuthConfig'
    );

    if (authConfig) {
      const providedSecret = c.req.header(authConfig.header);
      if (!providedSecret) {
        logger.warn('Inbound webhook missing auth header', {
          namespace,
          triggerId,
          header: authConfig.header,
        });
        return c.json(resError('Unauthorized'), 401);
      }

      const isMatch = await compareWebhookSecret(authConfig.secretHash, providedSecret);
      if (!isMatch) {
        logger.warn('Inbound webhook provided invalid auth secret', {
          namespace,
          triggerId,
        });
        return c.json(resError('Unauthorized'), 401);
      }
    }
  } catch (error) {
    logger.error('Failed to validate webhook auth', {
      namespace,
      triggerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(resError('Internal server error'), 500);
  }

  let body: string;
  try {
    body = await c.req.text();
  } catch {
    return c.json(resError('Failed to read request body'), 400);
  }

  if (body.length > MAX_PAYLOAD_SIZE) {
    return c.json(resError('Payload too large'), 413);
  }

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const url = new URL(c.req.url);
  const queryString = url.search ? url.search.slice(1) : null;

  try {
    const result = await withDORetry<DurableObjectStub<TriggerDO>, CaptureResult>(
      stubFactory,
      stub =>
        stub.captureRequest({
          method: c.req.method,
          path: c.req.path,
          queryString,
          headers,
          body,
          contentType: c.req.header('Content-Type') ?? null,
          sourceIp: c.req.header('CF-Connecting-IP') ?? null,
        }),
      'captureRequest'
    );

    if (!result.success) {
      if (result.error === 'Trigger not configured or inactive') {
        return c.json(resError('Trigger not found'), 404);
      }
      if (result.error === 'Too many in-flight requests') {
        return c.json(resError('Too many in-flight requests'), 429);
      }
      return c.json(resError(result.error ?? 'Failed to capture request'), 400);
    }

    logger.info('Webhook captured', {
      namespace,
      triggerId,
      requestId: result.requestId,
      method: c.req.method,
    });

    return c.json(
      resSuccess({
        requestId: result.requestId,
        message: 'Webhook captured successfully',
      })
    );
  } catch (error) {
    logger.error('Failed to capture webhook', {
      namespace,
      triggerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(resError('Internal server error'), 500);
  }
}

function buildDOKey(namespace: string, triggerId: string): string {
  return `${namespace}/${triggerId}`;
}

function isUnsupportedContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  if (!normalized) {
    return false;
  }
  const blockedPrefixes = ['multipart/', 'image/', 'audio/', 'video/'];
  for (const prefix of blockedPrefixes) {
    if (normalized.startsWith(prefix)) {
      return true;
    }
  }
  const blockedTypes = ['application/octet-stream', 'application/pdf', 'application/zip'];
  return blockedTypes.some(type => normalized.includes(type));
}

export { inbound };
