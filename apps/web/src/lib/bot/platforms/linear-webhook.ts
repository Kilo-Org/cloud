import crypto from 'node:crypto';
import type { Chat, WebhookOptions } from 'chat';
import type { LinearAdapter } from '@chat-adapter/linear';
import { captureException } from '@sentry/nextjs';
import { unlinkTeamKiloUsers } from '@/lib/bot-identity';
import { deleteInstallationByOrganizationId } from '@/lib/integrations/linear-service';
import { LINEAR_WEBHOOK_SECRET } from '@/lib/config.server';
import { PLATFORM } from '@/lib/integrations/core/constants';

/**
 * Linear's webhook signature format, confirmed against @linear/sdk's
 * `LinearWebhookClient.verify`:
 *
 *   linear-signature  = hex(hmac-sha256(webhook_secret, raw_body))
 *   linear-timestamp  = unix millis, tolerance 60s
 *
 * The @chat-adapter/linear adapter already verifies the signature inside its
 * own `handleWebhook`, but we need to also peel off `OAuthApp` revoke events
 * to clean up our own `platform_integrations` row and Redis identity cache.
 * Re-verifying the signature here makes the custom handler safe to trigger
 * the cleanup even before delegating to the adapter.
 */

const LINEAR_SIGNATURE_HEADER = 'linear-signature';
const LINEAR_TIMESTAMP_HEADER = 'linear-timestamp';
const LINEAR_TIMESTAMP_TOLERANCE_MS = 60 * 1000;

type LinearOAuthAppRevokedPayload = {
  type: 'OAuthApp';
  action: 'revoked';
  organizationId: string;
};

function verifyLinearSignature(rawBody: string, request: Request): boolean {
  const signature = request.headers.get(LINEAR_SIGNATURE_HEADER);
  const timestamp = request.headers.get(LINEAR_TIMESTAMP_HEADER);

  // Both headers are mandatory. Treating the timestamp as optional would let
  // an attacker who captures a signed body replay it indefinitely simply by
  // stripping the timestamp header — the HMAC is computed only over rawBody,
  // so the signature alone proves nothing about freshness.
  if (!signature || !timestamp) return false;

  const timestampMs = Number.parseInt(timestamp, 10);
  if (Number.isNaN(timestampMs)) return false;
  if (Math.abs(Date.now() - timestampMs) > LINEAR_TIMESTAMP_TOLERANCE_MS) return false;

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
    const body = await request.text();

    if (!verifyLinearSignature(body, request)) {
      return new Response('Invalid signature', { status: 401 });
    }

    await chat.initialize();

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return linearAdapter.handleWebhook(cloneLinearRequest(request, body), options);
    }

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
