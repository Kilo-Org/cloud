import { captureException } from '@sentry/nextjs';
import { after } from 'next/server';
import { db } from '@/lib/drizzle';
import { free_model_usage } from '@kilocode/db/schema';

async function logFreeModelUsage(
  ipAddress: string,
  model: string,
  kiloUserId?: string
): Promise<void> {
  await db.insert(free_model_usage).values({
    ip_address: ipAddress,
    model,
    kilo_user_id: kiloUserId,
  });
}

export function scheduleFreeModelUsageLog(
  ipAddress: string,
  model: string,
  kiloUserId?: string
): void {
  after(async () => {
    try {
      await logFreeModelUsage(ipAddress, model, kiloUserId);
    } catch (error) {
      captureException(error, { tags: { source: 'free_model_usage' } });
    }
  });
}
