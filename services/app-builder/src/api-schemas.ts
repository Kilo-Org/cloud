import { z } from 'zod';

// ============================================
// Init Endpoint Schemas
// POST /apps/{app_id}/init
// ============================================

// Template names must be alphanumeric with dashes/underscores only (no path traversal)
const templateNameRegex = /^[a-zA-Z0-9_-]+$/;

export const InitRequestSchema = z.object({
  template: z.string().refine(name => templateNameRegex.test(name), {
    message: 'Template name must contain only alphanumeric characters, dashes, and underscores',
  }),
});

export type InitRequest = z.infer<typeof InitRequestSchema>;

export const GitTokenSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
  permission: z.enum(['full', 'ro']),
});

export type GitToken = z.infer<typeof GitTokenSchema>;

export const InitSuccessResponseSchema = z.object({
  success: z.literal(true),
  app_id: z.string(),
  git_url: z.string(),
});

export const InitErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.enum([
    'repository_exists',
    'template_not_found',
    'template_empty',
    'invalid_request',
    'internal_error',
  ]),
  message: z.string(),
  git_url: z.string().optional(), // Only present for 'repository_exists' error
});

export const InitResponseSchema = z.discriminatedUnion('success', [
  InitSuccessResponseSchema,
  InitErrorResponseSchema,
]);

export type InitSuccessResponse = z.infer<typeof InitSuccessResponseSchema>;
export type InitErrorResponse = z.infer<typeof InitErrorResponseSchema>;
export type InitResponse = z.infer<typeof InitResponseSchema>;

// ============================================
// Preview Status Endpoint Schemas
// GET /apps/{app_id}/preview
// ============================================

export const PreviewStateSchema = z.enum(['uninitialized', 'idle', 'building', 'running', 'error']);
export type PreviewState = z.infer<typeof PreviewStateSchema>;

export const GetPreviewResponseSchema = z.object({
  status: PreviewStateSchema,
  previewUrl: z.string().nullable(),
  error: z.string().nullable(),
});

export type GetPreviewResponse = z.infer<typeof GetPreviewResponseSchema>;

// ============================================
// Build Trigger Endpoint Schemas
// POST /apps/{app_id}/build
// ============================================

// Returns 202 Accepted with empty body on success
// Returns error response on failure
export const BuildTriggerErrorResponseSchema = z.object({
  error: z.enum(['internal_error']),
  message: z.string(),
});

export type BuildTriggerErrorResponse = z.infer<typeof BuildTriggerErrorResponseSchema>;

// ============================================
// Build Logs Streaming Endpoint Schemas
// GET /apps/{app_id}/build/logs
// ============================================

// Returns Server-Sent Events stream on success
// Returns error response on failure
export const BuildLogsErrorResponseSchema = z.object({
  error: z.enum(['no_logs_available', 'internal_error']),
  message: z.string(),
});

export type BuildLogsErrorResponse = z.infer<typeof BuildLogsErrorResponseSchema>;

// ============================================
// Token Generation Endpoint Schemas
// POST /apps/{app_id}/token
// ============================================

export const TokenRequestSchema = z.object({
  permission: z.enum(['full', 'ro']),
});

export type TokenRequest = z.infer<typeof TokenRequestSchema>;

export const TokenSuccessResponseSchema = z.object({
  success: z.literal(true),
  token: z.string(),
  expires_at: z.string(),
  permission: z.enum(['full', 'ro']),
});

export type TokenSuccessResponse = z.infer<typeof TokenSuccessResponseSchema>;

// ============================================
// Delete Endpoint Schemas
// DELETE /apps/{app_id}
// ============================================

export const DeleteSuccessResponseSchema = z.object({
  success: z.literal(true),
});

export const DeleteErrorResponseSchema = z.object({
  error: z.enum(['unauthorized', 'internal_error']),
  message: z.string(),
});

export type DeleteSuccessResponse = z.infer<typeof DeleteSuccessResponseSchema>;
export type DeleteErrorResponse = z.infer<typeof DeleteErrorResponseSchema>;

// ============================================
// Migrate to GitHub Endpoint Schemas
// POST /apps/{app_id}/migrate-to-github
// Sets GitHub source and schedules internal git repo deletion
// ============================================

export const MigrateToGithubRequestSchema = z.object({
  githubRepo: z.string().regex(/^[^/]+\/[^/]+$/, 'Must be in "owner/repo" format'),
  userId: z.string().uuid(),
  orgId: z.string().uuid().optional(),
});

export type MigrateToGithubRequest = z.infer<typeof MigrateToGithubRequestSchema>;

export const MigrateToGithubSuccessResponseSchema = z.object({
  success: z.literal(true),
});

export const MigrateToGithubErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.enum(['invalid_request', 'internal_error', 'token_failed', 'push_failed']),
  message: z.string(),
});

export const MigrateToGithubResponseSchema = z.discriminatedUnion('success', [
  MigrateToGithubSuccessResponseSchema,
  MigrateToGithubErrorResponseSchema,
]);

export type MigrateToGithubSuccessResponse = z.infer<typeof MigrateToGithubSuccessResponseSchema>;
export type MigrateToGithubErrorResponse = z.infer<typeof MigrateToGithubErrorResponseSchema>;
export type MigrateToGithubResponse = z.infer<typeof MigrateToGithubResponseSchema>;

// ============================================
// Common Error Response Schema
// ============================================

export const ApiErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
