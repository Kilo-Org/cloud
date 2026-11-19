import { UserByokProviderIdSchema } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  ByokEndpointCredentialsSchema,
  ByokEndpointDefinitionSchema,
  ByokEndpointModelSchema,
} from '@kilocode/db/schema-types';
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
  /** The key is an organization's own endpoint; its `provider_name` is the endpoint name. */
  is_endpoint: z.boolean(),
  /** The endpoint's non-secret configuration, or null for provider keys. */
  endpoint: ByokEndpointDefinitionSchema.nullable(),
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
  /** For endpoint keys, the model to test; the first model when omitted. */
  modelId: z.string().min(1).max(200).optional(),
});

const OrganizationIdSchema = z.object({ organizationId: z.string().uuid() });

export const CreateByokEndpointInputSchema = OrganizationIdSchema.extend({
  definition: ByokEndpointDefinitionSchema,
  credentials: ByokEndpointCredentialsSchema,
});

/** Omitted credentials keep the stored ones. */
export const UpdateByokEndpointInputSchema = OrganizationIdSchema.extend({
  id: BYOKKeyIdSchema,
  definition: ByokEndpointDefinitionSchema,
  credentials: ByokEndpointCredentialsSchema.optional(),
});

/** Uses `credentials`, or the stored credentials of endpoint key `id` when they are omitted. */
export const ListByokEndpointModelsInputSchema = OrganizationIdSchema.extend({
  base_url: ByokEndpointDefinitionSchema.shape.base_url,
  credentials: ByokEndpointCredentialsSchema.optional(),
  id: BYOKKeyIdSchema.optional(),
}).refine(input => input.credentials || input.id, 'Enter credentials to import models');

export const ListByokEndpointModelsResponseSchema = z.object({
  models: z.array(ByokEndpointModelSchema),
});

/**
 * The outcome of testing a stored key. `outcome` is what both current clients
 * render, so a test failure is a value rather than a message the server words
 * for one client.
 *
 * `success` and `message` are legacy: installed app builds predate the union
 * and read only these two fields, so the server keeps sending the sentence
 * those builds already know. They go with the next release train.
 */
export const BYOKKeyTestResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('ok'),
    provider: z.string(),
    model: z.string(),
    success: z.boolean(),
    message: z.string(),
  }),
  z.object({ outcome: z.literal('incomplete'), success: z.boolean(), message: z.string() }),
  z.object({
    outcome: z.literal('unsupported-provider'),
    success: z.boolean(),
    message: z.string(),
  }),
  z.object({ outcome: z.literal('unreadable-key'), success: z.boolean(), message: z.string() }),
  z.object({
    outcome: z.literal('deprecated-provider'),
    success: z.boolean(),
    message: z.string(),
  }),
  z.object({
    outcome: z.literal('rejected'),
    success: z.boolean(),
    message: z.string(),
  }),
  z.object({
    outcome: z.literal('failed'),
    detail: z.string().optional(),
    success: z.boolean(),
    message: z.string(),
  }),
]);
export type BYOKKeyTestResult = z.infer<typeof BYOKKeyTestResultSchema>;

export const PreviewBYOKRoutingInputSchema = OptionalOrganizationIdSchema.extend({
  modelId: z.string().trim().min(1).max(256),
  apiKind: z.enum(['chat_completions', 'responses', 'messages']).default('chat_completions'),
});
