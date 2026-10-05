import { UserByokProviderIdSchema } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import * as z from 'zod';

// Schema for custom provider IDs (user-defined, lowercase with hyphens/underscores)
export const CustomByokProviderIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    'Provider ID must start with a lowercase letter or number and contain only lowercase letters, numbers, hyphens, or underscores'
  );

// API response type (never includes decrypted key)
export type BYOKApiKeyResponse = {
  id: string;
  provider_id: string;
  provider_name: string;
  display_name: string | null;
  base_url: string | null;
  provider_api: string | null;
  management_source: 'user' | 'coding_plan';
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
  provider_id: UserByokProviderIdSchema.or(CustomByokProviderIdSchema),
  api_key: z.string().min(1),
  display_name: z.string().optional(),
  base_url: z.string().url().optional(),
  provider_api: z.enum(['openai-compatible']).optional(),
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
  display_name: z.string().nullable(),
  base_url: z.string().nullable(),
  provider_api: z.string().nullable(),
  management_source: z.enum(['user', 'coding_plan']),
  is_enabled: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  created_by: z.string(),
});
