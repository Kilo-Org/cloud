import { z } from 'zod';
import { awsByocConfigurationSchema } from './aws-byoc';
import {
  awsSetupBindingSchema,
  awsSetupOwnerSchema,
  awsSetupProviderSchema,
} from './aws-onboarding';

const provider = { provider: awsSetupProviderSchema.default('aws') };
const binding = { ...awsSetupBindingSchema.shape, ...provider };
const stored = { ...binding, envelope: z.unknown() };
export const awsSetupRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enrollment'), ...provider, owner: awsSetupOwnerSchema }).strict(),
  z
    .object({ action: z.literal('prepare'), ...binding, accountId: z.string().regex(/^\d{12}$/) })
    .strict(),
  z.object({ action: z.literal('instructions'), ...stored }).strict(),
  z
    .object({
      action: z.literal('validate'),
      ...stored,
      roleArn: awsByocConfigurationSchema.shape.roleArn,
    })
    .strict(),
  z
    .object({
      action: z.literal('revalidate'),
      ...stored,
      roleArn: awsByocConfigurationSchema.shape.roleArn,
    })
    .strict(),
]);
export type AwsSetupRequest = z.input<typeof awsSetupRequestSchema>;
export const awsEnrollmentSchema = z
  .object({ enrolled: z.boolean(), available: z.boolean() })
  .strict();
export const awsInstructionsSchema = z
  .object({
    launchUrl: z.url(),
    accountId: z.string().regex(/^\d{12}$/),
    stackName: z.string().regex(/^kilo-[a-f0-9]{32}$/),
    templateVersion: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export const awsVerificationSchema = z.object({ verified: z.literal(true) }).strict();
export const awsPublicConfigurationSchema = z
  .object({
    roleArn: awsByocConfigurationSchema.shape.roleArn,
    stackId: awsByocConfigurationSchema.shape.stackId,
    region: awsByocConfigurationSchema.shape.region,
    templateVersion: awsByocConfigurationSchema.shape.templateVersion,
    proxyProtocolVersion: awsByocConfigurationSchema.shape.proxyProtocolVersion,
    accountId: z.string().regex(/^\d{12}$/),
  })
  .strict();
