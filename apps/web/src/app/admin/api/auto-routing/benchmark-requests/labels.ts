import { auto_routing_custom_routers, kilocode_users, organizations } from '@kilocode/db/schema';
import type { PaidBenchmarkAdminRequest } from '@kilocode/auto-routing-contracts';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { inArray } from 'drizzle-orm';

type AdminOwner = { kind: 'user' | 'org'; ownerId: string };

/**
 * Fills the labels the benchmark worker cannot resolve, because it has no PostgreSQL:
 * the saved pool's name and the email or organization name of every requester and payer.
 * Read-only against the replica. A label lookup failure leaves the ids in place instead
 * of failing the console, since the ids alone still identify the row.
 */
export async function withAdminLabels(
  requests: readonly PaidBenchmarkAdminRequest[]
): Promise<PaidBenchmarkAdminRequest[]> {
  if (requests.length === 0) return [];
  const owners: AdminOwner[] = [];
  for (const request of requests) {
    owners.push({ kind: request.requester.kind, ownerId: request.requester.ownerId });
    for (const payer of request.payers) {
      if (payer.kind !== 'platform') owners.push({ kind: payer.kind, ownerId: payer.ownerId });
    }
  }
  const routerIds = [...new Set(requests.map(request => request.routerId))];
  const userIds = [
    ...new Set(owners.filter(owner => owner.kind === 'user').map(owner => owner.ownerId)),
  ];
  const orgIds = [
    ...new Set(owners.filter(owner => owner.kind === 'org').map(owner => owner.ownerId)),
  ];
  try {
    const [routers, users, orgs] = await Promise.all([
      routerIds.length === 0
        ? []
        : readDb
            .select({ id: auto_routing_custom_routers.id, name: auto_routing_custom_routers.name })
            .from(auto_routing_custom_routers)
            .where(inArray(auto_routing_custom_routers.id, routerIds)),
      userIds.length === 0
        ? []
        : readDb
            .select({ id: kilocode_users.id, label: kilocode_users.google_user_email })
            .from(kilocode_users)
            .where(inArray(kilocode_users.id, userIds)),
      orgIds.length === 0
        ? []
        : readDb
            .select({ id: organizations.id, label: organizations.name })
            .from(organizations)
            .where(inArray(organizations.id, orgIds)),
    ]);
    const poolNames = new Map(routers.map(row => [row.id, row.name]));
    const labels = new Map<string, string>([
      ...users.map(row => [`user:${row.id}`, row.label] as const),
      ...orgs.map(row => [`org:${row.id}`, row.label] as const),
    ]);
    return requests.map(request => ({
      ...request,
      poolName: poolNames.get(request.routerId) ?? null,
      requester: {
        ...request.requester,
        ownerLabel: labels.get(`${request.requester.kind}:${request.requester.ownerId}`) ?? null,
      },
      payers: request.payers.map(payer =>
        payer.kind === 'platform'
          ? payer
          : {
              ...payer,
              ownerLabel: labels.get(`${payer.kind}:${payer.ownerId}`) ?? null,
            }
      ),
    }));
  } catch (error) {
    console.error('Paid benchmark request labels could not be resolved:', error);
    return [...requests];
  }
}
