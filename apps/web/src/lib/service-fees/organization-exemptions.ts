import 'server-only';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

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
  execute: (query: unknown) => Promise<unknown>;
  transaction?: <T>(fn: (tx: OrganizationExemptionExecutor) => Promise<T>) => Promise<T>;
};

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

/**
 * Normalize a database timestamptz string (including production shapes such as
 * `2026-04-29 01:16:12.945+00`) to UTC ISO-8601 at the API boundary.
 */
export function normalizeOrganizationExemptionTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('organization exemption timestamp is invalid');
  }
  return date.toISOString();
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

function withNormalizedTimestamp(
  record: OrganizationServiceFeeExemptionRecord
): OrganizationServiceFeeExemptionRecord {
  return {
    ...record,
    createdAt: normalizeOrganizationExemptionTimestamp(record.createdAt),
  };
}

export async function getEffectiveOrganizationServiceFeeExemption(params: {
  store: OrganizationServiceFeeExemptionStore;
  organizationId: string;
  at: Date;
}): Promise<OrganizationServiceFeeExemptionRecord | null> {
  if (Number.isNaN(params.at.getTime())) {
    throw new Error('eligibility timestamp is invalid');
  }
  const exemption = await params.store.findAtOrBefore(params.organizationId, params.at);
  return exemption ? withNormalizedTimestamp(exemption) : null;
}

export async function getOrganizationServiceFeeExemption(params: {
  store: OrganizationServiceFeeExemptionStore;
  organizationId: string;
}): Promise<OrganizationServiceFeeExemptionView> {
  const [current, history] = await Promise.all([
    params.store.getCurrent(params.organizationId),
    params.store.listNewestFirst(params.organizationId),
  ]);

  return {
    current: current ? withNormalizedTimestamp(current) : null,
    history: history.map(withNormalizedTimestamp),
  };
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
  const nowIso = normalizeOrganizationExemptionTimestamp(params.now ?? new Date());

  return params.store.transact(async store => {
    await store.lockOrganization(params.organizationId);

    const organization = await store.findActiveOrganization(params.organizationId);
    if (!organization) {
      throw new OrganizationServiceFeeExemptionError(
        'organization_not_found',
        'organization is missing or deleted'
      );
    }

    const exemption = withNormalizedTimestamp(
      await store.insert({
        id: randomUUID(),
        organizationId: params.organizationId,
        isExempt: params.isExempt,
        reason,
        changedByKiloUserId: params.changedByKiloUserId,
        createdAt: nowIso,
      })
    );

    return { current: exemption, history: exemption };
  });
}
