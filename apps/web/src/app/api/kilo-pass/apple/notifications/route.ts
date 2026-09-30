import { captureException } from '@sentry/nextjs';
import * as z from 'zod';

import { processAppStoreKiloPassNotification } from '@/lib/kilo-pass/apple-store-notifications';
import { sanitizeErrorForTelemetry } from '@/lib/sanitize-error-for-telemetry';

const AppStoreNotificationBodySchema = z.object({
  signedPayload: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    // A body that is not JSON is a bad request, not a server fault. A 5xx would
    // make Apple retry a request that can never succeed.
    const rawBody = await request.json().catch(() => undefined);
    const body = AppStoreNotificationBodySchema.safeParse(rawBody);
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
    // The failure may be a database error that quotes the bound parameters of a
    // store-credential lookup, so it is sanitized before it is reported.
    captureException(sanitizeErrorForTelemetry(error), {
      tags: { source: 'app_store_kilo_pass_notification' },
    });
    return Response.json({ error: 'Failed to process notification' }, { status: 500 });
  }
}
