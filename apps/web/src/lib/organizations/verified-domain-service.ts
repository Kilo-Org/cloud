import 'server-only';

import { WORKOS_API_KEY } from '@/lib/config.server';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { canonicalizeEligibleVerifiedDomain } from '@/lib/organizations/verified-domain';
import {
  organization_domain_claims,
  organizations,
  type OrganizationDomainClaim,
  type User,
} from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import {
  GeneratePortalLinkIntent,
  OrganizationDomainState,
  WorkOS,
  type Organization,
  type OrganizationDomain,
} from '@workos-inc/node';
import { and, asc, eq, ne, sql } from 'drizzle-orm';

type VerifiedDomainProvider = Pick<WorkOS, 'organizationDomains' | 'organizations' | 'portal'>;
type Actor = Pick<User, 'google_user_email' | 'google_user_name' | 'id'>;

export type VerifiedDomainClaimView = {
  id: string;
  domain: string;
  status: 'pending' | 'verified';
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const workos = new WorkOS(WORKOS_API_KEY);
const CONFLICT_MESSAGE = 'This domain cannot be claimed';
const PROVIDER_ERROR_MESSAGE = 'Domain verification provider request failed';

function providerStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('status' in error)) return null;
  return typeof error.status === 'number' ? error.status : null;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && error.code === '23505') return true;
  return 'cause' in error && isUniqueViolation(error.cause);
}

function conflictError(): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message: CONFLICT_MESSAGE });
}

function providerError(error: unknown): TRPCError {
  if (providerStatus(error) === 409) return conflictError();
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: PROVIDER_ERROR_MESSAGE,
    cause: error,
  });
}

function serializeClaim(claim: OrganizationDomainClaim): VerifiedDomainClaimView {
  return {
    id: claim.id,
    domain: claim.domain,
    status: claim.status,
    verifiedAt: claim.verified_at ? new Date(claim.verified_at).toISOString() : null,
    createdAt: new Date(claim.created_at).toISOString(),
    updatedAt: new Date(claim.updated_at).toISOString(),
  };
}

