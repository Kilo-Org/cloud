import { z } from 'zod';
import {
  awsRegionSchema,
  awsRoleArnSchema,
  awsStackIdSchema,
  awsTemplateVersionSchema,
} from './aws-byoc';
import { awsSetupBindingSchema, awsSetupOwnerSchema } from './aws-onboarding';

const provider = { provider: z.literal('aws-ec2') };
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
      roleArn: awsRoleArnSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('revalidate'),
      ...stored,
      roleArn: awsRoleArnSchema,
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
    roleArn: awsRoleArnSchema,
    stackId: awsStackIdSchema,
    region: awsRegionSchema,
    templateVersion: awsTemplateVersionSchema,
    accountId: z.string().regex(/^\d{12}$/),
  })
  .strict();
