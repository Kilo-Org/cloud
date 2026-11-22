import 'server-only';

import { randomUUID } from 'node:crypto';

import { sql, type SQL } from 'drizzle-orm';

import { toIsoTimestamp } from '@kilocode/web-shared/lib/service-fees/values';

export const ORGANIZATION_SERVICE_FEE_EXEMPTION_REASON_MIN_LENGTH = 3;
export const ORGANIZATION_SERVICE_FEE_EXEMPTION_REASON_MAX_LENGTH = 500;
export const ORGANIZATION_SERVICE_FEE_EXEMPTION_LOCK_PREFIX = 'service-fee-exemption:';

export type OrganizationServiceFeeExemptionErrorCode = 'organization_not_found' | 'invalid_reason';

export class OrganizationServiceFeeExemptionError extends Error {
  readonly name = 'OrganizationServiceFeeExemptionError';

  constructor(
    readonly code: OrganizationServiceFeeExemptionErrorCode,
    message: string
  ) {
    super(message);
  }
}

export type OrganizationServiceFeeExemptionRecord = {
  id: string;
  organizationId: string;
  isExempt: boolean;
  reason: string;
  changedByKiloUserId: string | null;
  createdAt: string;
};

export type OrganizationServiceFeeExemptionView = {
  current: OrganizationServiceFeeExemptionRecord | null;
  history: OrganizationServiceFeeExemptionRecord[];
};

export type ActiveOrganizationRef = {
  id: string;
};

/**
 * Drizzle-compatible executor used for organization-scoped advisory locks and
 * optional transactional wrappers. Matches `db` / `tx.execute` / `tx.transaction`.
 */
export type OrganizationExemptionExecutor = {
  execute: (query: SQL) => Promise<unknown>;
  transaction?: <T>(fn: (tx: OrganizationExemptionExecutor) => Promise<T>) => Promise<T>;
};

/**
 * Persistence port for organization service fee exemptions. Implementations
 * return records whose `createdAt` is a normalized UTC ISO-8601 string (the
 * drizzle store normalizes in its row mapper), so callers do not re-normalize.
 */
export type OrganizationServiceFeeExemptionStore = {
  transact<T>(fn: (store: OrganizationServiceFeeExemptionStore) => Promise<T>): Promise<T>;
  lockOrganization(organizationId: string): Promise<void>;
  findActiveOrganization(organizationId: string): Promise<ActiveOrganizationRef | null>;
  findAtOrBefore(
    organizationId: string,
    at: Date
  ): Promise<OrganizationServiceFeeExemptionRecord | null>;
  listNewestFirst(organizationId: string): Promise<OrganizationServiceFeeExemptionRecord[]>;
  getCurrent(organizationId: string): Promise<OrganizationServiceFeeExemptionRecord | null>;
  insert(
    record: OrganizationServiceFeeExemptionRecord
  ): Promise<OrganizationServiceFeeExemptionRecord>;
};

export function organizationServiceFeeExemptionLockKey(organizationId: string): string {
  return `${ORGANIZATION_SERVICE_FEE_EXEMPTION_LOCK_PREFIX}${organizationId}`;
}

export async function acquireOrganizationServiceFeeExemptionLock(
  executor: Pick<OrganizationExemptionExecutor, 'execute'>,
  organizationId: string
): Promise<void> {
  await executor.execute(
    sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${organizationServiceFeeExemptionLockKey(organizationId)}, 0))`
  );
}

export function normalizeOrganizationServiceFeeExemptionReason(reason: string): string {
  const trimmed = reason.trim();
  if (
    trimmed.length < ORGANIZATION_SERVICE_FEE_EXEMPTION_REASON_MIN_LENGTH ||
    trimmed.length > ORGANIZATION_SERVICE_FEE_EXEMPTION_REASON_MAX_LENGTH
  ) {
    throw new OrganizationServiceFeeExemptionError(
      'invalid_reason',
      `reason must be ${ORGANIZATION_SERVICE_FEE_EXEMPTION_REASON_MIN_LENGTH} to ${ORGANIZATION_SERVICE_FEE_EXEMPTION_REASON_MAX_LENGTH} characters after trimming`
    );
  }
  return trimmed;
}

export async function getEffectiveOrganizationServiceFeeExemption(params: {
  store: OrganizationServiceFeeExemptionStore;
  organizationId: string;
  at: Date;
}): Promise<OrganizationServiceFeeExemptionRecord | null> {
  if (Number.isNaN(params.at.getTime())) {
    throw new Error('eligibility timestamp is invalid');
  }
  return params.store.findAtOrBefore(params.organizationId, params.at);
}

export async function getOrganizationServiceFeeExemption(params: {
  store: OrganizationServiceFeeExemptionStore;
  organizationId: string;
}): Promise<OrganizationServiceFeeExemptionView> {
  const [current, history] = await Promise.all([
    params.store.getCurrent(params.organizationId),
    params.store.listNewestFirst(params.organizationId),
  ]);

  return { current, history };
}

export async function setOrganizationServiceFeeExemption(params: {
  store: OrganizationServiceFeeExemptionStore;
  organizationId: string;
  isExempt: boolean;
  reason: string;
  changedByKiloUserId: string | null;
  now?: Date;
}): Promise<{
  current: OrganizationServiceFeeExemptionRecord;
  history: OrganizationServiceFeeExemptionRecord;
}> {
  const reason = normalizeOrganizationServiceFeeExemptionReason(params.reason);
  const requestedAt = params.now ?? new Date();
  const requestedAtIso = toIsoTimestamp(requestedAt, 'organization exemption');

  return params.store.transact(async store => {
    await store.lockOrganization(params.organizationId);

    const organization = await store.findActiveOrganization(params.organizationId);
    if (!organization) {
      throw new OrganizationServiceFeeExemptionError(
        'organization_not_found',
        'organization is missing or deleted'
      );
    }

    const current = await store.getCurrent(params.organizationId);
    const currentAt = current ? new Date(current.createdAt).getTime() : Number.NEGATIVE_INFINITY;
    const createdAt =
      requestedAt.getTime() > currentAt ? requestedAtIso : new Date(currentAt + 1).toISOString();

    const exemption = await store.insert({
      id: randomUUID(),
      organizationId: params.organizationId,
      isExempt: params.isExempt,
      reason,
      changedByKiloUserId: params.changedByKiloUserId,
      createdAt,
    });

    return { current: exemption, history: exemption };
  });
}
