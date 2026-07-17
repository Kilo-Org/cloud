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

export function getGitLabIntegrationOwner(integration: PlatformIntegration) {
  if (integration.owned_by_user_id) {
    return { type: 'user', id: integration.owned_by_user_id } as const;
  }
  if (integration.owned_by_organization_id) {
    return { type: 'org', id: integration.owned_by_organization_id } as const;
  }
  throw new Error('GitLab integration has no owner');
}

export function countLegacySecretFields(metadata: Record<string, unknown>): number {
  return [
    'access_token',
    'refresh_token',
    'token_expires_at',
    'client_secret',
    'project_tokens',
  ].filter(key => key in metadata).length;
}

export function hasTokenBearingLegacyMetadata(metadata: Record<string, unknown>): boolean {
  if ('access_token' in metadata || 'refresh_token' in metadata || 'client_secret' in metadata) {
    return true;
  }
  if (!('project_tokens' in metadata)) return false;
  const projectTokens = metadata.project_tokens;
  return (
    typeof projectTokens !== 'object' ||
    projectTokens === null ||
    Array.isArray(projectTokens) ||
    Object.keys(projectTokens).length > 0
  );
}
