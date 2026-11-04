import type { CloudAgentNextClient } from '@/lib/cloud-agent-next/cloud-agent-client';

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

export async function readDeniedHosts(
  client: Pick<CloudAgentNextClient, 'getEgressAudit'>,
  childSessionId: string,
  organizationId?: string
): Promise<Map<string, number>> {
  const denied = new Map<string, number>();
  let cursor: number | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await client.getEgressAudit({
      cloudAgentSessionId: childSessionId,
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
      ...(organizationId === undefined ? {} : { organizationId }),
    });

    for (const record of response.records) {
      if (record.decision !== 'denied') continue;
      const host = normalizeHostname(record.hostname);
      denied.set(host, (denied.get(host) ?? 0) + 1);
    }

    if (response.nextCursor === null) break;
    cursor = response.nextCursor;
  }

  return denied;
}
