import { z } from 'zod';
import {
  AWS_BYOC_TEMPLATE_VERSION,
  AWS_BYOC_PROXY_PROTOCOL_VERSION,
  awsByocConfigurationSchema,
} from './aws-byoc';

export const AWS_BYOC_SETUP_ENVELOPE_SCHEME = 'byoc-aws-setup-rsa-aes-256-gcm';
const accountId = z.string().regex(/^\d{12}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bucket = awsByocConfigurationSchema.shape.bucket;
const key = z
  .string()
  .min(1)
  .max(1024)
  .refine(value =>
    value.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..')
  );
const repositoryArn = z.string().regex(/^arn:aws:ecr:us-east-1:\d{12}:repository\/[a-z0-9_./-]+$/);
const imageUri = z
  .string()
  .regex(/^\d{12}\.dkr\.ecr\.us-east-1\.amazonaws\.com\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/);
const releaseObject = z
  .object({ bucket, key, sha256: digest })
  .strict()
  .refine(value => value.key.includes(value.sha256));

/** Operator-published assets. Account access must exist before the customer creates its stack. */
export const awsByocReleaseSchema = z
  .object({
    format: z.literal(1),
    templateVersion: z.literal(AWS_BYOC_TEMPLATE_VERSION),
    proxyProtocolVersion: z.literal(AWS_BYOC_PROXY_PROTOCOL_VERSION),
    template: releaseObject.refine(value => value.key.endsWith('.json')),
    runtime: releaseObject.safeExtend({ repositoryArn }),
    proxy: z.object({ imageUri, repositoryArn }).strict(),
    customerAccounts: z.array(accountId).min(1).max(500),
  })
  .strict()
  .superRefine((release, ctx) => {
    const proxy = release.proxy.imageUri.split('@')[0];
    const repository = release.proxy.repositoryArn;
    const expectedProxy = `${repository.split(':')[4]}.dkr.ecr.us-east-1.amazonaws.com/${repository.split(':repository/')[1]}`;
    if (
      proxy !== expectedProxy ||
      !release.runtime.key.endsWith('.zip') ||
      new Set(release.customerAccounts).size !== release.customerAccounts.length
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid AWS release pins' });
    }
  });
export type AwsByocRelease = z.infer<typeof awsByocReleaseSchema>;

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
export const awsSetupIntentSchema = z
  .object({
    format: z.literal(1),
    accountId,
    stackName: z.string().regex(/^kilo-[a-f0-9]{32}$/),
    externalId: awsByocConfigurationSchema.shape.externalId,
    kiloRoleArn: awsByocConfigurationSchema.shape.roleArn,
    controlPlaneUrl: z.url().refine(value => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.port &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/'
      );
    }),
    release: awsByocReleaseSchema,
  })
  .strict()
  .superRefine((intent, ctx) => {
    const account = intent.kiloRoleArn.split(':')[4];
    if (
      !intent.release.customerAccounts.includes(intent.accountId) ||
      intent.release.runtime.repositoryArn.split(':')[4] !== account ||
      intent.release.proxy.repositoryArn.split(':')[4] !== account
    ) {
      ctx.addIssue({ code: 'custom', message: 'AWS setup account is not enabled' });
    }
  });
export type AwsSetupIntent = z.infer<typeof awsSetupIntentSchema>;

/** A separate purpose and generation prevent a draft envelope from becoming runtime authority. */
export function awsSetupEnvelopeAad(binding: AwsSetupBinding): string {
  const value = awsSetupBindingSchema.parse(binding);
  const owner = value.owner.organizationId ?? `user:${value.owner.userId}`;
  return `byoc-aws-setup:v1:${owner}:${value.credentialId}:${value.generation}`;
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
  byoc_aws_proxy_protocol_unsupported:
    'The AWS stack needs a proxy release update. Contact Kilo to update the existing connection.',
  byoc_aws_stack_mismatch:
    'The AWS stack does not match this setup. Use its generated stack name and parameters.',
  byoc_aws_proxy_unavailable: 'The AWS proxy is not ready. Check the stack events, then try again.',
  byoc_aws_proxy_expired:
    'The AWS proxy certificate needs renewal. Contact Kilo to update the connection.',
  byoc_aws_connection_update_required:
    'This connection requires a release update. Contact Kilo before changing the stack.',
  byoc_aws_setup_changed: 'AWS setup changed. Reload the page and try again.',
} as const;
export type AwsSetupErrorCode = keyof typeof AWS_SETUP_ERRORS;
