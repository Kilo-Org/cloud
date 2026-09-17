/**
 * Zod schemas for runtime validation of integration metadata
 */
import * as z from 'zod';
import type { PlatformRepository } from '@kilocode/db/schema-types';
import { PENDING_APPROVAL_STATUS } from './constants';

/**
 * Persisted GitHub/GitLab repository inventory cached on platform integration rows.
 * Unknown keys are stripped so forward-compatible cache fields do not invalidate the row.
 */
export const PlatformRepositoryCacheSchema = z
  .array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      full_name: z.string(),
      private: z.boolean(),
      default_branch: z.string().optional(),
    })
  )
  .nullable();

export function parsePlatformRepositoryCache(value: unknown): PlatformRepository[] {
  const parsed = PlatformRepositoryCacheSchema.safeParse(value ?? null);
  return parsed.success ? (parsed.data ?? []) : [];
}

/**
 * GitHub requester schema
 */
export const GitHubRequesterSchema = z.object({
  id: z.string(),
  login: z.string(),
});

/**
 * Kilo User requester schema
 */
export const KiloRequesterSchema = z.object({
  kilo_user_id: z.string(),
  kilo_user_email: z.string(),
  kilo_user_name: z.string(),
  requested_at: z.string(),
});

/**
 * Pending approval metadata schema
 */
export const PendingApprovalMetadataSchema = z.object({
  status: z.enum([PENDING_APPROVAL_STATUS.AWAITING_INSTALLATION]),
  requester: KiloRequesterSchema.optional(),
  github_requester: GitHubRequesterSchema.optional(),
  github_request_id: z.string().optional(),
});

/**
 * Completed installation metadata schema
 */
export const CompletedInstallationMetadataSchema = z.object({
  requester: KiloRequesterSchema.optional(),
  github_requester: GitHubRequesterSchema.optional(),
  completed_at: z.string(),
});

/**
 * Full metadata wrapper schema for pending installations
 */
export const PendingInstallationMetadataWrapperSchema = z.object({
  pending_approval: PendingApprovalMetadataSchema,
});

/**
 * Full metadata wrapper schema for completed installations
 */
export const CompletedInstallationMetadataWrapperSchema = z.object({
  completed_installation: CompletedInstallationMetadataSchema,
});
