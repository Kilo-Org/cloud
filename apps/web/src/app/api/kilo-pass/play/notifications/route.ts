import { captureException } from '@sentry/nextjs';
import * as z from 'zod';
import { OAuth2Client } from 'google-auth-library';

import { getEnvVariable } from '@/lib/dotenvx';
import { processGooglePlayKiloPassNotification } from '@/lib/kilo-pass/google-play-notifications';

const GooglePlayNotificationBodySchema = z.object({
  message: z.object({
    data: z.string().min(1),
    messageId: z.string().optional(),
  }),
});

async function verifyGooglePlayRtdnToken(idToken: string): Promise<void> {
  const audience = getEnvVariable('GOOGLE_PLAY_RTDN_PUSH_AUDIENCE');
  if (!audience) {
    throw new Error('GOOGLE_PLAY_RTDN_PUSH_AUDIENCE is not set');
  }
  const expectedEmail = getEnvVariable('GOOGLE_PLAY_RTDN_PUSH_SERVICE_ACCOUNT_EMAIL');
  if (!expectedEmail) {
    throw new Error('GOOGLE_PLAY_RTDN_PUSH_SERVICE_ACCOUNT_EMAIL is not set');
  }
  const client = new OAuth2Client();
  const ticket = await client.verifyIdToken({ idToken, audience });
  const payload = ticket.getPayload();
  if (!payload?.email || payload.email_verified !== true) {
    throw new Error('Play RTDN push token email is not verified');
  }
  if (payload.email !== expectedEmail) {
    throw new Error('Play RTDN push token email does not match the configured service account');
  }
}

export async function POST(request: Request) {
  try {
    const authorization = request.headers.get('authorization');
    const bearerToken = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : null;
    if (!bearerToken) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
      await verifyGooglePlayRtdnToken(bearerToken);
    } catch {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      // A body that is not JSON can never become valid, so answer 400 and stop
      // Pub/Sub from redelivering it.
      return Response.json({ error: 'Missing Pub/Sub message data' }, { status: 400 });
    }

    const body = GooglePlayNotificationBodySchema.safeParse(rawBody);
    if (!body.success) {
      return Response.json({ error: 'Missing Pub/Sub message data' }, { status: 400 });
    }

    const result = await processGooglePlayKiloPassNotification({
      pubsubMessage: {
        data: body.data.message.data,
        messageId: body.data.message.messageId,
      },
    });
    if ('status' in result && result.status === 'in_flight') {
      return Response.json(result, { status: 503 });
    }
    return Response.json(result);
  } catch (error) {
    captureException(error, { tags: { source: 'google_play_kilo_pass_notification' } });
    return Response.json({ error: 'Failed to process notification' }, { status: 500 });
  }
}
