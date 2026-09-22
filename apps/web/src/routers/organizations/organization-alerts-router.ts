import { OrganizationAlertDefinitionSchema } from '@/lib/organizations/alerts/organization-alerts';
import {
  archiveOrganizationAlert,
  createOrganizationAlert,
  listOrganizationAlerts,
  MAX_ORGANIZATION_ALERT_PAGE_SIZE,
  setOrganizationAlertEnabled,
  updateOrganizationAlert,
  type OrganizationAlertActor,
} from '@/lib/organizations/alerts/organization-alerts.server';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationBillingProcedure,
} from '@/routers/organizations/utils';
import * as z from 'zod';

const AlertIdInputSchema = OrganizationIdInputSchema.extend({ alertId: z.uuid() }).strict();

/** Optimistic concurrency: the version the editor loaded the alert at. */
const ExpectedConfigurationVersionSchema = z.number().int().positive();

const ListInputSchema = OrganizationIdInputSchema.extend({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_ORGANIZATION_ALERT_PAGE_SIZE).optional(),
  includeArchived: z.boolean().default(false),
}).strict();

const CreateInputSchema = OrganizationIdInputSchema.extend({
  definition: OrganizationAlertDefinitionSchema,
  enabled: z.boolean().default(true),
  recipientDisclosureConfirmed: z.boolean(),
}).strict();

// The alert type is immutable, so `definition.type` must match the stored alert;
// changing type means creating a new alert identity.
const UpdateInputSchema = AlertIdInputSchema.extend({
  definition: OrganizationAlertDefinitionSchema,
  expectedConfigurationVersion: ExpectedConfigurationVersionSchema,
  recipientDisclosureConfirmed: z.boolean().default(false),
}).strict();

const SetEnabledInputSchema = AlertIdInputSchema.extend({
  enabled: z.boolean(),
  expectedConfigurationVersion: ExpectedConfigurationVersionSchema,
}).strict();

function actor(ctx: {
  user: { id: string; google_user_email: string; google_user_name: string };
}): OrganizationAlertActor {
  return {
    id: ctx.user.id,
    email: ctx.user.google_user_email,
    name: ctx.user.google_user_name,
  };
}

/**
 * Every procedure uses the organization billing procedure, so authority follows
 * `canManageOrganizationBilling` including its parent-to-direct-child
 * inheritance. Enterprise plus subscription/trial entitlement is enforced inside
 * the alert helpers, which apply it only to creating, enabling, and expanding —
 * disabling, archiving, and removing recipients stay available after entitlement
 * is lost.
 */
export const organizationAlertsRouter = createTRPCRouter({
  list: organizationBillingProcedure.input(ListInputSchema).query(async ({ input }) => {
    return await listOrganizationAlerts(input);
  }),

  create: organizationBillingProcedure.input(CreateInputSchema).mutation(async ({ input, ctx }) => {
    return await createOrganizationAlert({ ...input, actor: actor(ctx) });
  }),

  update: organizationBillingProcedure.input(UpdateInputSchema).mutation(async ({ input, ctx }) => {
    return await updateOrganizationAlert({ ...input, actor: actor(ctx) });
  }),

  setEnabled: organizationBillingProcedure
    .input(SetEnabledInputSchema)
    .mutation(async ({ input, ctx }) => {
      return await setOrganizationAlertEnabled({ ...input, actor: actor(ctx) });
    }),

  archive: organizationBillingProcedure
    .input(AlertIdInputSchema)
    .mutation(async ({ input, ctx }) => {
      return await archiveOrganizationAlert({ ...input, actor: actor(ctx) });
    }),
});
