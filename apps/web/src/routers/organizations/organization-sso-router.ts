import { WORKOS_API_KEY } from '@kilocode/web-shared/lib/config.server';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  ensureOrganizationAccess,
  organizationMemberProcedure,
} from '@kilocode/web-shared/routers/organizations/utils';
import { ORGANIZATION_MANAGE_ROLES } from '@kilocode/app-shared/organizations';
import { TRPCError } from '@trpc/server';
import { GenerateLinkIntent, WorkOS, OrganizationDomainState } from '@workos-inc/node';
import * as z from 'zod';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { OrganizationSSODomainSchema } from '@kilocode/web-shared/lib/organizations/organization-types';
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

    return {
      ...result,
      isDomainVerified,
      hasConnection,
    };
  }),
  deleteConfig: adminProcedure.input(OrgIdSchema).mutation(async opts => {
    const { organizationId } = opts.input;
    await ensureOrganizationAccess(opts.ctx, organizationId, ORGANIZATION_MANAGE_ROLES);
    const workOSOrg = await getWorkOsOrganizationByExternalId(organizationId);
    if (!workOSOrg) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'SSO configuration not found' });
    }
    await workos.organizations.deleteOrganization(workOSOrg.id);
    await recordAdminAction(opts.ctx, {
      action: 'organization.sso.config.delete',
      target: organizationActionTarget(organizationId),
      message: 'Deleted WorkOS SSO organization',
      metadata: { workosOrganizationId: workOSOrg.id },
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

    await db
      .update(organizations)
      .set({ sso_domain: null })
      .where(eq(organizations.id, organizationId));

    await createAuditLog({
      action: 'organization.sso.remove_domain',
      actor_email: opts.ctx.user.google_user_email,
      actor_id: opts.ctx.user.id,
      actor_name: opts.ctx.user.google_user_name,
      message: `Cleared SSO domain`,
      organization_id: organizationId,
    });

    return successResult({ message: 'SSO domain cleared successfully' });
  }),
});
