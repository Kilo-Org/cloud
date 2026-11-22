import { organizations } from '@kilocode/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import {
  db,
  type DrizzleConnection,
  type DrizzleTransaction,
} from '@kilocode/web-shared/lib/drizzle';
import { normalizeSsoDomain } from '@kilocode/web-shared/lib/organizations/company-domain';

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

type SsoAuthorityRow = {
  id: string;
  ssoDomain: string | null;
  parentOrganizationId: string | null;
};

const parentOrganizations = alias(organizations, 'sso_policy_parent_organizations');

type DomainAuthorityMatch =
  | { status: 'unmatched' }
  | { status: 'ambiguous' }
  | { status: 'conflicting_child_policy' }
  | { status: 'authoritative'; sourceOrganizationId: string };

/**
 * The domain-authority rule, decided from the live organizations whose
 * `sso_domain` normalizes to the domain. A domain that several organizations
 * claim, or that belongs to a child organization, is a misconfiguration; the
 * remaining match is authoritative only for the organization it was read from,
 * when the caller names one.
 */
function decideDomainAuthority(
  matches: readonly Pick<SsoAuthorityRow, 'id' | 'parentOrganizationId'>[],
  expectedSourceOrganizationId?: string
): DomainAuthorityMatch {
  if (matches.length > 1) {
    return { status: 'ambiguous' };
  }

  const [match] = matches;
  if (!match) {
    return { status: 'unmatched' };
  }

  if (match.parentOrganizationId) {
    return { status: 'conflicting_child_policy' };
  }

  if (expectedSourceOrganizationId && match.id !== expectedSourceOrganizationId) {
    return { status: 'ambiguous' };
  }

  return { status: 'authoritative', sourceOrganizationId: match.id };
}

/**
 * The live organizations that claim any of the given normalized domains. One
 * domain can be claimed by several organizations, so the caller groups the rows
 * by domain and lets `decideDomainAuthority` judge each group.
 */
async function loadLiveDomainAuthorities(
  domains: readonly string[],
  dbOrTx: DrizzleConnection
): Promise<SsoAuthorityRow[]> {
  if (domains.length === 0) {
    return [];
  }

  return dbOrTx
    .select({
      id: organizations.id,
      ssoDomain: organizations.sso_domain,
      parentOrganizationId: organizations.parent_organization_id,
    })
    .from(organizations)
    .where(
      and(
        inArray(sql`lower(${organizations.sso_domain})`, [...domains]),
        isNull(organizations.deleted_at)
      )
    );
}

