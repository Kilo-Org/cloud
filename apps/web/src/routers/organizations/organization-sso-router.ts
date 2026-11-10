import { WORKOS_API_KEY } from '@kilocode/web-shared/lib/config.server';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  ensureOrganizationAccess,
  organizationAccessRole,
  organizationMemberProcedure,
} from '@kilocode/web-shared/routers/organizations/utils';
import {
  ORGANIZATION_MANAGE_ROLES,
  canManageOrganization,
} from '@kilocode/app-shared/organizations';
import { TRPCError } from '@trpc/server';
import { GenerateLinkIntent, WorkOS, OrganizationDomainState } from '@workos-inc/node';
import * as z from 'zod';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import {
  OrganizationSSODomainSchema,
  type OrganizationSsoConfigView,
  type OrganizationSsoStatusView,
} from '@kilocode/web-shared/lib/organizations/organization-types';
import { createAuditLog } from '@kilocode/web-shared/lib/organizations/organization-audit-logs';
import { organizationActionTarget, recordAdminAction } from '@/lib/admin/admin-action-audit';
import { successResult } from '@kilocode/web-shared/lib/maybe-result';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';

const OrgIdSchema = OrganizationIdInputSchema;

const AdminPortalSchema = OrgIdSchema.extend({
  linkType: z.enum(['sso', 'domain-verification']),
});

const UpdateSSODomainSchema = OrgIdSchema.extend({
  ssoDomain: OrganizationSSODomainSchema,
});

const workos = new WorkOS(WORKOS_API_KEY);

async function getWorkOsOrganizationByExternalId(externalId: string) {
  try {
    return await workos.organizations.getOrganizationByExternalId(externalId);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'status' in e && e.status === 404) {
      return null;
    }
    throw e;
  }
}

async function hasWorkOsConnections(organizationId: string) {
  const connections = await workos.sso.listConnections({
    organizationId,
  });
  return connections.data.length > 0;
}

/**
 * Releases the SSO domain an organization records, under the same locks a claim takes: the
 * organization row first, then the advisory lock for the recorded domain. `updateSsoDomain`
 * and the directory capture take them in that order, so a release cannot interleave with a
 * claim of the same domain and make it fail on a stale authority read.
 *
 * Returns the released domain, or null when the organization records none. A null release
 * writes nothing, so the audit log records one entry per changed field.
 */
