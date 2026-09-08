import crypto from 'node:crypto';
import type { Chat, WebhookOptions } from 'chat';
import type { SlackAdapter } from '@chat-adapter/slack';
import { captureException } from '@sentry/nextjs';
import { unlinkTeamKiloUsers } from '@/lib/bot-identity';
import { withProviderInstallationLock } from '@/lib/integrations/provider-installation-lock';
import { deleteInstallationByTeamId } from '@/lib/integrations/slack-service';
import { SLACK_SIGNING_SECRET } from '@/lib/config.server';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { db } from '@/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

const SLACK_SIGNATURE_VERSION = 'v0';
const SLACK_SIGNATURE_TOLERANCE_SECONDS = 60 * 5;

type SlackAppUninstalledPayload = {
  type: 'event_callback';
  team_id: string;
  event: {
    type: 'app_uninstalled';
  };
};

function verifySlackSignature(body: string, request: Request): boolean {
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');

  if (!timestamp || !signature) return false;

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (Number.isNaN(timestampSeconds)) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > SLACK_SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  const signatureBaseString = `${SLACK_SIGNATURE_VERSION}:${timestamp}:${body}`;
  const expectedSignature = `${SLACK_SIGNATURE_VERSION}=${crypto
    .createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(signatureBaseString)
    .digest('hex')}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  } catch {
    return false;
  }
}

function isSlackAppUninstalledPayload(payload: unknown): payload is SlackAppUninstalledPayload {
  return (
    !!payload &&
    typeof payload === 'object' &&
    'type' in payload &&
    payload.type === 'event_callback' &&
    'team_id' in payload &&
    typeof payload.team_id === 'string' &&
    'event' in payload &&
    !!payload.event &&
    typeof payload.event === 'object' &&
    'type' in payload.event &&
    payload.event.type === 'app_uninstalled'
  );
}

async function handleSlackAppUninstalled(
  teamId: string,
  eventTimestampMs: number,
  chat: Chat,
  slackAdapter: SlackAdapter
): Promise<void> {
  const [candidate] = await db
    .select({ id: platform_integrations.id, updatedAt: platform_integrations.updated_at })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.SLACK),
        eq(platform_integrations.platform_installation_id, teamId)
      )
    )
    .limit(1);
  if (!candidate) return;
  try {
    await withProviderInstallationLock({
      platform: PLATFORM.SLACK,
      installationId: teamId,
      callback: async () => {
        const [current] = await db
          .select({ id: platform_integrations.id, updatedAt: platform_integrations.updated_at })
          .from(platform_integrations)
          .where(eq(platform_integrations.id, candidate.id))
          .limit(1);
        if (
          !current ||
          current.updatedAt !== candidate.updatedAt ||
          Date.parse(current.updatedAt) > eventTimestampMs
        )
          return;
        await slackAdapter.deleteInstallation(teamId);
        await deleteInstallationByTeamId(teamId);
        await unlinkTeamKiloUsers(chat.getState(), PLATFORM.SLACK, teamId);
      },
    });
  } catch (error) {
    captureException(error, {
      level: 'error',
      tags: { component: 'kilo-bot', op: 'slack-app-uninstalled' },
      extra: { teamId },
    });
  }
}

function cloneSlackRequest(request: Request, body: BodyInit): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });
}

/**
 * Returns a webhook handler that verifies the Slack signature, peels off the
 * `app_uninstalled` event for our own cleanup, and forwards everything else to
 * the Slack adapter.
 */
export function createSlackWebhookHandler(chat: Chat, slackAdapter: SlackAdapter) {
  return async (request: Request, options?: WebhookOptions): Promise<Response> => {
    const body = await request.text();

    if (!verifySlackSignature(body, request)) {
      return new Response('Invalid signature', { status: 401 });
    }

    await chat.initialize();

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return slackAdapter.handleWebhook(cloneSlackRequest(request, body), options);
    }

    if (isSlackAppUninstalledPayload(payload)) {
      try {
        const timestampSeconds = Number.parseInt(
          request.headers.get('x-slack-request-timestamp') ?? '',
          10
        );
        await handleSlackAppUninstalled(
          payload.team_id,
          timestampSeconds * 1000,
          chat,
          slackAdapter
        );
      } catch (error) {
        console.error('[Bot] Failed to handle Slack app_uninstalled event:', error);
        captureException(error, {
          tags: { component: 'kilo-bot', op: 'slack-app-uninstalled' },
          extra: { teamId: payload.team_id },
        });
      }

      return new Response('ok', { status: 200 });
    }

    return slackAdapter.handleWebhook(cloneSlackRequest(request, body), options);
  };
}
