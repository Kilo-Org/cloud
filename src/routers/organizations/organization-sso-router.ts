import { WORKOS_API_KEY } from '@/lib/config.server';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  ensureOrganizationAccess,
  organizationMemberProcedure,
} from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import { GeneratePortalLinkIntent, WorkOS, OrganizationDomainState } from '@workos-inc/node';
import * as z from 'zod';
import { db } from '@/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { OrganizationSSODomainSchema } from '@/lib/organizations/organization-types';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { successResult } from '@/lib/maybe-result';

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
    await ensureOrganizationAccess(opts.ctx, organizationId, ['owner']);
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
    const createdOrg = await workos.organizations.createOrganization({
      name: org.name,
      metadata: {
        createdById: opts.ctx.user.id,
        createdByEmail: opts.ctx.user.google_user_email,
      },
      externalId: org.id,
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
    await ensureOrganizationAccess(opts.ctx, organizationId, ['owner']);
    const workOSOrg = await getWorkOsOrganizationByExternalId(organizationId);
    if (!workOSOrg) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'SSO configuration not found' });
    }
    await workos.organizations.deleteOrganization(workOSOrg.id);
    return successResult({ message: 'SSO configuration deleted successfully' });
  }),
  generateAdminPortalLink: adminProcedure.input(AdminPortalSchema).mutation(async opts => {
    const { organizationId, linkType } = opts.input;
    await ensureOrganizationAccess(opts.ctx, organizationId, ['owner']);
    const workOSOrg = await getWorkOsOrganizationByExternalId(organizationId);
    if (!workOSOrg) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'SSO configuration not found' });
    }

    const intent =
      linkType === 'sso'
        ? GeneratePortalLinkIntent.SSO
        : GeneratePortalLinkIntent.DomainVerification;

    const link = await workos.portal.generateLink({
      organization: workOSOrg.id,
      intent,
    });
    return { link: link.link };
  }),
  updateSsoDomain: adminProcedure.input(UpdateSSODomainSchema).mutation(async opts => {
    const { organizationId, ssoDomain } = opts.input;
    await ensureOrganizationAccess(opts.ctx, organizationId, ['owner']);

    await db
      .update(organizations)
      .set({ sso_domain: ssoDomain.toLowerCase() })
      .where(eq(organizations.id, organizationId));

    await createAuditLog({
      action: 'organization.sso.set_domain',
      actor_email: opts.ctx.user.google_user_email,
      actor_id: opts.ctx.user.id,
      actor_name: opts.ctx.user.google_user_name,
      message: `Set SSO domain to ${ssoDomain}`,
      organization_id: organizationId,
    });

    return successResult({ message: 'SSO domain updated successfully' });
  }),
  clearSsoDomain: adminProcedure.input(OrgIdSchema).mutation(async opts => {
    const { organizationId } = opts.input;
    await ensureOrganizationAccess(opts.ctx, organizationId, ['owner']);

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
