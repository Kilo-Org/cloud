/**
 * Cloudflare Containers API client for capacity monitoring.
 *
 * Fetches container application data needed to evaluate capacity thresholds.
 * Uses two endpoints:
 *   - List:   GET /accounts/{id}/containers/dash/applications  (pagination, no max_instances)
 *   - Detail: GET /accounts/{id}/containers/applications/{appId} (includes max_instances)
 *
 * Only fetches detail for monitored applications to minimise API calls.
 */

import {
  ContainerListResponseSchema,
  ContainerDetailResponseSchema,
  MONITORED_CONTAINER_APPS,
  type ContainerApplication,
} from './container-capacity';

type QueryEnv = {
  O11Y_CF_ACCOUNT_ID: string;
  O11Y_CF_CONTAINERS_API_TOKEN: SecretsStoreSecret;
};

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const PER_PAGE = 20;
const MAX_PAGES = 50;

async function fetchListPage(
  accountId: string,
  token: string,
  page: number,
  fetchFn: FetchFn
): Promise<{
  apps: Array<{ id: string; name: string; instances: number; health?: unknown }>;
  totalPages: number;
}> {
  const url = `${CF_API_BASE}/accounts/${accountId}/containers/dash/applications?page=${page}&per_page=${PER_PAGE}`;
  const response = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(`Containers list request failed (${response.status})`);
  }

  const raw = await response.json();
  const parsed = ContainerListResponseSchema.parse(raw);

  const totalPages = parsed.result_info?.total_pages ?? 1;
  return { apps: parsed.result, totalPages };
}

async function fetchDetail(
  accountId: string,
  token: string,
  appId: string,
  fetchFn: FetchFn
): Promise<ContainerApplication> {
  const url = `${CF_API_BASE}/accounts/${accountId}/containers/applications/${appId}`;
  const response = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(`Containers detail request failed for app ${appId} (${response.status})`);
  }

  const raw = await response.json();
  const parsed = ContainerDetailResponseSchema.parse(raw);
  const app = parsed.result;

  return {
    id: app.id,
    name: app.name,
    instances: app.instances,
    maxInstances: app.max_instances,
    health: app.health,
  };
}

/**
 * Fetches all monitored container applications with their current instance counts
 * and maximum instance limits.
 *
 * @param env - Environment bindings with account ID and API token
 * @param fetchFn - Injectable fetch function (defaults to global fetch); used for testing
 */
export async function queryContainerApplications(
  env: QueryEnv,
  fetchFn: FetchFn = fetch
): Promise<ContainerApplication[]> {
  const accountId = env.O11Y_CF_ACCOUNT_ID;
  const token = await env.O11Y_CF_CONTAINERS_API_TOKEN.get();
  if (!token) {
    throw new Error('O11Y_CF_CONTAINERS_API_TOKEN secret is not configured');
  }

  // Collect all monitored app entries across all pages
  const monitoredEntries: Array<{ id: string; name: string; instances: number; health?: unknown }> =
    [];

  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= MAX_PAGES) {
    const result = await fetchListPage(accountId, token, page, fetchFn);
    totalPages = result.totalPages;

    for (const app of result.apps) {
      if (MONITORED_CONTAINER_APPS.includes(app.name)) {
        monitoredEntries.push(app);
      }
    }

    page += 1;
  }

  // Fetch detail for each monitored app to obtain max_instances
  const applications = await Promise.all(
    monitoredEntries.map(entry => fetchDetail(accountId, token, entry.id, fetchFn))
  );

  return applications;
}
