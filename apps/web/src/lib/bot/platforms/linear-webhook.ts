import crypto from 'node:crypto';
import type { Chat, WebhookOptions } from 'chat';
import type { LinearAdapter } from '@chat-adapter/linear';
import { captureException } from '@sentry/nextjs';
import { unlinkTeamKiloUsers } from '@/lib/bot-identity';
import { deleteInstallationByOrganizationId } from '@/lib/integrations/linear-service';
import { LINEAR_WEBHOOK_SECRET } from '@kilocode/web-shared/lib/config.server';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { WebhookBodyTooLargeError, readBoundedRawBody } from '@/lib/webhook-body';

/**
 * Linear's documented webhook scheme:
 *
 *   linear-signature = hex(hmac-sha256(webhook_secret, raw_body))
 *   freshness        = `webhookTimestamp` in the signed body, tolerance 60s
 *
 * Every accepted delivery carries a `webhookTimestamp` inside the signed body.
 * Freshness is read from that field only.
 */

const LINEAR_SIGNATURE_HEADER = 'linear-signature';
const LINEAR_TIMESTAMP_TOLERANCE_MS = 60 * 1000;

type LinearOAuthAppRevokedPayload = {
  type: 'OAuthApp';
  action: 'revoked';
  organizationId: string;
};

function verifyLinearSignature(rawBody: string, request: Request): boolean {
  const signature = request.headers.get(LINEAR_SIGNATURE_HEADER);
  if (!signature) return false;

  const expectedHex = crypto
    .createHmac('sha256', LINEAR_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  const expectedBuf = Buffer.from(expectedHex);
  const signatureBuf = Buffer.from(signature);

  if (expectedBuf.length !== signatureBuf.length) return false;

  try {
    return crypto.timingSafeEqual(expectedBuf, signatureBuf);
  } catch {
    return false;
  }
}

function isFreshWebhookDelivery(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  if (!('webhookTimestamp' in payload)) return false;

  const webhookTimestamp = payload.webhookTimestamp;
  if (typeof webhookTimestamp !== 'number' || !Number.isFinite(webhookTimestamp)) return false;

  return Math.abs(Date.now() - webhookTimestamp) <= LINEAR_TIMESTAMP_TOLERANCE_MS;
}

function isLinearOAuthAppRevokedPayload(payload: unknown): payload is LinearOAuthAppRevokedPayload {
  return (
    !!payload &&
    typeof payload === 'object' &&
    'type' in payload &&
    payload.type === 'OAuthApp' &&
    'action' in payload &&
    payload.action === 'revoked' &&
    'organizationId' in payload &&
    typeof payload.organizationId === 'string'
  );
}

async function handleLinearOAuthAppRevoked(
  organizationId: string,
  chat: Chat,
  linearAdapter: LinearAdapter
): Promise<void> {
  try {
    // Delete the upstream adapter installation first so that if it fails we
    // keep our own `platform_integrations` row around and can retry. Adapter
    // already handles this internally on revoked events, but calling it
    // explicitly is idempotent and keeps the cleanup behaviour consistent
    // with the Slack webhook handler.
    await linearAdapter.deleteInstallation(organizationId);
    await deleteInstallationByOrganizationId(organizationId);
    await unlinkTeamKiloUsers(chat.getState(), PLATFORM.LINEAR, organizationId);
  } catch (error) {
    captureException(error, {
      level: 'error',
      tags: { component: 'kilo-bot', op: 'linear-oauth-revoked' },
      extra: { organizationId },
    });
  }
}

function cloneLinearRequest(request: Request, body: BodyInit): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });
}

/**
 * Webhook handler that verifies the Linear signature, peels off `OAuthApp`
 * `revoked` events for our own cleanup, and forwards everything else to the
 * adapter's default handler.
 */
export function createLinearWebhookHandler(chat: Chat, linearAdapter: LinearAdapter) {
  return async (request: Request, options?: WebhookOptions): Promise<Response> => {
    let body: string;
    try {
      body = new TextDecoder().decode(await readBoundedRawBody(request));
    } catch (error) {
      if (error instanceof WebhookBodyTooLargeError) {
        return new Response('Payload too large', { status: 413 });
      }
      throw error;
    }

    if (!verifyLinearSignature(body, request)) {
      return new Response('Invalid signature', { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response('Invalid signature', { status: 401 });
    }

    if (!isFreshWebhookDelivery(payload)) {
      return new Response('Invalid signature', { status: 401 });
    }

    await chat.initialize();

    if (isLinearOAuthAppRevokedPayload(payload)) {
      try {
        await handleLinearOAuthAppRevoked(payload.organizationId, chat, linearAdapter);
      } catch (error) {
        console.error('[Bot] Failed to handle Linear OAuth revoke event:', error);
        captureException(error, {
          tags: { component: 'kilo-bot', op: 'linear-oauth-revoked' },
          extra: { organizationId: payload.organizationId },
        });
      }

      return new Response('ok', { status: 200 });
    }

    return linearAdapter.handleWebhook(cloneLinearRequest(request, body), options);
  };
}