async function resolveAuthorityForNormalizedDomain(
  domain: string,
  dbOrTx: DrizzleConnection
): Promise<SsoDomainAuthority> {
  const match = decideDomainAuthority(await loadLiveDomainAuthorities([domain], dbOrTx));

  switch (match.status) {
    case 'unmatched':
      return { status: 'not_required', domain };
    case 'ambiguous':
      return { status: 'misconfigured', domain, reason: 'ambiguous_domain' };
    case 'conflicting_child_policy':
      return { status: 'misconfigured', domain, reason: 'conflicting_child_policy' };
    case 'authoritative':
      return { status: 'required', domain, sourceOrganizationId: match.sourceOrganizationId };
  }
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

/** An organization row together with its parent, as the policy decision reads them. */
type OrganizationSsoRow = {
  id: string;
  deletedAt: string | null;
  ssoDomain: string | null;
  parentOrganizationId: string | null;
  parentId: string | null;
  parentDeletedAt: string | null;
  parentSsoDomain: string | null;
  parentParentOrganizationId: string | null;
};

/**
 * Everything the per-organization decision reads: the requested organizations
 * with their parents, and the live authorities of every domain those rows
 * mention, grouped by normalized domain.
 */
type OrganizationSsoInput = {
  organizationsById: Map<string, OrganizationSsoRow>;
  authoritiesByDomain: Map<string, SsoAuthorityRow[]>;
};

async function loadOrganizationSsoInput(
  organizationIds: readonly string[],
  dbOrTx: DrizzleConnection
): Promise<OrganizationSsoInput> {
  const organizationRows: OrganizationSsoRow[] = await dbOrTx
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
    .where(inArray(organizations.id, [...organizationIds]));

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

  // The authority map is only consulted for organizations that carry a domain, so an empty set
  // needs no lookup; the loader answers the empty case without a query.
  const authorityRows = await loadLiveDomainAuthorities([...normalizedDomains], dbOrTx);

  const authoritiesByDomain = new Map<string, SsoAuthorityRow[]>();
  for (const authority of authorityRows) {
    if (!authority.ssoDomain) continue;
    const domain = normalizeSsoDomain(authority.ssoDomain);
    if (!domain) continue;
    const matches = authoritiesByDomain.get(domain) ?? [];
    matches.push(authority);
    authoritiesByDomain.set(domain, matches);
  }

  return {
    organizationsById: new Map(
      organizationRows.map(organization => [organization.id, organization])
    ),
    authoritiesByDomain,
  };
}

/** The policy that applies when the organization's own domain or its parent's is authoritative. */
function resolveSourcePolicy(
  authoritiesByDomain: Map<string, SsoAuthorityRow[]>,
  organizationId: string,
  source: 'self' | 'direct_parent',
  sourceOrganizationId: string,
  rawDomain: string
): EffectiveOrganizationSsoPolicy {
  const domain = normalizeSsoDomain(rawDomain);
  if (!domain) {
    return { status: 'misconfigured', organizationId, reason: 'invalid_domain' };
  }

  const match = decideDomainAuthority(authoritiesByDomain.get(domain) ?? [], sourceOrganizationId);

  switch (match.status) {
    case 'conflicting_child_policy':
      return { status: 'misconfigured', organizationId, reason: 'conflicting_child_policy' };
    case 'unmatched':
    case 'ambiguous':
      return { status: 'misconfigured', organizationId, reason: 'ambiguous_domain' };
    case 'authoritative':
      return {
        status: 'required',
        organizationId,
        source,
        sourceOrganizationId,
        domain,
      };
  }
}

/**
 * The policy of one organization, decided from the rows it was loaded with.
 * Every requested id gets a policy: an id whose row was not loaded is reported
 * as `organization_not_found`, the same as a soft-deleted row.
 */
function decideOrganizationSsoPolicy(
  { organizationsById, authoritiesByDomain }: OrganizationSsoInput,
  organizationId: string
): EffectiveOrganizationSsoPolicy {
  const organization = organizationsById.get(organizationId);
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
    return resolveSourcePolicy(
      authoritiesByDomain,
      organizationId,
      'self',
      organization.id,
      organization.ssoDomain
    );
  }

  if (!organization.parentOrganizationId) {
    return { status: 'not_required', organizationId };
  }

  if (!organization.parentId || organization.parentDeletedAt) {
    return {
      status: 'misconfigured',
      organizationId,
      reason: 'deleted_parent',
    };
  }

  if (organization.parentParentOrganizationId) {
    return {
      status: 'misconfigured',
      organizationId,
      reason: 'unsupported_nested_parent',
    };
  }

  if (!organization.parentSsoDomain) {
    return { status: 'not_required', organizationId };
  }

  return resolveSourcePolicy(
    authoritiesByDomain,
    organizationId,
    'direct_parent',
    organization.parentId,
    organization.parentSsoDomain
  );
}

export async function resolveEffectiveOrganizationSsoPolicy(
  organizationId: string,
  tx?: DrizzleTransaction
): Promise<EffectiveOrganizationSsoPolicy> {
  const input = await loadOrganizationSsoInput([organizationId], tx ?? db);
  return decideOrganizationSsoPolicy(input, organizationId);
}

export async function resolveEffectiveOrganizationSsoPolicies(
  organizationIds: readonly string[],
  tx?: DrizzleTransaction
): Promise<Map<string, EffectiveOrganizationSsoPolicy>> {
  const uniqueOrganizationIds = [...new Set(organizationIds)];
  if (uniqueOrganizationIds.length === 0) {
    return new Map();
  }

  const input = await loadOrganizationSsoInput(uniqueOrganizationIds, tx ?? db);
  return new Map(
    uniqueOrganizationIds.map(organizationId => [
      organizationId,
      decideOrganizationSsoPolicy(input, organizationId),
    ])
  );
}