async function lockDomain(tx: DrizzleTransaction, domain: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('verified-domain:' || ${domain}, 0))`
  );
}

async function getWorkOsOrganizationByExternalId(
  provider: VerifiedDomainProvider,
  organizationId: string
): Promise<Organization | null> {
  try {
    return await provider.organizations.getOrganizationByExternalId(organizationId);
  } catch (error) {
    if (providerStatus(error) === 404) return null;
    throw providerError(error);
  }
}

async function getOrCreateWorkOsOrganization(
  provider: VerifiedDomainProvider,
  organization: { id: string; name: string }
): Promise<Organization> {
  const existing = await getWorkOsOrganizationByExternalId(provider, organization.id);
  if (existing) return existing;

  try {
    return await provider.organizations.createOrganization(
      { name: organization.name, externalId: organization.id },
      { idempotencyKey: `verified-domain-${organization.id}` }
    );
  } catch (error) {
    if (providerStatus(error) === 409) {
      const raced = await getWorkOsOrganizationByExternalId(provider, organization.id);
      if (raced) return raced;
    }
    throw providerError(error);
  }
}

function matchingProviderDomain(
  workOsOrganization: Organization,
  domain: string
): OrganizationDomain | undefined {
  return workOsOrganization.domains.find(candidate => candidate.domain.toLowerCase() === domain);
}

async function ensureProviderDomain(
  provider: VerifiedDomainProvider,
  claim: OrganizationDomainClaim,
  organization: { id: string; name: string }
): Promise<OrganizationDomain> {
  const workOsOrganization = await getOrCreateWorkOsOrganization(provider, organization);
  let providerDomain = matchingProviderDomain(workOsOrganization, claim.domain);

  if (!providerDomain && claim.workos_domain_id) {
    try {
      const storedDomain = await provider.organizationDomains.get(claim.workos_domain_id);
      if (
        storedDomain.organizationId === workOsOrganization.id &&
        storedDomain.domain.toLowerCase() === claim.domain
      ) {
        providerDomain = storedDomain;
      }
    } catch (error) {
      if (providerStatus(error) !== 404) throw providerError(error);
    }
  }

  if (!providerDomain) {
    try {
      providerDomain = await provider.organizationDomains.create({
        domain: claim.domain,
        organizationId: workOsOrganization.id,
      });
    } catch (error) {
      throw providerError(error);
    }
  }

  if (
    providerDomain.organizationId !== workOsOrganization.id ||
    providerDomain.domain.toLowerCase() !== claim.domain
  ) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: PROVIDER_ERROR_MESSAGE });
  }

  return providerDomain;
}

async function synchronizeProviderStateInTransaction(
  tx: DrizzleTransaction,
  claim: OrganizationDomainClaim,
  providerDomain: OrganizationDomain,
  actor: Actor
): Promise<OrganizationDomainClaim> {
  if (
    claim.domain !== providerDomain.domain.toLowerCase() ||
    (claim.workos_organization_id && claim.workos_organization_id !== providerDomain.organizationId)
  ) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: PROVIDER_ERROR_MESSAGE });
  }

  const nextStatus =
    providerDomain.state === OrganizationDomainState.Verified ? 'verified' : 'pending';
  if (nextStatus === 'verified') {
    const otherOwner = await tx.query.organization_domain_claims.findFirst({
      where: and(
        eq(organization_domain_claims.domain, claim.domain),
        eq(organization_domain_claims.status, 'verified'),
        ne(organization_domain_claims.organization_id, claim.organization_id)
      ),
    });
    if (otherOwner) throw conflictError();
  }

  const becameVerified = claim.status === 'pending' && nextStatus === 'verified';
  const lostVerification = claim.status === 'verified' && nextStatus === 'pending';
  const [updated] = await tx
    .update(organization_domain_claims)
    .set({
      status: nextStatus,
      verified_at: becameVerified ? sql`now()` : lostVerification ? null : claim.verified_at,
      workos_organization_id: providerDomain.organizationId,
      workos_domain_id: providerDomain.id,
    })
    .where(eq(organization_domain_claims.id, claim.id))
    .returning();
  if (!updated) throw new Error('Failed to synchronize domain claim');

  if (becameVerified || lostVerification) {
    await createAuditLog({
      action: becameVerified
        ? 'organization.domain_claim.verify'
        : 'organization.domain_claim.lose_verification',
      actor_email: actor.google_user_email,
      actor_id: actor.id,
      actor_name: actor.google_user_name,
      message: becameVerified ? 'Verified domain claim' : 'Domain claim lost verification',
      organization_id: claim.organization_id,
      tx,
    });
  }
  return updated;
}

async function synchronizeProviderState(
  claimId: string,
  providerDomain: OrganizationDomain,
  actor: Actor
): Promise<OrganizationDomainClaim> {
  try {
    return await db.transaction(async tx => {
      const [claim] = await tx
        .select()
        .from(organization_domain_claims)
        .where(eq(organization_domain_claims.id, claimId))
        .for('update');
      if (!claim) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Domain claim not found' });
      }
      await lockDomain(tx, claim.domain);
      return synchronizeProviderStateInTransaction(tx, claim, providerDomain, actor);
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (isUniqueViolation(error)) throw conflictError();
    throw error;
  }
}

export async function listVerifiedDomainClaims(
  organizationId: string
): Promise<VerifiedDomainClaimView[]> {
  const organization = await db.query.organizations.findFirst({
    columns: { id: true },
    where: and(eq(organizations.id, organizationId), sql`${organizations.deleted_at} IS NULL`),
  });
  if (!organization) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
  const claims = await db
    .select()
    .from(organization_domain_claims)
    .where(eq(organization_domain_claims.organization_id, organizationId))
    .orderBy(asc(organization_domain_claims.created_at));
  return claims.map(serializeClaim);
}

export async function createVerifiedDomainClaim(
  organizationId: string,
  inputDomain: string,
  actor: Actor,
  provider: VerifiedDomainProvider = workos
): Promise<{ claim: VerifiedDomainClaimView; verificationLink: string }> {
  const domain = canonicalizeEligibleVerifiedDomain(inputDomain);
  if (!domain) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Domain is not eligible for verification',
    });
  }

  let claim: OrganizationDomainClaim;
  let organization: { id: string; name: string };
  try {
    ({ claim, organization } = await db.transaction(async tx => {
      await lockDomain(tx, domain);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('workos-organization:' || ${organizationId}, 0))`
      );
      const organization = await tx.query.organizations.findFirst({
        columns: { id: true, name: true },
        where: and(eq(organizations.id, organizationId), sql`${organizations.deleted_at} IS NULL`),
      });
      if (!organization) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }

      const existing = await tx.query.organization_domain_claims.findFirst({
        where: eq(organization_domain_claims.domain, domain),
      });
      if (existing) {
        if (existing.organization_id !== organizationId) throw conflictError();
        return { claim: existing, organization };
      }

      const [created] = await tx
        .insert(organization_domain_claims)
        .values({ organization_id: organizationId, domain })
        .returning();
      if (!created) throw new Error('Failed to create domain claim');
      await createAuditLog({
        action: 'organization.domain_claim.create',
        actor_email: actor.google_user_email,
        actor_id: actor.id,
        actor_name: actor.google_user_name,
        message: 'Created domain claim',
        organization_id: organizationId,
        tx,
      });
      return { claim: created, organization };
    }));
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (isUniqueViolation(error)) throw conflictError();
    throw error;
  }

  const providerDomain = await ensureProviderDomain(provider, claim, organization);
  const synchronized = await synchronizeProviderState(claim.id, providerDomain, actor);
  try {
    const link = await provider.portal.generateLink({
      organization: providerDomain.organizationId,
      intent: GeneratePortalLinkIntent.DomainVerification,
    });
    return { claim: serializeClaim(synchronized), verificationLink: link.link };
  } catch (error) {
    throw providerError(error);
  }
}

