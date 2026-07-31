import { db } from '@/lib/drizzle';
import { free_model_usage } from '@kilocode/db/schema';

export async function logFreeModelUsage(
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
