import { z } from 'zod';
import { recordAlertFired, shouldSuppress } from './dedup';
import { sendAlertNotification, type AlertPayload } from './notify';

export const NATIVE_CONTAINER_APP = 'cloud-agent-next-sandboxcontainers';
export const CONTAINER_ALLOCATION_THRESHOLDS = { info: 500, ticket: 1000, page: 5000 } as const;

export type ContainerAllocations = {
  running: number;
  provisioning: number;
  stopping: number;
};

type AllocationEnv = {
  O11Y_CF_ACCOUNT_ID: string;
  O11Y_CF_CONTAINERS_API_TOKEN: SecretsStoreSecret;
  O11Y_ALERT_STATE: KVNamespace;
  O11Y_SLACK_WEBHOOK_PAGE: SecretsStoreSecret;
  O11Y_SLACK_WEBHOOK_TICKET: SecretsStoreSecret;
};

const PaginationSchema = z.object({ next_page_token: z.string().optional() });
const ApplicationsSchema = z.object({
  success: z.literal(true),
  result: z.array(z.object({ id: z.string(), name: z.string(), scheduling_policy: z.string() })),
  result_info: PaginationSchema,
});
const InstancesSchema = z.object({
  success: z.literal(true),
  result: z.array(
    z.object({
      id: z.string(),
      status: z.object({ state: z.enum(['running', 'provisioning', 'stopping']) }),
    })
  ),
  result_info: PaginationSchema,
});

export async function queryContainerAllocations(
  env: Pick<AllocationEnv, 'O11Y_CF_ACCOUNT_ID' | 'O11Y_CF_CONTAINERS_API_TOKEN'>,
  fetchFn: typeof fetch = fetch
): Promise<ContainerAllocations> {
  const token = await env.O11Y_CF_CONTAINERS_API_TOKEN.get();
  if (!token) throw new Error('O11Y_CF_CONTAINERS_API_TOKEN secret is not configured');

  const base = `https://api.cloudflare.com/client/v4/accounts/${env.O11Y_CF_ACCOUNT_ID}/containers/applications`;
  const get = async (url: URL) => {
    const response = await fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Container allocations request failed (${response.status})`);
    return response.json();
  };

  let applicationId: string | undefined;
  let pageToken: string | undefined;
  for (let page = 0; page < 50; page++) {
    const url = new URL(base);
    url.searchParams.set('name', NATIVE_CONTAINER_APP);
    url.searchParams.set('per_page', '100');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const response = ApplicationsSchema.parse(await get(url));
    const app = response.result.find(app => app.name === NATIVE_CONTAINER_APP);
    if (app) {
      if (app.scheduling_policy !== 'durable_object') {
        throw new Error(`${NATIVE_CONTAINER_APP} is not a Durable Object-managed application`);
      }
      applicationId = app.id;
      break;
    }
    pageToken = response.result_info.next_page_token;
    if (!pageToken) break;
  }
  if (!applicationId) throw new Error(`Container application not found: ${NATIVE_CONTAINER_APP}`);

  const counts: ContainerAllocations = { running: 0, provisioning: 0, stopping: 0 };
  const seen = new Set<string>();
  pageToken = undefined;
  for (let page = 0; page < 50; page++) {
    const url = new URL(`${base}/${applicationId}/instances-v2`);
    url.searchParams.set('state', 'active');
    url.searchParams.set('per_page', '1000');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const response = InstancesSchema.parse(await get(url));
    for (const instance of response.result) {
      if (seen.has(instance.id)) continue;
      seen.add(instance.id);
      counts[instance.status.state]++;
    }
    pageToken = response.result_info.next_page_token;
    if (!pageToken) return counts;
  }
  throw new Error('Container allocations pagination exceeded 50 pages');
}

export async function evaluateContainerAllocations(
  env: AllocationEnv,
  queryFn = queryContainerAllocations,
  notifyFn: (alert: AlertPayload, env: AllocationEnv) => Promise<void> = sendAlertNotification
): Promise<void> {
  const counts = await queryFn(env);
  const allocatedInstances = counts.running + counts.provisioning + counts.stopping;
  console.log(
    JSON.stringify({
      metric: 'container_allocations',
      application: NATIVE_CONTAINER_APP,
      observedAt: new Date().toISOString(),
      allocatedInstances,
      ...counts,
    })
  );

  const severity =
    allocatedInstances >= CONTAINER_ALLOCATION_THRESHOLDS.page
      ? 'page'
      : allocatedInstances >= CONTAINER_ALLOCATION_THRESHOLDS.ticket
        ? 'ticket'
        : allocatedInstances >= CONTAINER_ALLOCATION_THRESHOLDS.info
          ? 'info'
          : null;
  if (!severity) return;
  const dimension = [
    severity,
    'container_capacity',
    'cloudflare',
    NATIVE_CONTAINER_APP,
    'containers',
  ] as const;
  if (await shouldSuppress(env.O11Y_ALERT_STATE, ...dimension)) return;

  await notifyFn(
    {
      alertType: 'container_capacity',
      severity,
      provider: 'cloudflare',
      model: NATIVE_CONTAINER_APP,
      clientName: 'containers',
      allocatedInstances,
      thresholdCount: CONTAINER_ALLOCATION_THRESHOLDS[severity],
      counts,
    },
    env
  );
  await recordAlertFired(env.O11Y_ALERT_STATE, ...dimension);
}