export async function refreshVerifiedDomainClaim(
  organizationId: string,
  claimId: string,
  actor: Actor,
  provider: VerifiedDomainProvider = workos
): Promise<VerifiedDomainClaimView> {
  try {
    return await db.transaction(async tx => {
      const [claim] = await tx
        .select()
        .from(organization_domain_claims)
        .where(
          and(
            eq(organization_domain_claims.id, claimId),
            eq(organization_domain_claims.organization_id, organizationId)
          )
        )
        .for('update');
      if (!claim) throw new TRPCError({ code: 'NOT_FOUND', message: 'Domain claim not found' });

      await lockDomain(tx, claim.domain);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('workos-organization:' || ${organizationId}, 0))`
      );
      const organization = await tx.query.organizations.findFirst({
        columns: { id: true, name: true },
        where: and(eq(organizations.id, organizationId), sql`${organizations.deleted_at} IS NULL`),
      });
      if (!organization) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }

      let refreshed: OrganizationDomain;
      if (claim.workos_domain_id) {
        try {
          refreshed = await provider.organizationDomains.get(claim.workos_domain_id);
        } catch (error) {
          if (providerStatus(error) !== 404) throw providerError(error);
          refreshed = await ensureProviderDomain(provider, claim, organization);
        }
      } else {
        refreshed = await ensureProviderDomain(provider, claim, organization);
      }
      return serializeClaim(
        await synchronizeProviderStateInTransaction(tx, claim, refreshed, actor)
      );
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (isUniqueViolation(error)) throw conflictError();
    throw error;
  }
}

export async function removeVerifiedDomainClaim(
  organizationId: string,
  claimId: string,
  actor: Actor,
  provider: VerifiedDomainProvider = workos
): Promise<void> {
  await db.transaction(async tx => {
    const [claim] = await tx
      .select()
      .from(organization_domain_claims)
      .where(
        and(
          eq(organization_domain_claims.id, claimId),
          eq(organization_domain_claims.organization_id, organizationId)
        )
      )
      .for('update');
    if (!claim) throw new TRPCError({ code: 'NOT_FOUND', message: 'Domain claim not found' });

    const organization = await tx.query.organizations.findFirst({
      columns: { id: true },
      where: and(eq(organizations.id, organizationId), sql`${organizations.deleted_at} IS NULL`),
    });
    if (!organization) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
    }

    await lockDomain(tx, claim.domain);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('workos-organization:' || ${organizationId}, 0))`
    );

    if (claim.workos_domain_id) {
      try {
        await provider.organizationDomains.delete(claim.workos_domain_id);
      } catch (error) {
        if (providerStatus(error) !== 404) throw providerError(error);
      }
    }

    const [removed] = await tx
      .delete(organization_domain_claims)
      .where(eq(organization_domain_claims.id, claim.id))
      .returning({ id: organization_domain_claims.id });
    if (!removed) throw new Error('Failed to remove domain claim');
    await createAuditLog({
      action: 'organization.domain_claim.remove',
      actor_email: actor.google_user_email,
      actor_id: actor.id,
      actor_name: actor.google_user_name,
      message: 'Removed domain claim',
      organization_id: organizationId,
      tx,
    });
  });
}
