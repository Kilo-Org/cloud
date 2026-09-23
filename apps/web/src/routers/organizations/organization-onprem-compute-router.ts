import 'server-only';

import {
  onPremEnrollmentRequestSchema,
  onPremEnrollmentResponseSchema,
  onPremRevokeRequestSchema,
  onPremSelectRequestSchema,
  onPremStatusSchema,
} from '@cloud-agent-shared/onprem-protocol';
import {
  createOnPremEnrollment,
  getOnPremComputeStatus,
  revokeOnPremInstallation,
  selectOnPremComputeTarget,
} from '@/lib/cloud-agent-next/onprem-compute-client';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  organizationAdminProcedure,
  OrganizationIdInputSchema,
} from '@/routers/organizations/utils';

export const organizationOnPremComputeRouter = createTRPCRouter({
  getStatus: organizationAdminProcedure
    .output(onPremStatusSchema)
    .query(({ input }) => getOnPremComputeStatus(input.organizationId)),

  createEnrollment: organizationAdminProcedure
    .input(
      onPremEnrollmentRequestSchema.extend({
        ...OrganizationIdInputSchema.shape,
        name: onPremEnrollmentRequestSchema.shape.name.trim(),
      })
    )
    .output(onPremEnrollmentResponseSchema)
    .mutation(({ input }) => createOnPremEnrollment(input.organizationId, { name: input.name })),

  selectTarget: organizationAdminProcedure
    .input(onPremSelectRequestSchema.extend(OrganizationIdInputSchema.shape))
    .output(onPremStatusSchema)
    .mutation(({ input }) =>
      selectOnPremComputeTarget(input.organizationId, {
        installationId: input.installationId,
        profileId: input.profileId,
        selected: input.selected,
      })
    ),

  revoke: organizationAdminProcedure
    .input(onPremRevokeRequestSchema.extend(OrganizationIdInputSchema.shape))
    .output(onPremStatusSchema)
    .mutation(({ input }) =>
      revokeOnPremInstallation(input.organizationId, { installationId: input.installationId })
    ),
});
