import 'server-only';
import { z } from 'zod';
import type { ContainerUsageBillingMode } from '@kilocode/db/schema';
import type { CloudflareContainersInstance } from '@kilocode/worker-utils/sandbox-allocation';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { fetchWithinBudget } from '@/lib/bounded-service-fetch';

/** Whether a user's personal Cloud Agent sandboxes of this size are charged or only metered. */
export async function readPersonalContainersBillingMode(
  userId: string,
  instance: CloudflareContainersInstance
): Promise<ContainerUsageBillingMode> {
  const baseUrl = getEnvVariable('CLOUD_AGENT_NEXT_API_URL');
  if (!baseUrl) throw new Error('Cloud Agent billing status is unavailable');
  const response = await fetchWithinBudget(
    `${baseUrl}/internal/containers/billing/user/${encodeURIComponent(userId)}/${instance}`,
    { headers: { 'x-internal-api-key': INTERNAL_API_SECRET }, cache: 'no-store' }
  );
  if (!response.ok) throw new Error('Cloud Agent billing status is unavailable');
  return z.object({ billingMode: z.enum(['shadow', 'paid']) }).parse(await response.json())
    .billingMode;
}
