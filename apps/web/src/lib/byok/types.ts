import { UserByokProviderIdSchema } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import * as z from 'zod';

// Shared wire constraints for the BYOK procedures.
/** The id of one stored key, carried by every procedure input and the response. */
const BYOKKeyIdSchema = z.string().uuid();
/** The pasted credential of a key that is created or replaced. */
const BYOKApiKeySchema = z.string().min(1);

// Optional organization ID schema - when not provided, uses the authenticated user's ID
const OptionalOrganizationIdSchema = z.object({
  organizationId: z.string().uuid().optional(),
});

// API response schema (never includes decrypted key)
export const BYOKApiKeyResponseSchema = z.object({
  id: BYOKKeyIdSchema,
  provider_id: z.string(),
  provider_name: z.string(),
  management_source: z.enum(['user', 'coding_plan']),
  is_enabled: z.boolean(),
  serve_catalog_models: z.boolean(),
  /** The provider maps at least one model to a Kilo catalog id. */
  supports_catalog_mode: z.boolean(),
  /** Organization keys need an owner or admin to change catalog mode. */
  can_change_catalog_mode: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  created_by: z.string(),
});

export type BYOKApiKeyResponse = z.infer<typeof BYOKApiKeyResponseSchema>;

// Zod schemas for tRPC validation
// Note: organizationId is optional - if provided, enforces org owner/billing access
// If not provided, uses the authenticated user's kilo_user_id
export const CreateBYOKKeyInputSchema = OptionalOrganizationIdSchema.extend({
  provider_id: UserByokProviderIdSchema,
  api_key: BYOKApiKeySchema,
});

export const UpdateBYOKKeyInputSchema = OptionalOrganizationIdSchema.extend({
  id: BYOKKeyIdSchema,
  api_key: BYOKApiKeySchema,
});

export const DeleteBYOKKeyInputSchema = OptionalOrganizationIdSchema.extend({
  id: BYOKKeyIdSchema,
});

export const SetBYOKKeyEnabledInputSchema = OptionalOrganizationIdSchema.extend({
  id: BYOKKeyIdSchema,
  is_enabled: z.boolean(),
});

export const SetBYOKKeyCatalogModeInputSchema = OptionalOrganizationIdSchema.extend({
  id: BYOKKeyIdSchema,
  serve_catalog_models: z.boolean(),
});

/** Every listed key of the scoped owner, highest priority first. */
export const ReorderBYOKKeysInputSchema = OptionalOrganizationIdSchema.extend({
  keyIds: z
    .array(BYOKKeyIdSchema)
    .min(1)
    .max(100)
    .refine(ids => new Set(ids).size === ids.length, 'Key ids must be unique'),
});

// List schema with optional organizationId
export const ListBYOKKeysInputSchema = OptionalOrganizationIdSchema;

export const TestBYOKKeyInputSchema = OptionalOrganizationIdSchema.extend({
  id: BYOKKeyIdSchema,
});

export const PreviewBYOKRoutingInputSchema = OptionalOrganizationIdSchema.extend({
  modelId: z.string().trim().min(1).max(256),
  apiKind: z.enum(['chat_completions', 'responses', 'messages']).default('chat_completions'),
});
