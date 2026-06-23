import { organizations } from '@kilocode/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { isValidDomain } from '@/lib/organizations/company-domain';

export type SsoPolicyMisconfigurationReason =
  | 'organization_not_found'
  | 'deleted_parent'
  | 'conflicting_child_policy'
  | 'unsupported_nested_parent'
  | 'invalid_domain'
  | 'ambiguous_domain';

export type EffectiveOrganizationSsoPolicy =
  | {
      status: 'not_required';
      organizationId: string;
    }
  | {
      status: 'required';
      organizationId: string;
      source: 'self' | 'direct_parent';
      sourceOrganizationId: string;
      domain: string;
    }
  | {
      status: 'misconfigured';
      organizationId: string;
      reason: SsoPolicyMisconfigurationReason;
    };

export type SsoDomainAuthority =
  | { status: 'not_required'; domain: string }
  | { status: 'required'; domain: string; sourceOrganizationId: string }
  | {
      status: 'misconfigured';
      domain: string;
      reason: 'invalid_domain' | 'ambiguous_domain' | 'conflicting_child_policy';
    };

type DbOrTransaction = typeof db | DrizzleTransaction;

function normalizeSsoDomain(domain: string): string | null {
  const normalized = domain.trim().toLowerCase();
  return isValidDomain(normalized) ? normalized : null;
}

async function resolveAuthorityForNormalizedDomain(
  domain: string,
  dbOrTx: DbOrTransaction
): Promise<SsoDomainAuthority> {
  const matchingOrganizations = await dbOrTx
    .select({
      id: organizations.id,
      parentOrganizationId: organizations.parent_organization_id,
    })
    .from(organizations)
    .where(
      and(sql`lower(${organizations.sso_domain}) = ${domain}`, isNull(organizations.deleted_at))
    )
    .limit(2);

  if (matchingOrganizations.length === 0) {
    return { status: 'not_required', domain };
  }

  if (matchingOrganizations.length > 1) {
    return { status: 'misconfigured', domain, reason: 'ambiguous_domain' };
  }

  if (matchingOrganizations[0].parentOrganizationId) {
    return { status: 'misconfigured', domain, reason: 'conflicting_child_policy' };
  }

  return {
    status: 'required',
    domain,
    sourceOrganizationId: matchingOrganizations[0].id,
  };
}

export async function resolveSsoAuthorityForDomain(
  domain: string,
  tx?: DrizzleTransaction
): Promise<SsoDomainAuthority> {
  const normalizedDomain = normalizeSsoDomain(domain);
  if (!normalizedDomain) {
    return {
      status: 'misconfigured',
      domain: domain.trim().toLowerCase(),
      reason: 'invalid_domain',
    };
  }

  return resolveAuthorityForNormalizedDomain(normalizedDomain, tx ?? db);
}

export async function resolveEffectiveOrganizationSsoPolicy(
  organizationId: string,
  tx?: DrizzleTransaction
): Promise<EffectiveOrganizationSsoPolicy> {
  const dbOrTx = tx ?? db;
  const [organization] = await dbOrTx
    .select({
      id: organizations.id,
      deletedAt: organizations.deleted_at,
      ssoDomain: organizations.sso_domain,
      parentOrganizationId: organizations.parent_organization_id,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (!organization || organization.deletedAt) {
    return {
      status: 'misconfigured',
      organizationId,
      reason: 'organization_not_found',
    };
  }

  if (organization.parentOrganizationId && organization.ssoDomain) {
    return {
      status: 'misconfigured',
      organizationId,
      reason: 'conflicting_child_policy',
    };
  }

  if (organization.ssoDomain) {
    const domain = normalizeSsoDomain(organization.ssoDomain);
    if (!domain) {
      return { status: 'misconfigured', organizationId, reason: 'invalid_domain' };
    }

    const authority = await resolveAuthorityForNormalizedDomain(domain, dbOrTx);
    if (authority.status === 'misconfigured') {
      return { status: 'misconfigured', organizationId, reason: authority.reason };
    }
    if (authority.status !== 'required' || authority.sourceOrganizationId !== organization.id) {
      return { status: 'misconfigured', organizationId, reason: 'ambiguous_domain' };
    }

    return {
      status: 'required',
      organizationId,
      source: 'self',
      sourceOrganizationId: organization.id,
      domain,
    };
  }

  if (!organization.parentOrganizationId) {
    return { status: 'not_required', organizationId };
  }

  const [parent] = await dbOrTx
    .select({
      id: organizations.id,
      deletedAt: organizations.deleted_at,
      ssoDomain: organizations.sso_domain,
      parentOrganizationId: organizations.parent_organization_id,
    })
    .from(organizations)
    .where(eq(organizations.id, organization.parentOrganizationId))
    .limit(1);

  if (!parent || parent.deletedAt) {
    return { status: 'misconfigured', organizationId, reason: 'deleted_parent' };
  }

  if (parent.parentOrganizationId) {
    return {
      status: 'misconfigured',
      organizationId,
      reason: 'unsupported_nested_parent',
    };
  }

  if (!parent.ssoDomain) {
    return { status: 'not_required', organizationId };
  }

  const domain = normalizeSsoDomain(parent.ssoDomain);
  if (!domain) {
    return { status: 'misconfigured', organizationId, reason: 'invalid_domain' };
  }

  const authority = await resolveAuthorityForNormalizedDomain(domain, dbOrTx);
  if (authority.status === 'misconfigured') {
    return { status: 'misconfigured', organizationId, reason: authority.reason };
  }
  if (authority.status !== 'required' || authority.sourceOrganizationId !== parent.id) {
    return { status: 'misconfigured', organizationId, reason: 'ambiguous_domain' };
  }

  return {
    status: 'required',
    organizationId,
    source: 'direct_parent',
    sourceOrganizationId: parent.id,
    domain,
  };
}
