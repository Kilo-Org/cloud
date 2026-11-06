import type { CloudAgentNextClient } from '@/lib/cloud-agent-next/cloud-agent-client';
import { egressDomainSchema } from '@kilocode/worker-utils/egress-allowlist';

const MAX_PAGES = 10;
const PAGE_SIZE = 100;

function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  if (lower.startsWith('[')) {
    const end = lower.indexOf(']');
    return end === -1 ? lower : lower.slice(1, end);
  }
  return lower.replace(/:\d+$/, '');
}

export async function readEgressHosts(
  client: Pick<CloudAgentNextClient, 'getEgressAudit'>,
  sessionId: string,
  organizationId?: string,
  startCursor?: number
): Promise<{
  hosts: { host: string; requestCount: number }[];
  nextCursor: number | null;
}> {
  const hosts = new Map<string, number>();
  let cursor = startCursor;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await client.getEgressAudit({
      cloudAgentSessionId: sessionId,
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
      ...(organizationId === undefined ? {} : { organizationId }),
    });

    for (const record of response.records) {
      const host = egressDomainSchema.safeParse(normalizeHostname(record.hostname));
      if (!host.success) continue;
      hosts.set(host.data, (hosts.get(host.data) ?? 0) + 1);
    }

    if (response.nextCursor === null) {
      return {
        hosts: Array.from(hosts, ([host, requestCount]) => ({ host, requestCount })),
        nextCursor: null,
      };
    }
    cursor = response.nextCursor;
  }

  return {
    hosts: Array.from(hosts, ([host, requestCount]) => ({ host, requestCount })),
    nextCursor: cursor ?? null,
  };
}
