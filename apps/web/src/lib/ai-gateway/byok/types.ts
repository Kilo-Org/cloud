import { UserByokProviderIdSchema } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { ManualByokProviderDefinition } from '@kilocode/db/schema-types';
import {
  ManualByokProviderCodeSchema,
  ValidatedManualByokProviderDefinitionSchema,
} from '@/lib/ai-gateway/providers/direct-byok/manual-byok';
import * as z from 'zod';

// API response type (never includes decrypted key)
export type BYOKApiKeyResponse = {
  id: string;
  provider_id: string;
  provider_name: string;
  management_source: 'user' | 'coding_plan';
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
  provider_settings: ManualByokProviderDefinition | null;
};

// Optional organization ID schema - when not provided, uses the authenticated user's ID
const OptionalOrganizationIdSchema = z.object({
  organizationId: z.string().uuid().optional(),
});

// Zod schemas for tRPC validation
// Note: organizationId is optional - if provided, enforces org owner/billing access
// If not provided, uses the authenticated user's kilo_user_id
export const CreateBYOKKeyInputSchema = z.union([
  OptionalOrganizationIdSchema.extend({
    provider_id: UserByokProviderIdSchema,
    api_key: z.string().min(1),
  }),
  OptionalOrganizationIdSchema.extend({
    provider_code: ManualByokProviderCodeSchema,
    provider_settings: ValidatedManualByokProviderDefinitionSchema,
    api_key: z.string().min(1),
  }),
]);

export const UpdateBYOKKeyInputSchema = OptionalOrganizationIdSchema.extend({
  id: z.string().uuid(),
  api_key: z.string().min(1).optional(),
  provider_settings: ValidatedManualByokProviderDefinitionSchema.optional(),
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
  management_source: z.enum(['user', 'coding_plan']),
  is_enabled: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  created_by: z.string(),
  provider_settings: ValidatedManualByokProviderDefinitionSchema.nullable(),
});

export const FetchManualByokModelsInputSchema = z.object({
  base_url: z.url(),
  api_key: z.string().min(1),
  use_x_api_key: z.boolean(),
});
