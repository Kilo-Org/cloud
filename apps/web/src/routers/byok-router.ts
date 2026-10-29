import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import {
  ORGANIZATION_BILLING_ROLES,
  ORGANIZATION_MANAGE_ROLES,
  canManageOrganization,
  type OrganizationRole,
} from '@kilocode/app-shared/organizations';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  ByokRoutingPreviewSchema,
  previewByokRouting,
} from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';
import { byok_api_keys, MODELS_BY_PROVIDER_ADMIN_URL } from '@kilocode/db/schema';
import { and, eq, ne, sql } from 'drizzle-orm';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { createAuditLog } from '@kilocode/web-shared/lib/organizations/organization-audit-logs';
import {
  CreateBYOKKeyInputSchema,
  UpdateBYOKKeyInputSchema,
  DeleteBYOKKeyInputSchema,
  SetBYOKKeyEnabledInputSchema,
  SetBYOKKeyCatalogModeInputSchema,
  ListBYOKKeysInputSchema,
  ReorderBYOKKeysInputSchema,
  TestBYOKKeyInputSchema,
  PreviewBYOKRoutingInputSchema,
  BYOKApiKeyResponseSchema,
  type BYOKApiKeyResponse,
} from '@/lib/byok/types';
import {
  GatewayUserByokProviderIdSchema,
  UserByokProviderIdSchema,
  UserByokTestModels,
  getVercelUserByokProviderIdForEndpoint,
  VercelUserByokInferenceProviderIdSchema,
  isExperimentalByokProviderId,
  type ExperimentalByokProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  getVercelModelsMetadataFromDatabase,
  getOpenRouterModelsMetadataFromDatabase,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { createGateway, generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { ATTRIBUTION_HEADERS } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/attribution-headers';
import { getVercelInferenceProviderConfigForUserByok } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import {
  BYOK_KEY_ORDER,
  byokOwner,
  decryptByokRow,
  getByokKmsContext,
  getModelGatewayUserByokProviders,
  servesCatalogModels,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { encryptByokForStorage } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import { GatewayAuthenticationError, type GatewayProviderOptions } from '@ai-sdk/gateway';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { isKiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import DIRECT_BYOK_PROVIDERS from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/direct-byok-definitions';
import {
  createAiSdkProvider,
  formatDirectByokModelId,
  listDirectByokCatalogModels,
  offersCatalogMode,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { parseAwsBedrockCredentials } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/bedrock-byok';
import { parseGcpVertexCredentials } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/vertex-byok';
import { isExperimentalByokEnabled } from '@/lib/byok/experimental-byok';
import { OPENAI_CHATGPT_PROVIDER_ID } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/provider-id';

const GENERIC_TEST_FAILURE_MESSAGE = 'API key test failed. Check the credential and try again.';
const KEY_DECRYPTION_FAILURE_MESSAGE =
  'API key test failed: the stored key could not be read. Try again later.';
const VERCEL_AI_GATEWAY_KEY_REJECTED_MESSAGE =
  'API key test failed: Vercel AI Gateway rejected this API key. Check that the key is correct and has not been revoked.';
const KEYS_CHANGED_MESSAGE = 'Your API keys changed. Reload the page and try again.';
const MANAGED_KEY_READ_ONLY_MESSAGE =
  'This key is managed by your coding plan and is read-only. Cancel the coding plan to remove it.';
const logByokWarning = sentryLogger('byok-key-test', 'warning');

const EXPERIMENTAL_BYOK_CREDENTIAL_PARSERS = {
  'bedrock-byok': parseAwsBedrockCredentials,
  'vertex-byok': parseGcpVertexCredentials,
} satisfies Record<ExperimentalByokProviderId, (credential: string) => unknown>;

function validateUserByokCredential(providerId: string, credential: string) {
  const parsedProviderId = VercelUserByokInferenceProviderIdSchema.safeParse(providerId);
  const parseExperimentalCredential = isExperimentalByokProviderId(providerId)
    ? EXPERIMENTAL_BYOK_CREDENTIAL_PARSERS[providerId]
    : undefined;
  if (!parsedProviderId.success && !parseExperimentalCredential) return;

  try {
    if (parsedProviderId.success) {
      getVercelInferenceProviderConfigForUserByok({
        providerId: parsedProviderId.data,
        decryptedAPIKey: credential,
      });
    } else {
      parseExperimentalCredential?.(credential);
    }
  } catch {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Invalid credentials for provider: ${providerId}`,
    });
  }
}

const BYOK_KEY_COLUMNS = {
  id: byok_api_keys.id,
  provider_id: byok_api_keys.provider_id,
  created_at: byok_api_keys.created_at,
  updated_at: byok_api_keys.updated_at,
  created_by: byok_api_keys.created_by,
  management_source: byok_api_keys.management_source,
  is_enabled: byok_api_keys.is_enabled,
  settings: byok_api_keys.settings,
};

type BYOKKeyRow = Omit<
  BYOKApiKeyResponse,
  'provider_name' | 'serve_catalog_models' | 'supports_catalog_mode' | 'can_change_catalog_mode'
> & { settings: unknown };

/**
 * Catalog mode decides whether organization model policies apply to the key, so on organization
 * keys only the roles that edit those policies may change it.
 */
function canChangeCatalogMode(organizationRole: OrganizationRole | null) {
  return organizationRole === null || canManageOrganization(organizationRole);
}

async function toBYOKApiKeyResponse(
  { settings, ...key }: BYOKKeyRow,
  organizationRole: OrganizationRole | null
): Promise<BYOKApiKeyResponse> {
  const supportsCatalog = await offersCatalogMode(key.provider_id);
  const serveCatalogModels = servesCatalogModels(settings);
  return {
    ...key,
    provider_name: key.provider_id,
    serve_catalog_models: serveCatalogModels,
    supports_catalog_mode: supportsCatalog,
    // An enabled key can always leave catalog mode, even after its provider loses its mappings.
    can_change_catalog_mode:
      (supportsCatalog || serveCatalogModels) &&
      key.management_source === 'user' &&
      canChangeCatalogMode(organizationRole),
  };
}

function rejectUnavailableExperimentalProvider(
  providerId: string,
  organizationId: string | null | undefined
) {
  if (isExperimentalByokProviderId(providerId) && !isExperimentalByokEnabled(organizationId)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `Provider ${providerId} is not available yet.`,
    });
  }
}

function rejectManagedKeyMutation(managementSource: 'user' | 'coding_plan') {
  if (managementSource === 'coding_plan') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: MANAGED_KEY_READ_ONLY_MESSAGE,
    });
  }
}

async function fetchCatalogModeSupportedModels(): Promise<Record<string, string[]>> {
  const openRouterModelMetadata = await getOpenRouterModelsMetadataFromDatabase();
  const result: Record<string, string[]> = {};
  for (const provider of DIRECT_BYOK_PROVIDERS) {
    const entries = await listDirectByokCatalogModels(provider.id);
    if (entries.length === 0) continue;
    result[provider.id] = entries
      .map(({ catalogModelId, model }) => {
        const name = openRouterModelMetadata[catalogModelId]?.name ?? model.name;
        return `${name} (${catalogModelId})`;
      })
      .sort();
  }
  return result;
}

async function fetchSupportedModels(): Promise<Record<string, string[]>> {
  const [vercelModelMetadata, openRouterModelMetadata] = await Promise.all([
    getVercelModelsMetadataFromDatabase(),
    getOpenRouterModelsMetadataFromDatabase(),
  ]);

  if (Object.keys(vercelModelMetadata).length === 0) {
    throw new Error(
      'No Vercel model metadata in the database, use the admin panel at ' +
        MODELS_BY_PROVIDER_ADMIN_URL
    );
  }

  if (Object.keys(openRouterModelMetadata).length === 0) {
    throw new Error(
      'No OpenRouter model metadata in the database, use the admin panel at ' +
        MODELS_BY_PROVIDER_ADMIN_URL
    );
  }

  const result: Record<string, string[]> = {};

  result['codestral'] = ['Codestral (mistralai/codestral-2508)'];

  const addSupportedModel = (providerId: string, model: { id: string; name: string }) => {
    if (!result[providerId]) result[providerId] = [];
    result[providerId].push(model.name + ' (' + model.id + ')');
  };

  for (const openRouterModel of Object.values(openRouterModelMetadata)) {
    if (isKiloExclusiveModel(openRouterModel.id)) continue;
    for (const providerId of await getModelGatewayUserByokProviders(openRouterModel.id)) {
      addSupportedModel(providerId, openRouterModel);
    }
    const vercelModel = vercelModelMetadata[await mapModelIdToVercel(openRouterModel.id)];
    if (!vercelModel) continue;
    if (vercelModel.type !== 'language') continue;
    for (const endpoint of vercelModel.endpoints) {
      const providerId = getVercelUserByokProviderIdForEndpoint(
        endpoint.provider_name ?? endpoint.tag
      );
      if (!providerId) continue;
      addSupportedModel(providerId, openRouterModel);
    }
  }

  for (const provider of DIRECT_BYOK_PROVIDERS) {
    for (const model of await provider.models()) {
      addSupportedModel(provider.id, {
        id: formatDirectByokModelId(provider, model),
        name: model.name,
      });
    }
  }

  for (const models of Object.values(result)) {
    models.sort();
  }

  return result;
}

export const byokRouter = createTRPCRouter({
  listSupportedModels: baseProcedure
    .output(z.record(z.string(), z.array(z.string())))
    .query(fetchSupportedModels),

  /** The models a key of each direct BYOK provider serves in catalog mode, listed by catalog id. */
  listCatalogModeSupportedModels: baseProcedure
    .output(z.record(z.string(), z.array(z.string())))
    .query(fetchCatalogModeSupportedModels),

  /** Whether keys for experimental BYOK providers, currently direct Amazon Bedrock and Google Vertex AI, can be added. */
  experimentalByokEnabled: baseProcedure
    .input(ListBYOKKeysInputSchema)
    .output(z.boolean())
    .query(async ({ input, ctx }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      return isExperimentalByokEnabled(input.organizationId);
    }),

  list: baseProcedure
    .input(ListBYOKKeysInputSchema)
    .output(z.array(BYOKApiKeyResponseSchema))
    .query(async ({ input, ctx }): Promise<BYOKApiKeyResponse[]> => {
      const { organizationId } = input;

      // If organizationId provided, verify membership; otherwise use user's own keys
      const organizationRole = organizationId
        ? await ensureOrganizationAccess(ctx, organizationId)
        : null;

      const keys = await db
        .select(BYOK_KEY_COLUMNS)
        .from(byok_api_keys)
        .where(
          organizationId
            ? eq(byok_api_keys.organization_id, organizationId)
            : eq(byok_api_keys.kilo_user_id, ctx.user.id)
        )
        .orderBy(...BYOK_KEY_ORDER);

      // Map provider_id to provider_name (will be enhanced in UI with actual provider names)
      return Promise.all(keys.map(key => toBYOKApiKeyResponse(key, organizationRole)));
    }),

  /**
   * Sets the priority of every personal key, so routing tries them in the given order wherever
   * several can serve a request. The ChatGPT connection is not a listed key and keeps its own step.
   */
  reorder: baseProcedure
    .input(ReorderBYOKKeysInputSchema)
    .output(z.array(BYOKApiKeyResponseSchema))
    .mutation(async ({ input, ctx }): Promise<BYOKApiKeyResponse[]> => {
      const ownedByCaller = and(
        eq(byok_api_keys.kilo_user_id, ctx.user.id),
        ne(byok_api_keys.provider_id, OPENAI_CHATGPT_PROVIDER_ID)
      );
      const keys = await db.transaction(async tx => {
        const owned = await tx
          .select({ id: byok_api_keys.id })
          .from(byok_api_keys)
          .where(ownedByCaller)
          .for('update');
        const ownedIds = new Set(owned.map(key => key.id));
        if (owned.length !== input.keyIds.length || input.keyIds.some(id => !ownedIds.has(id))) {
          throw new TRPCError({ code: 'CONFLICT', message: KEYS_CHANGED_MESSAGE });
        }
        for (const [priority, id] of input.keyIds.entries()) {
          await tx
            .update(byok_api_keys)
            .set({
              settings: sql`${byok_api_keys.settings} || ${JSON.stringify({ priority })}::jsonb`,
            })
            .where(and(eq(byok_api_keys.id, id), ownedByCaller));
        }
        return tx
          .select(BYOK_KEY_COLUMNS)
          .from(byok_api_keys)
          .where(eq(byok_api_keys.kilo_user_id, ctx.user.id))
          .orderBy(...BYOK_KEY_ORDER);
      });
      return Promise.all(keys.map(key => toBYOKApiKeyResponse(key, null)));
    }),

  /**
   * The routes a request for a catalog model would try with the owner's keys, in order. Reads key
   * metadata only and never decrypts a key.
   */
  previewRouting: baseProcedure
    .input(PreviewBYOKRoutingInputSchema)
    .output(ByokRoutingPreviewSchema)
    .query(async ({ input, ctx }) => {
      const { organizationId, modelId, apiKind } = input;
      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId);
      }
      return previewByokRouting({
        fromDb: db,
        owner: byokOwner(ctx.user.id, organizationId),
        requestedModel: modelId.toLowerCase(),
        apiKind,
      });
    }),

  create: baseProcedure
    .input(CreateBYOKKeyInputSchema)
    .output(BYOKApiKeyResponseSchema)
    .mutation(async ({ input, ctx }): Promise<BYOKApiKeyResponse> => {
      const { organizationId, provider_id, api_key } = input;

      // If organizationId provided, verify owner/billing access
      const organizationRole = organizationId
        ? await ensureOrganizationAccess(ctx, organizationId, ORGANIZATION_BILLING_ROLES)
        : null;

      rejectUnavailableExperimentalProvider(provider_id, organizationId);
      validateUserByokCredential(provider_id, api_key);

      // Encrypt the API key
      const encrypted = encryptApiKey(api_key, BYOK_ENCRYPTION_KEY);
      const keyId = crypto.randomUUID();
      const envelope = await encryptByokForStorage({
        apiKey: api_key,
        context: {
          key_id: keyId,
          owner_type: organizationId ? 'organization' : 'user',
          owner_id: organizationId ?? ctx.user.id,
          provider_id,
        },
        actorUserId: ctx.user.id,
      });

      // Insert into database - either org-owned or user-owned
      const [newKey] = await db
        .insert(byok_api_keys)
        .values({
          id: keyId,
          organization_id: organizationId ?? null,
          kilo_user_id: organizationId ? null : ctx.user.id,
          provider_id,
          encrypted_api_key: encrypted,
          encrypted_api_key_envelope: envelope,
          created_by: ctx.user.id,
        })
        .returning(BYOK_KEY_COLUMNS);

      // Create audit log only for organization keys
      if (organizationId) {
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: `Added BYOK key for provider: ${provider_id}`,
          organization_id: organizationId,
        });
      }

      return toBYOKApiKeyResponse(newKey, organizationRole);
    }),

  update: baseProcedure
    .input(UpdateBYOKKeyInputSchema)
    .output(BYOKApiKeyResponseSchema)
    .mutation(async ({ input, ctx }): Promise<BYOKApiKeyResponse> => {
      const { organizationId, id, api_key } = input;

      // If organizationId provided, verify owner/billing access
      const organizationRole = organizationId
        ? await ensureOrganizationAccess(ctx, organizationId, ORGANIZATION_BILLING_ROLES)
        : null;

      // Verify key exists and belongs to the organization or user
      const [existingKey] = await db
        .select({
          id: byok_api_keys.id,
          organization_id: byok_api_keys.organization_id,
          kilo_user_id: byok_api_keys.kilo_user_id,
          provider_id: byok_api_keys.provider_id,
          management_source: byok_api_keys.management_source,
        })
        .from(byok_api_keys)
        .where(eq(byok_api_keys.id, id));

      if (!existingKey) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'BYOK key not found',
        });
      }

      // Verify ownership: org key must match org, user key must match user
      if (organizationId) {
        if (existingKey.organization_id !== organizationId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'BYOK key not found',
          });
        }
      } else {
        if (existingKey.kilo_user_id !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'BYOK key not found',
          });
        }
      }

      rejectManagedKeyMutation(existingKey.management_source);
      rejectUnavailableExperimentalProvider(existingKey.provider_id, existingKey.organization_id);
      validateUserByokCredential(existingKey.provider_id, api_key);

      const encrypted = encryptApiKey(api_key, BYOK_ENCRYPTION_KEY);
      const envelope = await encryptByokForStorage({
        apiKey: api_key,
        context: getByokKmsContext(existingKey),
        actorUserId: ctx.user.id,
      });
      const [updatedKey] = await db
        .update(byok_api_keys)
        .set({ encrypted_api_key: encrypted, encrypted_api_key_envelope: envelope })
        .where(eq(byok_api_keys.id, id))
        .returning(BYOK_KEY_COLUMNS);

      if (!updatedKey) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'BYOK key not found' });
      }

      // Create audit log only for organization keys
      if (existingKey.organization_id) {
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: `Updated BYOK key for provider: ${existingKey.provider_id}`,
          organization_id: existingKey.organization_id,
        });
      }

      return toBYOKApiKeyResponse(updatedKey, organizationRole);
    }),

  setEnabled: baseProcedure
    .input(SetBYOKKeyEnabledInputSchema)
    .output(BYOKApiKeyResponseSchema)
    .mutation(async ({ input, ctx }): Promise<BYOKApiKeyResponse> => {
      const { organizationId, id, is_enabled } = input;

      const organizationRole = organizationId
        ? await ensureOrganizationAccess(ctx, organizationId, ORGANIZATION_BILLING_ROLES)
        : null;

      const [existingKey] = await db
        .select({
          organization_id: byok_api_keys.organization_id,
          kilo_user_id: byok_api_keys.kilo_user_id,
          provider_id: byok_api_keys.provider_id,
          management_source: byok_api_keys.management_source,
        })
        .from(byok_api_keys)
        .where(eq(byok_api_keys.id, id));

      if (!existingKey) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'BYOK key not found',
        });
      }

      if (organizationId) {
        if (existingKey.organization_id !== organizationId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'BYOK key not found',
          });
        }
      } else {
        if (existingKey.kilo_user_id !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'BYOK key not found',
          });
        }
      }

      rejectManagedKeyMutation(existingKey.management_source);

      const [updatedKey] = await db
        .update(byok_api_keys)
        .set({
          is_enabled,
        })
        .where(eq(byok_api_keys.id, id))
        .returning(BYOK_KEY_COLUMNS);

      if (existingKey.organization_id) {
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: `${is_enabled ? 'Enabled' : 'Disabled'} BYOK key for provider: ${existingKey.provider_id}`,
          organization_id: existingKey.organization_id,
        });
      }

      return toBYOKApiKeyResponse(updatedKey, organizationRole);
    }),

  setCatalogMode: baseProcedure
    .input(SetBYOKKeyCatalogModeInputSchema)
    .output(BYOKApiKeyResponseSchema)
    .mutation(async ({ input, ctx }): Promise<BYOKApiKeyResponse> => {
      const { organizationId, id, serve_catalog_models } = input;

      const organizationRole = organizationId
        ? await ensureOrganizationAccess(ctx, organizationId, ORGANIZATION_MANAGE_ROLES)
        : null;

      const [existingKey] = await db
        .select({
          organization_id: byok_api_keys.organization_id,
          kilo_user_id: byok_api_keys.kilo_user_id,
          provider_id: byok_api_keys.provider_id,
          management_source: byok_api_keys.management_source,
        })
        .from(byok_api_keys)
        .where(eq(byok_api_keys.id, id));

      const ownsKey = organizationId
        ? existingKey?.organization_id === organizationId
        : existingKey?.kilo_user_id === ctx.user.id;
      if (!existingKey || !ownsKey) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'BYOK key not found' });
      }

      rejectManagedKeyMutation(existingKey.management_source);
      // Turning catalog mode off stays possible after a provider loses its catalog mappings.
      if (serve_catalog_models && !(await offersCatalogMode(existingKey.provider_id))) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Provider ${existingKey.provider_id} does not support Kilo catalog model IDs.`,
        });
      }

      const [updatedKey] = await db
        .update(byok_api_keys)
        .set({
          settings: sql`${byok_api_keys.settings} || ${JSON.stringify({ serve_catalog_models })}::jsonb`,
        })
        .where(eq(byok_api_keys.id, id))
        .returning(BYOK_KEY_COLUMNS);

      if (existingKey.organization_id) {
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: `${serve_catalog_models ? 'Enabled' : 'Disabled'} Kilo catalog model IDs for BYOK key for provider: ${existingKey.provider_id}`,
          organization_id: existingKey.organization_id,
        });
      }

      return toBYOKApiKeyResponse(updatedKey, organizationRole);
    }),

  testApiKey: baseProcedure
    .input(TestBYOKKeyInputSchema)
    .output(z.object({ success: z.boolean(), message: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { organizationId, id } = input;

      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ORGANIZATION_BILLING_ROLES);
      }

      const [existingKey] = await db
        .select({
          id: byok_api_keys.id,
          organization_id: byok_api_keys.organization_id,
          kilo_user_id: byok_api_keys.kilo_user_id,
          provider_id: byok_api_keys.provider_id,
          encrypted_api_key: byok_api_keys.encrypted_api_key,
          encrypted_api_key_envelope: byok_api_keys.encrypted_api_key_envelope,
          management_source: byok_api_keys.management_source,
        })
        .from(byok_api_keys)
        .where(eq(byok_api_keys.id, id));

      if (!existingKey) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'BYOK key not found' });
      }

      if (organizationId) {
        if (existingKey.organization_id !== organizationId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'BYOK key not found' });
        }
      } else {
        if (existingKey.kilo_user_id !== ctx.user.id) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'BYOK key not found' });
        }
      }

      const providerId = UserByokProviderIdSchema.safeParse(existingKey.provider_id);
      if (!providerId.success) {
        return {
          success: false,
          message: `Provider ${existingKey.provider_id} is no longer supported.`,
        };
      }

      let decryptedKey: Awaited<ReturnType<typeof decryptByokRow>>;
      try {
        decryptedKey = await decryptByokRow(existingKey);
      } catch (e) {
        logByokWarning('BYOK key test could not decrypt the stored key', {
          providerId: existingKey.provider_id,
          message: e instanceof Error ? e.message : undefined,
        });
        return { success: false, message: KEY_DECRYPTION_FAILURE_MESSAGE };
      }

      // Codestral is deprecated and its key only authenticates against codestral.mistral.ai,
      // which the gateway test path below cannot reach (it routes codestral to api.mistral.ai).
      // Decline to test it rather than returning a misleading failure for a still-valid key.
      if (decryptedKey.providerId === 'codestral') {
        return {
          success: false,
          message: 'Codestral is deprecated and its API key can no longer be tested.',
        };
      }

      async function setup() {
        const provider = UserByokProviderIdSchema.parse(decryptedKey.providerId);
        const model = UserByokTestModels[provider];

        const directByokProvider = DIRECT_BYOK_PROVIDERS.find(plan => plan.id === provider);
        if (directByokProvider) {
          return {
            finalProvider: provider,
            model: (
              await createAiSdkProvider(directByokProvider, decryptedKey.decryptedAPIKey, model)
            )(model),
          };
        }

        if (provider === GatewayUserByokProviderIdSchema.enum['vercel-ai-gateway']) {
          const userGateway = createGateway({ apiKey: decryptedKey.decryptedAPIKey });
          return {
            finalProvider: provider,
            model: userGateway(model),
            // generateText replaces a gateway authentication error with
            // developer setup instructions; the credits lookup surfaces a
            // rejected key as the gateway's own error instead.
            verifyCredential: () => userGateway.getCredits(),
          };
        }

        if (provider === GatewayUserByokProviderIdSchema.enum.openrouter) {
          return {
            finalProvider: provider,
            model: createOpenAICompatible({
              name: 'openrouter',
              baseURL: OPENROUTER.apiUrl,
              apiKey: decryptedKey.decryptedAPIKey,
              headers: ATTRIBUTION_HEADERS,
            })(model),
          };
        }

        const [finalProvider, byokList] = getVercelInferenceProviderConfigForUserByok(decryptedKey);
        return {
          finalProvider,
          model: createGateway({
            apiKey: VERCEL_AI_GATEWAY.apiKey,
          })(model),
          providerOptions: {
            gateway: {
              only: [finalProvider],
              byok: { [finalProvider]: byokList },
            } satisfies GatewayProviderOptions,
          },
        };
      }

      try {
        const { finalProvider, model, providerOptions, verifyCredential } = await setup();
        await verifyCredential?.();
        const output = await generateText({
          model,
          prompt: 'Say hi',
          maxOutputTokens: 1000,
          providerOptions,
        });

        if (output.finishReason !== 'stop') {
          logByokWarning('BYOK key test returned an unsuccessful completion', {
            providerId: decryptedKey.providerId,
          });
          return { success: false, message: `API key test failed: ${output.finishReason}` };
        }

        const metadata = output.providerMetadata?.gateway?.routing as
          | { originalModelId?: string; finalProvider?: string }
          | undefined;

        return {
          success: true,
          message: `API key test success. Provider: ${metadata?.finalProvider ?? finalProvider}. Model: ${metadata?.originalModelId ?? model.modelId}.`,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : undefined;
        logByokWarning('BYOK key test request failed', {
          providerId: decryptedKey.providerId,
          message,
        });
        if (
          decryptedKey.providerId === GatewayUserByokProviderIdSchema.enum['vercel-ai-gateway'] &&
          GatewayAuthenticationError.isInstance(e)
        ) {
          return { success: false, message: VERCEL_AI_GATEWAY_KEY_REJECTED_MESSAGE };
        }
        return {
          success: false,
          message: message ? `API key test failed: ${message}` : GENERIC_TEST_FAILURE_MESSAGE,
        };
      }
    }),

  delete: baseProcedure
    .input(DeleteBYOKKeyInputSchema)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const { organizationId, id } = input;

      // If organizationId provided, verify owner/billing access
      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ORGANIZATION_BILLING_ROLES);
      }

      // Verify key exists and belongs to the organization or user
      const [existingKey] = await db
        .select({
          organization_id: byok_api_keys.organization_id,
          kilo_user_id: byok_api_keys.kilo_user_id,
          provider_id: byok_api_keys.provider_id,
          management_source: byok_api_keys.management_source,
        })
        .from(byok_api_keys)
        .where(eq(byok_api_keys.id, id));

      if (!existingKey) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'BYOK key not found',
        });
      }

      // Verify ownership: org key must match org, user key must match user
      if (organizationId) {
        if (existingKey.organization_id !== organizationId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'BYOK key not found',
          });
        }
      } else {
        if (existingKey.kilo_user_id !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'BYOK key not found',
          });
        }
      }

      rejectManagedKeyMutation(existingKey.management_source);

      // Delete from database
      await db.delete(byok_api_keys).where(eq(byok_api_keys.id, id));

      // Create audit log only for organization keys
      if (existingKey.organization_id) {
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: `Deleted BYOK key for provider: ${existingKey.provider_id}`,
          organization_id: existingKey.organization_id,
        });
      }

      return { success: true };
    }),
});
