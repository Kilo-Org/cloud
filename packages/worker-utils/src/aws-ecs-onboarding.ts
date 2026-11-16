import { z } from 'zod';
import {
  awsByocConfigurationSchema,
  type AwsByocConfiguration,
  AWS_BYOC_ENVELOPE_KEY_ID,
  AWS_BYOC_ENVELOPE_SCHEME,
} from './aws-byoc';
import {
  awsEcsByocConfigurationSchema,
  type AwsEcsByocConfiguration,
  AWS_ECS_BYOC_ENVELOPE_SCHEME,
  AWS_ECS_BYOC_TEMPLATE_VERSION,
} from './aws-ecs';
import {
  AWS_BYOC_SETUP_ENVELOPE_SCHEME,
  awsByocReleaseSchema,
  awsReleaseImageSchema,
  awsSetupIntentSchema,
  awsSetupBindingSchema,
  awsSetupEnvelopeAad,
  awsSetupOwnerSchema,
  validateAwsSetupAccounts,
  type AwsSetupBinding,
  type AwsSetupOwner,
  type AwsSetupProvider,
} from './aws-onboarding';

export const AWS_ECS_BYOC_SETUP_ENVELOPE_SCHEME = 'byoc-aws-ecs-setup-rsa-aes-256-gcm';
export const awsEcsByocReleaseSchema = z
  .object({
    ...awsByocReleaseSchema.shape,
    provider: z.literal('aws-ecs'),
    templateVersion: z.literal(AWS_ECS_BYOC_TEMPLATE_VERSION),
    runtime: awsReleaseImageSchema,
  })
  .strict();
export type AwsEcsByocRelease = z.infer<typeof awsEcsByocReleaseSchema>;
export const awsEcsSetupIntentSchema = z
  .object({
    ...awsSetupIntentSchema.shape,
    provider: z.literal('aws-ecs'),
    release: awsEcsByocReleaseSchema,
  })
  .strict()
  .superRefine(validateAwsSetupAccounts);
export type AwsEcsSetupIntent = z.infer<typeof awsEcsSetupIntentSchema>;
export const awsProviderSetupIntentSchema = z.union([
  awsSetupIntentSchema,
  awsEcsSetupIntentSchema,
]);
export type AwsProviderSetupIntent = z.infer<typeof awsProviderSetupIntentSchema>;

/** Only compatibility request parsing defaults a provider. Every envelope purpose requires an exact engine. */
export function awsProviderSetupEnvelope(provider: AwsSetupProvider, binding: AwsSetupBinding) {
  const value = awsSetupBindingSchema.parse(binding);
  const owner = value.owner.organizationId ?? `user:${value.owner.userId}`;
  switch (provider) {
    case 'aws':
      return { scheme: AWS_BYOC_SETUP_ENVELOPE_SCHEME, aad: awsSetupEnvelopeAad(value) };
    case 'aws-ecs':
      return {
        scheme: AWS_ECS_BYOC_SETUP_ENVELOPE_SCHEME,
        aad: `byoc-aws-ecs-setup:v1:${owner}:${value.credentialId}:${value.generation}`,
      };
    default:
      throw new Error('Unsupported AWS provider');
  }
}
export function awsProviderConfigurationEnvelope(
  provider: AwsSetupProvider,
  owner: AwsSetupOwner,
  credentialId: string
) {
  const value = awsSetupOwnerSchema.parse(
    owner.organizationId !== undefined
      ? { organizationId: owner.organizationId }
      : { userId: owner.userId }
  );
  const ownerKey = value.organizationId ?? `user:${value.userId}`;
  const id = z.uuid().parse(credentialId);
  switch (provider) {
    case 'aws':
      return {
        scheme: AWS_BYOC_ENVELOPE_SCHEME,
        aad: `byoc-aws-configuration:v1:${ownerKey}:${id}`,
        keyId: AWS_BYOC_ENVELOPE_KEY_ID,
      };
    case 'aws-ecs':
      return {
        scheme: AWS_ECS_BYOC_ENVELOPE_SCHEME,
        aad: `byoc-aws-ecs-configuration:v1:${ownerKey}:${id}`,
        keyId: AWS_BYOC_ENVELOPE_KEY_ID,
      };
    default:
      throw new Error('Unsupported AWS provider');
  }
}

export type AwsProviderConfiguration = AwsByocConfiguration | AwsEcsByocConfiguration;
export function awsProviderSetupIntentSchemaFor(
  provider: AwsSetupProvider
): z.ZodType<AwsProviderSetupIntent> {
  switch (provider) {
    case 'aws':
      return awsSetupIntentSchema;
    case 'aws-ecs':
      return awsEcsSetupIntentSchema;
    default:
      throw new Error('Unsupported AWS provider');
  }
}
export function awsProviderConfigurationSchemaFor(
  provider: AwsSetupProvider
): z.ZodType<AwsProviderConfiguration> {
  switch (provider) {
    case 'aws':
      return awsByocConfigurationSchema;
    case 'aws-ecs':
      return awsEcsByocConfigurationSchema;
    default:
      throw new Error('Unsupported AWS provider');
  }
}
