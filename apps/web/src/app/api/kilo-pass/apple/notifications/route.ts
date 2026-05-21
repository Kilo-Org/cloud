import { captureException } from '@sentry/nextjs';
import * as z from 'zod';

import { processAppStoreKiloPassNotification } from '@/lib/kilo-pass/apple-store-notifications';

const AppStoreNotificationBodySchema = z.object({
  signedPayload: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const body = AppStoreNotificationBodySchema.safeParse(await request.json());
    if (!body.success) {
      return Response.json({ error: 'Missing signedPayload' }, { status: 400 });
    }

    const result = await processAppStoreKiloPassNotification({
      signedPayload: body.data.signedPayload,
    });
    if ('status' in result && result.status === 'in_flight') {
      return Response.json(result, { status: 503 });
    }
    return Response.json(result);
  } catch (error) {
    captureException(error, { tags: { source: 'app_store_kilo_pass_notification' } });
    return Response.json({ error: 'Failed to process notification' }, { status: 500 });
  }
}