async function releaseSsoDomain(
  tx: DrizzleTransaction,
  organizationId: string,
  actor: { id: string; google_user_email: string; google_user_name: string }
): Promise<string | null> {
  const [locked] = await tx
    .select({ ssoDomain: organizations.sso_domain })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for('update');
  if (!locked?.ssoDomain) {
    return null;
  }

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('sso-domain:' || ${locked.ssoDomain}, 0))`
  );
  await tx
    .update(organizations)
    .set({ sso_domain: null })
    .where(eq(organizations.id, organizationId));

  await createAuditLog({
    action: 'organization.sso.remove_domain',
    actor_email: actor.google_user_email,
    actor_id: actor.id,
    actor_name: actor.google_user_name,
    message: `Cleared SSO domain ${locked.ssoDomain}`,
    organization_id: organizationId,
    tx,
  });

  return locked.ssoDomain;
}

export const organizationSsoRouter = createTRPCRouter({
  createConfig: adminProcedure.input(OrgIdSchema).mutation(async opts => {
    const { organizationId } = opts.input;
    await ensureOrganizationAccess(opts.ctx, organizationId, ORGANIZATION_MANAGE_ROLES);
    const workOSOrg = await getWorkOsOrganizationByExternalId(organizationId);
    if (workOSOrg) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'SSO is already configured for this organization',
      });
    }
    const org = await getOrganizationById(organizationId);
    if (!org) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
    }
    if (org.parent_organization_id) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Child organizations inherit SSO from their parent',
      });
    }
    const createdOrg = await workos.organizations.createOrganization({
      name: org.name,
      metadata: {
        createdById: opts.ctx.user.id,
        createdByEmail: opts.ctx.user.google_user_email,
      },
      externalId: org.id,
    });
    await recordAdminAction(opts.ctx, {
      action: 'organization.sso.config.create',
      target: organizationActionTarget(organizationId),
      message: 'Created WorkOS SSO organization',
      metadata: { workosOrganizationId: createdOrg.id },
    });
    return createdOrg;
  }),
  getConfig: organizationMemberProcedure.input(OrgIdSchema).query(async opts => {
    const { organizationId } = opts.input;
    const result = await getWorkOsOrganizationByExternalId(organizationId);
    if (!result) {
      return false;
    }

    // Check domain verification status
    const isDomainVerified =
      result.domains?.some(domain => domain.state === OrganizationDomainState.Verified) || false;

    // Check if organization has SSO connections
    const hasConnection = await hasWorkOsConnections(result.id);

    // The summary names the domain its verification state describes: the verified
    // one when the organization holds one, otherwise the first configured domain.
    const primaryDomain =
      result.domains?.find(domain => domain.state === OrganizationDomainState.Verified) ??
      result.domains?.[0];

    const status: OrganizationSsoStatusView = {
      isDomainVerified,
      hasConnection,
      domain: primaryDomain?.domain ?? null,
    };

    // Every member reads the status above. The provider organization, its
    // domains with their verification state, and the rest of the WorkOS object
    // are configuration material, and only the roles that may change that
    // configuration read them.
    const role = organizationAccessRole(opts.ctx, opts.ctx.organizationAccess);
    if (!canManageOrganization(role)) {
      return { kind: 'status', ...status } satisfies OrganizationSsoConfigView;
    }

    return {
      kind: 'configuration',
      ...status,
      workosOrganization: {
        id: result.id,
        name: result.name,
        domains: (result.domains ?? []).map(domain => ({
          domain: domain.domain,
          state: domain.state,
        })),
      },
    } satisfies OrganizationSsoConfigView;
  }),
  deleteConfig: adminProcedure.input(OrgIdSchema).mutation(async opts => {
    const { organizationId } = opts.input;
    await ensureOrganizationAccess(opts.ctx, organizationId, ORGANIZATION_MANAGE_ROLES);
    const workOSOrg = await getWorkOsOrganizationByExternalId(organizationId);
    const organization = await getOrganizationById(organizationId);
    if (!organization) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
    }
    // A configuration is the WorkOS organization, the recorded domain, or both; the procedure
    // removes whatever the organization holds.
    const releasedDomain = organization.sso_domain;
    if (!workOSOrg && !releasedDomain) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'SSO configuration not found' });
    }

    // Remove the WorkOS organization before the recorded domain, and record the platform admin
    // action together with that deletion. The released domain is recorded by the
    // organization.sso.remove_domain entry below, which reads the value under the row lock.
    if (workOSOrg) {
      await workos.organizations.deleteOrganization(workOSOrg.id);
      await recordAdminAction(opts.ctx, {
        action: 'organization.sso.config.delete',
        target: organizationActionTarget(organizationId),
        message: 'Deleted WorkOS SSO organization',
        metadata: { workosOrganizationId: workOSOrg.id },
      });
    }

    // Release whatever domain the organization records, and audit it.
    await db.transaction(async tx => {
      await releaseSsoDomain(tx, organizationId, opts.ctx.user);
    });

    return successResult({ message: 'SSO configuration deleted successfully' });
  }),
  generateAdminPortalLink: adminProcedure.input(AdminPortalSchema).mutation(async opts => {
    const { organizationId, linkType } = opts.input;
    await ensureOrganizationAccess(opts.ctx, organizationId, ORGANIZATION_MANAGE_ROLES);
    const workOSOrg = await getWorkOsOrganizationByExternalId(organizationId);
    if (!workOSOrg) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'SSO configuration not found' });
    }

    const intent =
      linkType === 'sso' ? GenerateLinkIntent.SSO : GenerateLinkIntent.DomainVerification;

    const link = await workos.adminPortal.generateLink({
      organization: workOSOrg.id,
      intent,
    });
    // The link grants WorkOS admin-portal access; record that one was issued,
    // never the link itself.
    await recordAdminAction(opts.ctx, {
      action: 'organization.sso.admin_portal_link.generate',
      target: organizationActionTarget(organizationId),
      message: `Generated WorkOS admin portal link (${linkType})`,
      metadata: { workosOrganizationId: workOSOrg.id, linkType },
    });
    return { link: link.link };
  }),
  updateSsoDomain: adminProcedure.input(UpdateSSODomainSchema).mutation(async opts => {
    const { organizationId, ssoDomain } = opts.input;
    await ensureOrganizationAccess(opts.ctx, organizationId, ORGANIZATION_MANAGE_ROLES);

    await db.transaction(async tx => {
      const [organization] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .for('update');
      if (!organization || organization.deleted_at) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }
      if (organization.parent_organization_id) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Child organizations inherit SSO from their parent',
        });
      }

      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('sso-domain:' || ${ssoDomain}, 0))`
      );
      const existingAuthority = await resolveSsoAuthorityForDomain(ssoDomain, tx);
      if (
        existingAuthority.status === 'misconfigured' ||
        (existingAuthority.status === 'required' &&
          existingAuthority.sourceOrganizationId !== organizationId)
      ) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This SSO domain is already assigned to another organization',
        });
      }

      await tx
        .update(organizations)
        .set({ sso_domain: ssoDomain })
        .where(eq(organizations.id, organizationId));

      await createAuditLog({
        action: 'organization.sso.set_domain',
        actor_email: opts.ctx.user.google_user_email,
        actor_id: opts.ctx.user.id,
        actor_name: opts.ctx.user.google_user_name,
        message: `Set SSO domain to ${ssoDomain}`,
        organization_id: organizationId,
        tx,
      });
    });

    return successResult({ message: 'SSO domain updated successfully' });
  }),
  clearSsoDomain: adminProcedure.input(OrgIdSchema).mutation(async opts => {
    const { organizationId } = opts.input;
    await ensureOrganizationAccess(opts.ctx, organizationId, ORGANIZATION_MANAGE_ROLES);

    await db.transaction(async tx => {
      await releaseSsoDomain(tx, organizationId, opts.ctx.user);
    });

    return successResult({ message: 'SSO domain cleared successfully' });
  }),
});
