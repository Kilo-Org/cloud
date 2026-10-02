import { organizations } from '@kilocode/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

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

const parentOrganizations = alias(organizations, 'sso_policy_parent_organizations');

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
  const policies = await resolveEffectiveOrganizationSsoPolicies([organizationId], tx);
  const policy = policies.get(organizationId);
  if (!policy) {
    throw new Error(`Failed to resolve SSO policy for organization ${organizationId}`);
  }
  return policy;
}

export async function resolveEffectiveOrganizationSsoPolicies(
  organizationIds: readonly string[],
  tx?: DrizzleTransaction
): Promise<Map<string, EffectiveOrganizationSsoPolicy>> {
  const uniqueOrganizationIds = [...new Set(organizationIds)];
  if (uniqueOrganizationIds.length === 0) {
    return new Map();
  }

  const dbOrTx = tx ?? db;
  const organizationRows = await dbOrTx
    .select({
      id: organizations.id,
      deletedAt: organizations.deleted_at,
      ssoDomain: organizations.sso_domain,
      parentOrganizationId: organizations.parent_organization_id,
      parentId: parentOrganizations.id,
      parentDeletedAt: parentOrganizations.deleted_at,
      parentSsoDomain: parentOrganizations.sso_domain,
      parentParentOrganizationId: parentOrganizations.parent_organization_id,
    })
    .from(organizations)
    .leftJoin(parentOrganizations, eq(organizations.parent_organization_id, parentOrganizations.id))
    .where(inArray(organizations.id, uniqueOrganizationIds));

  const normalizedDomains = new Set<string>();
  for (const organization of organizationRows) {
    if (organization.ssoDomain) {
      const domain = normalizeSsoDomain(organization.ssoDomain);
      if (domain) normalizedDomains.add(domain);
    }
    if (organization.parentSsoDomain) {
      const domain = normalizeSsoDomain(organization.parentSsoDomain);
      if (domain) normalizedDomains.add(domain);
    }
  }

  const authorityRows = await dbOrTx
    .select({
      id: organizations.id,
      ssoDomain: organizations.sso_domain,
      parentOrganizationId: organizations.parent_organization_id,
    })
    .from(organizations)
    .where(
      and(
        inArray(sql`lower(${organizations.sso_domain})`, [...normalizedDomains]),
        isNull(organizations.deleted_at)
      )
    );

  const authoritiesByDomain = new Map<string, typeof authorityRows>();
  for (const authority of authorityRows) {
    if (!authority.ssoDomain) continue;
    const domain = authority.ssoDomain.toLowerCase();
    const matches = authoritiesByDomain.get(domain) ?? [];
    matches.push(authority);
    authoritiesByDomain.set(domain, matches);
  }

  function resolveSourcePolicy(
    organizationId: string,
    source: 'self' | 'direct_parent',
    sourceOrganizationId: string,
    rawDomain: string
  ): EffectiveOrganizationSsoPolicy {
    const domain = normalizeSsoDomain(rawDomain);
    if (!domain) {
      return { status: 'misconfigured', organizationId, reason: 'invalid_domain' };
    }

    const matchingAuthorities = authoritiesByDomain.get(domain) ?? [];
    if (matchingAuthorities.length > 1) {
      return { status: 'misconfigured', organizationId, reason: 'ambiguous_domain' };
    }

    const authority = matchingAuthorities[0];
    if (authority?.parentOrganizationId) {
      return { status: 'misconfigured', organizationId, reason: 'conflicting_child_policy' };
    }
    if (!authority || authority.id !== sourceOrganizationId) {
      return { status: 'misconfigured', organizationId, reason: 'ambiguous_domain' };
    }

    return {
      status: 'required',
      organizationId,
      source,
      sourceOrganizationId,
      domain,
    };
  }

  const organizationsById = new Map(
    organizationRows.map(organization => [organization.id, organization])
  );
  const policies = new Map<string, EffectiveOrganizationSsoPolicy>();

  for (const organizationId of uniqueOrganizationIds) {
    const organization = organizationsById.get(organizationId);
    if (!organization || organization.deletedAt) {
      policies.set(organizationId, {
        status: 'misconfigured',
        organizationId,
        reason: 'organization_not_found',
      });
      continue;
    }

    if (organization.parentOrganizationId && organization.ssoDomain) {
      policies.set(organizationId, {
        status: 'misconfigured',
        organizationId,
        reason: 'conflicting_child_policy',
      });
      continue;
    }

    if (organization.ssoDomain) {
      policies.set(
        organizationId,
        resolveSourcePolicy(organizationId, 'self', organization.id, organization.ssoDomain)
      );
      continue;
    }

    if (!organization.parentOrganizationId) {
      policies.set(organizationId, { status: 'not_required', organizationId });
      continue;
    }

    if (!organization.parentId || organization.parentDeletedAt) {
      policies.set(organizationId, {
        status: 'misconfigured',
        organizationId,
        reason: 'deleted_parent',
      });
      continue;
    }

    if (organization.parentParentOrganizationId) {
      policies.set(organizationId, {
        status: 'misconfigured',
        organizationId,
        reason: 'unsupported_nested_parent',
      });
      continue;
    }

    if (!organization.parentSsoDomain) {
      policies.set(organizationId, { status: 'not_required', organizationId });
      continue;
    }

    policies.set(
      organizationId,
      resolveSourcePolicy(
        organizationId,
        'direct_parent',
        organization.parentId,
        organization.parentSsoDomain
      )
    );
  }

  return policies;
}
