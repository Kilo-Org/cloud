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
  hosts: { host: string; requestCount: number; deniedRequestCount: number }[];
  nextCursor: number | null;
}> {
  const hosts = new Map<string, { requestCount: number; deniedRequestCount: number }>();
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
      const counts = hosts.get(host.data) ?? { requestCount: 0, deniedRequestCount: 0 };
      counts.requestCount++;
      if (record.decision === 'denied') counts.deniedRequestCount++;
      hosts.set(host.data, counts);
    }

    if (response.nextCursor === null) {
      return {
        hosts: Array.from(hosts, ([host, counts]) => ({ host, ...counts })),
        nextCursor: null,
      };
    }
    cursor = response.nextCursor;
  }

  return {
    hosts: Array.from(hosts, ([host, counts]) => ({ host, ...counts })),
    nextCursor: cursor ?? null,
  };
}
