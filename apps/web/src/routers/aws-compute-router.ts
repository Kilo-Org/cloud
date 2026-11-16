import 'server-only';
import { z } from 'zod';
import { createTRPCRouter, baseProcedure } from '@kilocode/web-shared/lib/trpc/init';
import {
  organizationAdminProcedure,
  OrganizationIdInputSchema,
} from '@kilocode/web-shared/routers/organizations/utils';
import { awsSetupProviderSchema } from '@kilocode/worker-utils/aws-onboarding';
import { awsByocConfigurationSchema } from '@kilocode/worker-utils/aws-byoc';
import {
  discardAwsComputeDraft,
  getAwsComputeEnrollment,
  getAwsComputeInstructions,
  getAwsComputeStatus,
  prepareAwsCompute,
  validateAwsCompute,
} from '@/lib/byoc/aws-connection';

const providerInput = z.object({ provider: awsSetupProviderSchema.default('aws') });
const prepareInput = z
  .object({
    ...providerInput.shape,
    accountId: z
      .string()
      .trim()
      .regex(/^\d{12}$/, 'Enter a 12-digit AWS account ID.'),
  })
  .strict();
const validateInput = z
  .object({ ...providerInput.shape, roleArn: awsByocConfigurationSchema.shape.roleArn })
  .strict();
const discardInput = z.object({ ...providerInput.shape, generation: z.uuid() }).strict();

export const personalAwsComputeRouter = createTRPCRouter({
  getEnrollment: baseProcedure
    .input(providerInput.optional())
    .query(({ ctx, input }) =>
      getAwsComputeEnrollment({ userId: ctx.user.id }, input?.provider ?? 'aws')
    ),
  getStatus: baseProcedure
    .input(providerInput.optional())
    .query(({ ctx, input }) =>
      getAwsComputeStatus({ userId: ctx.user.id }, input?.provider ?? 'aws')
    ),
  prepare: baseProcedure
    .input(prepareInput)
    .mutation(({ ctx, input }) =>
      prepareAwsCompute({ userId: ctx.user.id }, input.accountId, input.provider)
    ),
  instructions: baseProcedure
    .input(providerInput.optional())
    .mutation(({ ctx, input }) =>
      getAwsComputeInstructions({ userId: ctx.user.id }, input?.provider ?? 'aws')
    ),
  validate: baseProcedure
    .input(validateInput)
    .mutation(({ ctx, input }) =>
      validateAwsCompute({ userId: ctx.user.id }, input.roleArn, input.provider)
    ),
  discardDraft: baseProcedure
    .input(discardInput)
    .mutation(({ ctx, input }) =>
      discardAwsComputeDraft({ userId: ctx.user.id }, input.generation, input.provider)
    ),
});
export const organizationAwsComputeRouter = createTRPCRouter({
  getEnrollment: organizationAdminProcedure
    .input(OrganizationIdInputSchema.extend(providerInput.shape))
    .query(({ input }) =>
      getAwsComputeEnrollment({ organizationId: input.organizationId }, input.provider)
    ),
  getStatus: organizationAdminProcedure
    .input(OrganizationIdInputSchema.extend(providerInput.shape))
    .query(({ input }) =>
      getAwsComputeStatus({ organizationId: input.organizationId }, input.provider)
    ),
  prepare: organizationAdminProcedure
    .input(OrganizationIdInputSchema.extend(prepareInput.shape))
    .mutation(({ input }) =>
      prepareAwsCompute({ organizationId: input.organizationId }, input.accountId, input.provider)
    ),
  instructions: organizationAdminProcedure
    .input(OrganizationIdInputSchema.extend(providerInput.shape))
    .mutation(({ input }) =>
      getAwsComputeInstructions({ organizationId: input.organizationId }, input.provider)
    ),
  validate: organizationAdminProcedure
    .input(OrganizationIdInputSchema.extend(validateInput.shape))
    .mutation(({ input }) =>
      validateAwsCompute({ organizationId: input.organizationId }, input.roleArn, input.provider)
    ),
  discardDraft: organizationAdminProcedure
    .input(OrganizationIdInputSchema.extend(discardInput.shape))
    .mutation(({ input }) =>
      discardAwsComputeDraft(
        { organizationId: input.organizationId },
        input.generation,
        input.provider
      )
    ),
});
