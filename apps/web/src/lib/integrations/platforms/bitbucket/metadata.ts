import { z } from 'zod';

export const MAX_BITBUCKET_WORKSPACES = 500;

const NonEmptyMetadataStringSchema = z
  .string()
  .min(1)
  .refine(value => value.trim() === value);

export const BitbucketWorkspaceSchema = z
  .object({
    uuid: NonEmptyMetadataStringSchema,
    slug: NonEmptyMetadataStringSchema,
    name: NonEmptyMetadataStringSchema,
  })
  .strict();

export const BitbucketWorkspaceAccessTokenMetadataSchema = z
  .object({
    displayName: NonEmptyMetadataStringSchema,
  })
  .strict();

const PendingBitbucketIntegrationMetadataSchema = z
  .object({
    state: z.literal('workspace_selection_required'),
    availableWorkspaces: z.array(BitbucketWorkspaceSchema).min(1).max(MAX_BITBUCKET_WORKSPACES),
  })
  .strict();

const ActiveBitbucketIntegrationMetadataSchema = z
  .object({
    state: z.literal('active'),
    workspace: BitbucketWorkspaceSchema,
  })
  .strict();

export const BitbucketIntegrationMetadataSchema = z.discriminatedUnion('state', [
  PendingBitbucketIntegrationMetadataSchema,
  ActiveBitbucketIntegrationMetadataSchema,
]);

export type BitbucketWorkspace = z.infer<typeof BitbucketWorkspaceSchema>;
export type BitbucketIntegrationMetadata = z.infer<typeof BitbucketIntegrationMetadataSchema>;
