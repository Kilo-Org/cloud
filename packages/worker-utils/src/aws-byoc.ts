import { z } from 'zod';
export const AWS_BYOC_ENVELOPE_KEY_ID = 'agent-env-vars-v1';
export const awsRegionSchema = z.literal('us-east-1');
export const awsRoleArnSchema = z
  .string()
  .regex(/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/);
export const awsExternalIdSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
export const awsStackIdSchema = z
  .string()
  .regex(/^arn:aws:cloudformation:us-east-1:\d{12}:stack\/[A-Za-z0-9-]+\/[a-f0-9-]+$/);
export const awsBucketSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
export const awsTemplateVersionSchema = z.number().int().nonnegative();
