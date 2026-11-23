import 'server-only';
import { z } from 'zod';
import { createTRPCRouter, baseProcedure } from '@kilocode/web-shared/lib/trpc/init';
import {
  organizationAdminProcedure,
  OrganizationIdInputSchema,
} from '@kilocode/web-shared/routers/organizations/utils';
import { awsByocConfigurationSchema } from '@kilocode/worker-utils/aws-byoc';
import {
  discardAwsComputeDraft,
  getAwsComputeEnrollment,
  getAwsComputeInstructions,
  getAwsComputeStatus,
  prepareAwsCompute,
  validateAwsCompute,
} from '@/lib/byoc/aws-connection';

const prepareInput = z
  .object({
    accountId: z
      .string()
      .trim()
      .regex(/^\d{12}$/, 'Enter a 12-digit AWS account ID.'),
  })
  .strict();
const validateInput = z.object({ roleArn: awsByocConfigurationSchema.shape.roleArn }).strict();
const discardInput = z.object({ generation: z.uuid() }).strict();

export const personalAwsComputeRouter = createTRPCRouter({
  getEnrollment: baseProcedure.query(({ ctx }) => getAwsComputeEnrollment({ userId: ctx.user.id })),
  getStatus: baseProcedure.query(({ ctx }) => getAwsComputeStatus({ userId: ctx.user.id })),
  prepare: baseProcedure
    .input(prepareInput)
    .mutation(({ ctx, input }) => prepareAwsCompute({ userId: ctx.user.id }, input.accountId)),
  instructions: baseProcedure.mutation(({ ctx }) =>
    getAwsComputeInstructions({ userId: ctx.user.id })
  ),
  validate: baseProcedure
    .input(validateInput)
    .mutation(({ ctx, input }) => validateAwsCompute({ userId: ctx.user.id }, input.roleArn)),
  discardDraft: baseProcedure
    .input(discardInput)
    .mutation(({ ctx, input }) =>
      discardAwsComputeDraft({ userId: ctx.user.id }, input.generation)
    ),
});

export const organizationAwsComputeRouter = createTRPCRouter({
  getEnrollment: organizationAdminProcedure.query(({ input }) =>
    getAwsComputeEnrollment({ organizationId: input.organizationId })
  ),
  getStatus: organizationAdminProcedure.query(({ input }) =>
    getAwsComputeStatus({ organizationId: input.organizationId })
  ),
  prepare: organizationAdminProcedure
    .input(OrganizationIdInputSchema.extend(prepareInput.shape))
    .mutation(({ input }) =>
      prepareAwsCompute({ organizationId: input.organizationId }, input.accountId)
    ),
  instructions: organizationAdminProcedure.mutation(({ input }) =>
    getAwsComputeInstructions({ organizationId: input.organizationId })
  ),
  validate: organizationAdminProcedure
    .input(OrganizationIdInputSchema.extend(validateInput.shape))
    .mutation(({ input }) =>
      validateAwsCompute({ organizationId: input.organizationId }, input.roleArn)
    ),
  discardDraft: organizationAdminProcedure
    .input(OrganizationIdInputSchema.extend(discardInput.shape))
    .mutation(({ input }) =>
      discardAwsComputeDraft({ organizationId: input.organizationId }, input.generation)
    ),
});
