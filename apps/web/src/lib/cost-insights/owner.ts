import type { CostInsightSpendOwner } from '@kilocode/db/cost-insights-rollups';
import type { SQL } from 'drizzle-orm';
import { eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

export type CostInsightOwnerColumns = {
  owned_by_user_id: AnyPgColumn;
  owned_by_organization_id: AnyPgColumn;
};

export type CostInsightOwnerInsertValues =
  | { owned_by_user_id: string; owned_by_organization_id: null }
  | { owned_by_user_id: null; owned_by_organization_id: string };

export function costInsightOwnerInsertValues(
  owner: CostInsightSpendOwner
): CostInsightOwnerInsertValues {
  return owner.type === 'user'
    ? { owned_by_user_id: owner.id, owned_by_organization_id: null }
    : { owned_by_user_id: null, owned_by_organization_id: owner.id };
}

export function costInsightOwnerWhere(
  owner: CostInsightSpendOwner,
  columns: CostInsightOwnerColumns
): SQL {
  return owner.type === 'user'
    ? sql`${columns.owned_by_organization_id} IS NULL AND ${columns.owned_by_user_id} = ${owner.id}`
    : sql`${columns.owned_by_user_id} IS NULL AND ${columns.owned_by_organization_id} = ${owner.id}`;
}

export function costInsightOwnerTargetWhere(
  owner: CostInsightSpendOwner,
  columns: CostInsightOwnerColumns
): SQL {
  return owner.type === 'user'
    ? isNull(columns.owned_by_organization_id)
    : isNull(columns.owned_by_user_id);
}

export function costInsightOwnerTargetColumn(
  owner: CostInsightSpendOwner,
  columns: CostInsightOwnerColumns
): AnyPgColumn {
  return owner.type === 'user' ? columns.owned_by_user_id : columns.owned_by_organization_id;
}

export function costInsightOwnerHasValue(columns: CostInsightOwnerColumns): SQL {
  return sql`((${columns.owned_by_user_id} IS NOT NULL)::int + (${columns.owned_by_organization_id} IS NOT NULL)::int) = 1`;
}

export function costInsightOwnerEquality(
  owner: CostInsightSpendOwner,
  columns: CostInsightOwnerColumns
): SQL {
  return owner.type === 'user'
    ? eq(columns.owned_by_user_id, owner.id)
    : eq(columns.owned_by_organization_id, owner.id);
}

export function costInsightOwnerIsSameKind(
  owner: CostInsightSpendOwner,
  columns: CostInsightOwnerColumns
): SQL {
  return owner.type === 'user'
    ? isNotNull(columns.owned_by_user_id)
    : isNotNull(columns.owned_by_organization_id);
}

export function costInsightOwnerBasePath(owner: CostInsightSpendOwner): string {
  return owner.type === 'user' ? '/cost-insights' : `/organizations/${owner.id}/cost-insights`;
}

export function costInsightOwnerDisplayType(
  owner: CostInsightSpendOwner
): 'personal' | 'organization' {
  return owner.type === 'user' ? 'personal' : 'organization';
}
