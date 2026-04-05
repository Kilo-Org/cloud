/**
 * Zod schemas for runtime validation of integration metadata
 */
import * as z from 'zod';
import { PENDING_APPROVAL_STATUS } from './constants';

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
