import { z } from 'zod';
import {
  AWS_BYOC_ENVELOPE_KEY_ID,
  awsBucketSchema,
  awsExternalIdSchema,
  awsRoleArnSchema,
} from './aws-byoc';
import {
  AWS_EC2_BYOC_ENVELOPE_SCHEME,
  AWS_EC2_STACK_VERSION,
  awsEc2ImageIdSchema,
} from './aws-ec2';

const accountId = z.string().regex(/^\d{12}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const key = z
  .string()
  .min(1)
  .max(1024)
  .refine(value =>
    value.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..')
  );
const template = z
  .object({ bucket: awsBucketSchema, key, sha256: digest })
  .strict()
  .refine(value => value.key.includes(value.sha256) && value.key.endsWith('.json'));
export const awsSetupOwnerSchema = z.union([
  z.object({ organizationId: z.uuid(), userId: z.never().optional() }).strict(),
  z.object({ userId: z.string().min(1), organizationId: z.never().optional() }).strict(),
]);
export type AwsSetupOwner = z.infer<typeof awsSetupOwnerSchema>;
export const awsSetupBindingSchema = z
  .object({
    owner: awsSetupOwnerSchema,
    credentialId: z.uuid(),
    generation: z.uuid(),
  })
  .strict();
export type AwsSetupBinding = z.infer<typeof awsSetupBindingSchema>;

const setupIntentFields = {
  format: z.literal(1),
  accountId,
  stackName: z.string().regex(/^kilo-[a-f0-9]{32}$/),
  externalId: awsExternalIdSchema,
  kiloRoleArn: awsRoleArnSchema,
};
/** Operator-published assets. Account access must exist before the customer creates its stack. */
export const awsEc2ByocReleaseSchema = z
  .object({
    format: z.literal(1),
    templateVersion: z.literal(AWS_EC2_STACK_VERSION),
    imageId: awsEc2ImageIdSchema,
    template,
    customerAccounts: z
      .array(accountId)
      .min(1)
      .max(500)
      .refine(value => new Set(value).size === value.length),
  })
  .strict();

export const awsEc2SetupIntentSchema = z
  .object({
    ...setupIntentFields,
    provider: z.literal('aws-ec2'),
    installation: z.uuid(),
    release: awsEc2ByocReleaseSchema,
  })
  .strict()
  .refine(intent => intent.release.customerAccounts.includes(intent.accountId));
export type AwsEc2SetupIntent = z.infer<typeof awsEc2SetupIntentSchema>;

function ownerKey(owner: AwsSetupOwner): string {
  return owner.organizationId ?? `user:${owner.userId}`;
}

/** A separate purpose and generation prevent a draft envelope from becoming runtime authority. */
export function awsEc2SetupEnvelope(binding: AwsSetupBinding) {
  const value = awsSetupBindingSchema.parse(binding);
  return {
    scheme: 'byoc-aws-ec2-setup-rsa-aes-256-gcm',
    aad: `byoc-aws-ec2-setup:v1:${ownerKey(value.owner)}:${value.credentialId}:${value.generation}`,
    keyId: AWS_BYOC_ENVELOPE_KEY_ID,
  };
}

export function awsEc2ConfigurationEnvelope(owner: AwsSetupOwner, credentialId: string) {
  return {
    scheme: AWS_EC2_BYOC_ENVELOPE_SCHEME,
    aad: `byoc-aws-ec2-configuration:v1:${ownerKey(awsSetupOwnerSchema.parse(owner))}:${z.uuid().parse(credentialId)}`,
    keyId: AWS_BYOC_ENVELOPE_KEY_ID,
  };
}

export const AWS_SETUP_ERRORS = {
  byoc_aws_setup_unavailable: 'AWS setup is unavailable. Try again later.',
  byoc_aws_account_not_enabled: 'This AWS account is not enabled for setup.',
  byoc_aws_role_unavailable:
    'Kilo could not assume this AWS role. Check the role ARN and trust policy.',
  byoc_aws_external_id_not_enforced:
    'The AWS role must require the ExternalId from this setup. Update its trust policy.',
  byoc_aws_stack_unavailable: 'Kilo could not read this AWS stack. Check its role permissions.',
  byoc_aws_stack_not_ready: 'The AWS stack has not completed. Check its events, then try again.',
  byoc_aws_stack_outdated:
    'The AWS stack needs a template update. Contact Kilo to update the existing connection.',
  byoc_aws_stack_mismatch:
    'The AWS stack does not match this setup. Use its generated stack name and parameters.',
  byoc_aws_setup_changed: 'AWS setup changed. Reload the page and try again.',
} as const;
export type AwsSetupErrorCode = keyof typeof AWS_SETUP_ERRORS;
