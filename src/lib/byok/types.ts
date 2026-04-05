import * as z from 'zod';

// API response type (never includes decrypted key)
export type BYOKApiKeyResponse = {
  id: string;
  provider_id: string;
  provider_name: string;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
};

// Optional organization ID schema - when not provided, uses the authenticated user's ID
const OptionalOrganizationIdSchema = z.object({
  organizationId: z.string().uuid().optional(),
});

// Zod schemas for tRPC validation
// Note: organizationId is optional - if provided, enforces org owner/billing access
// If not provided, uses the authenticated user's kilo_user_id
export const CreateBYOKKeyInputSchema = OptionalOrganizationIdSchema.extend({
  provider_id: z.string().min(1),
  api_key: z.string().min(1),
});

export const UpdateBYOKKeyInputSchema = OptionalOrganizationIdSchema.extend({
  id: z.string().uuid(),
  api_key: z.string().min(1),
});

export const DeleteBYOKKeyInputSchema = OptionalOrganizationIdSchema.extend({
  id: z.string().uuid(),
});

export const SetBYOKKeyEnabledInputSchema = OptionalOrganizationIdSchema.extend({
  id: z.string().uuid(),
  is_enabled: z.boolean(),
});

// List schema with optional organizationId
export const ListBYOKKeysInputSchema = OptionalOrganizationIdSchema;

export const TestBYOKKeyInputSchema = OptionalOrganizationIdSchema.extend({
  id: z.string().uuid(),
});

export const BYOKApiKeyResponseSchema = z.object({
  id: z.string().uuid(),
  provider_id: z.string(),
  provider_name: z.string(),
  is_enabled: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  created_by: z.string(),
});
