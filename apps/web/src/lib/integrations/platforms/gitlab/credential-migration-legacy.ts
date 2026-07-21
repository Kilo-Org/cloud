import type { PlatformIntegration } from '@kilocode/db/schema';
import { z } from 'zod';

const LegacyProjectTokenSchema = z
  .object({
    token_id: z.number().int().positive(),
    token: z.string().min(1),
    expires_at: z.iso.date(),
    created_at: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export const GitLabLegacyMetadataSchema = z
  .object({
    access_token: z.string().min(1).optional(),
    refresh_token: z.string().min(1).optional(),
    token_expires_at: z.iso.datetime({ offset: true }).optional(),
    client_id: z.string().min(1).optional(),
    client_secret: z.string().min(1).optional(),
    gitlab_instance_url: z.string().min(1).optional(),
    auth_type: z.enum(['oauth', 'pat']).optional(),
    project_tokens: z.record(z.string(), LegacyProjectTokenSchema).optional(),
  })
  .passthrough();

export type GitLabLegacyMetadata = z.infer<typeof GitLabLegacyMetadataSchema>;

export type GitLabCredentialAuthType = 'oauth' | 'pat';

export function resolveGitLabCredentialAuthType(
  metadata: GitLabLegacyMetadata,
  integration: Pick<PlatformIntegration, 'integration_type'>
): GitLabCredentialAuthType | undefined {
  if (metadata.auth_type) return metadata.auth_type;
  return integration.integration_type === 'oauth' || integration.integration_type === 'pat'
    ? integration.integration_type
    : undefined;
}

export function getGitLabIntegrationOwner(integration: PlatformIntegration) {
  if (integration.owned_by_user_id) {
    return { type: 'user', id: integration.owned_by_user_id } as const;
  }
  if (integration.owned_by_organization_id) {
    return { type: 'org', id: integration.owned_by_organization_id } as const;
  }
  throw new Error('GitLab integration has no owner');
}
