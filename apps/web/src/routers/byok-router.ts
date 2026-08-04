import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { db } from '@/lib/drizzle';
import { sentryLogger } from '@/lib/utils.server';
import { byok_api_keys, MODELS_BY_PROVIDER_ADMIN_URL } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { encryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import {
  CreateBYOKKeyInputSchema,
  UpdateBYOKKeyInputSchema,
  DeleteBYOKKeyInputSchema,
  SetBYOKKeyEnabledInputSchema,
  ListBYOKKeysInputSchema,
  TestBYOKKeyInputSchema,
  BYOKApiKeyResponseSchema,
  FetchManualByokModelsInputSchema,
  type BYOKApiKeyResponse,
} from '@/lib/ai-gateway/byok/types';
import {
  UserByokProviderIdSchema,
  UserByokTestModels,
  VercelUserByokInferenceProviderIdSchema,
} from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  getVercelModelsMetadataFromDatabase,
  getOpenRouterModelsMetadataFromDatabase,
} from '@/lib/ai-gateway/providers/gateway-models-cache';
import { AISDKError, createGateway, generateText } from 'ai';
import { VERCEL_AI_GATEWAY } from '@/lib/ai-gateway/providers/provider-definitions';
import { getVercelInferenceProviderConfigForUserByok } from '@/lib/ai-gateway/providers/vercel';
import { decryptByokRow } from '@/lib/ai-gateway/byok';
import type { GatewayProviderOptions } from '@ai-sdk/gateway';
import { mapModelIdToVercel } from '@/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { isKiloExclusiveModel } from '@/lib/ai-gateway/models';
import DIRECT_BYOK_PROVIDERS from '@/lib/ai-gateway/providers/direct-byok/direct-byok-definitions';
import {
  createAiSdkProvider,
  formatDirectByokModelId,
} from '@/lib/ai-gateway/providers/direct-byok';
import {
  formatManualByokProviderId,
  getManualByokBaseUrl,
  isManualByokEnabled,
  ManualByokProviderIdSchema,
  safeParseManualByokProviderDefinition,
} from '@/lib/ai-gateway/providers/direct-byok/manual-byok';
import {
  ManualByokModelSchema,
  type ManualByokApiKind,
  type ManualByokProviderDefinition,
} from '@kilocode/db/schema-types';
import { parseOpenAICompatibleProviderModels } from '@/lib/ai-gateway/providers/direct-byok/openai-compatible-models';

const GENERIC_TEST_FAILURE_MESSAGE = 'API key test failed. Check the credential and try again.';
const MANAGED_KEY_READ_ONLY_MESSAGE =
  'This key is managed by your coding plan and is read-only. Cancel the coding plan to remove it.';
const logByokWarning = sentryLogger('byok-key-test', 'warning');

function requireManualByokEnabled() {
  if (!isManualByokEnabled()) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Manual BYOK providers are unavailable on Vercel deployments.',
    });
  }
}

function getProviderName(providerId: string, settings: ManualByokProviderDefinition | null) {
  return ManualByokProviderIdSchema.safeParse(providerId).success && settings
    ? settings.name
    : providerId;
}

function manualByokUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function testManualProvider(
  baseUrl: string,
  apiKind: ManualByokApiKind,
  model: string,
  apiKey: string,
  useXApiKey: boolean
) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.set(useXApiKey ? 'X-Api-Key' : 'Authorization', useXApiKey ? apiKey : `Bearer ${apiKey}`);
  if (apiKind === 'messages') headers.set('anthropic-version', '2023-06-01');
  const body =
    apiKind === 'responses'
      ? { model, input: 'Say hi', max_output_tokens: 1 }
      : { model, messages: [{ role: 'user', content: 'Say hi' }], max_tokens: 1 };
  const path = apiKind === 'chat_completions' ? 'chat/completions' : apiKind;
  return fetch(manualByokUrl(baseUrl, path), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function rejectManagedKeyMutation(managementSource: 'user' | 'coding_plan') {
  if (managementSource === 'coding_plan') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: MANAGED_KEY_READ_ONLY_MESSAGE,
    });
  }
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

  for (const openRouterModel of Object.values(openRouterModelMetadata)) {
    if (isKiloExclusiveModel(openRouterModel.id)) continue;
    const vercelModel = vercelModelMetadata[mapModelIdToVercel(openRouterModel.id)];
    if (!vercelModel) continue;
    if (vercelModel.type !== 'language') continue;
    for (const endpoint of vercelModel.endpoints) {
      const providerParsed = VercelUserByokInferenceProviderIdSchema.safeParse(
        endpoint.provider_name ?? endpoint.tag
      );
      if (!providerParsed.success) continue;
      const providerId = providerParsed.data;
      if (!result[providerId]) result[providerId] = [];
      result[providerId].push(openRouterModel.name + ' (' + openRouterModel.id + ')');
    }
  }

  for (const provider of DIRECT_BYOK_PROVIDERS) {
    for (const model of await provider.models()) {
      if (!result[provider.id]) result[provider.id] = [];
      result[provider.id].push(model.name + ' (' + formatDirectByokModelId(provider, model) + ')');
    }
  }

  for (const models of Object.values(result)) {
    models.sort();
  }

  return result;
}

export const byokRouter = createTRPCRouter({
  manualProvidersEnabled: baseProcedure.output(z.boolean()).query(isManualByokEnabled),

  fetchManualModels: baseProcedure
    .input(FetchManualByokModelsInputSchema)
    .output(z.array(ManualByokModelSchema))
    .mutation(async ({ input }) => {
      requireManualByokEnabled();
      const headers = new Headers();
      headers.set(
        input.use_x_api_key ? 'X-Api-Key' : 'Authorization',
        input.use_x_api_key ? input.api_key : `Bearer ${input.api_key}`
      );
      const response = await fetch(manualByokUrl(input.base_url, '/models'), { headers });
      if (!response.ok) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Failed to load models: ${response.status} ${response.statusText}`,
        });
      }
      return parseOpenAICompatibleProviderModels(await response.json()).map(model => ({
        id: model.id,
        ...(model.name ? { name: model.name } : {}),
        ...(model.context_length ? { context_length: model.context_length } : {}),
        ...(model.max_completion_tokens
          ? { max_completion_tokens: model.max_completion_tokens }
          : {}),
        ...(model.input_modalities
          ? { supports_image_input: model.input_modalities.includes('image') }
          : {}),
      }));
    }),

  listSupportedModels: baseProcedure
    .output(z.record(z.string(), z.array(z.string())))
    .query(fetchSupportedModels),

  list: baseProcedure
    .input(ListBYOKKeysInputSchema)
    .output(z.array(BYOKApiKeyResponseSchema))
    .query(async ({ input, ctx }): Promise<BYOKApiKeyResponse[]> => {
      const { organizationId } = input;
      let canViewProviderSettings = true;

      // If organizationId provided, verify membership; otherwise use user's own keys
      if (organizationId) {
        const role = await ensureOrganizationAccess(ctx, organizationId);
        canViewProviderSettings = role === 'owner' || role === 'billing_manager';
      }

      const keys = await db
        .select({
          id: byok_api_keys.id,
          provider_id: byok_api_keys.provider_id,
          created_at: byok_api_keys.created_at,
          updated_at: byok_api_keys.updated_at,
          created_by: byok_api_keys.created_by,
          management_source: byok_api_keys.management_source,
          is_enabled: byok_api_keys.is_enabled,
          provider_settings: byok_api_keys.provider_settings,
        })
        .from(byok_api_keys)
        .where(
          organizationId
            ? eq(byok_api_keys.organization_id, organizationId)
            : eq(byok_api_keys.kilo_user_id, ctx.user.id)
        );

      // Map provider_id to provider_name (will be enhanced in UI with actual provider names)
      return keys.flatMap(key => {
        const manualId = ManualByokProviderIdSchema.safeParse(key.provider_id);
        if (manualId.success && !isManualByokEnabled()) return [];
        const parsedSettings = manualId.success
          ? safeParseManualByokProviderDefinition(key.provider_settings)
          : null;
        if (parsedSettings && !parsedSettings.success) return [];
        const settings = parsedSettings?.data ?? null;
        return [
          {
            ...key,
            provider_settings: canViewProviderSettings ? settings : null,
            provider_name: getProviderName(key.provider_id, settings),
          },
        ];
      });
    }),

  create: baseProcedure
    .input(CreateBYOKKeyInputSchema)
    .output(BYOKApiKeyResponseSchema)
    .mutation(async ({ input, ctx }): Promise<BYOKApiKeyResponse> => {
      const { organizationId, api_key } = input;
      const isManual = 'provider_code' in input;
      if (isManual) requireManualByokEnabled();
      const provider_id = isManual
        ? formatManualByokProviderId(input.provider_code)
        : input.provider_id;
      const providerSettings = isManual ? input.provider_settings : null;

      // If organizationId provided, verify owner/billing access
      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ORGANIZATION_BILLING_ROLES);
      }

      // Encrypt the API key
      const encrypted = encryptApiKey(api_key, BYOK_ENCRYPTION_KEY);

      // Insert into database - either org-owned or user-owned
      const [newKey] = await db
        .insert(byok_api_keys)
        .values({
          organization_id: organizationId ?? null,
          kilo_user_id: organizationId ? null : ctx.user.id,
          provider_id,
          encrypted_api_key: encrypted,
          provider_settings: providerSettings,
          created_by: ctx.user.id,
        })
        .returning({
          id: byok_api_keys.id,
          provider_id: byok_api_keys.provider_id,
          created_at: byok_api_keys.created_at,
          updated_at: byok_api_keys.updated_at,
          created_by: byok_api_keys.created_by,
          management_source: byok_api_keys.management_source,
          is_enabled: byok_api_keys.is_enabled,
          provider_settings: byok_api_keys.provider_settings,
        });

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

      return {
        ...newKey,
        provider_name: getProviderName(provider_id, providerSettings),
      };
    }),

  update: baseProcedure
    .input(UpdateBYOKKeyInputSchema)
    .output(BYOKApiKeyResponseSchema)
    .mutation(async ({ input, ctx }): Promise<BYOKApiKeyResponse> => {
      const { organizationId, id, api_key, provider_settings } = input;

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
          provider_settings: byok_api_keys.provider_settings,
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

      const manualProvider = ManualByokProviderIdSchema.safeParse(existingKey.provider_id);
      if (manualProvider.success) {
        requireManualByokEnabled();
      } else if (provider_settings) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Provider settings can only be changed for manual providers.',
        });
      }
      if (!api_key && !provider_settings) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No changes were provided.' });
      }

      const encrypted = api_key ? encryptApiKey(api_key, BYOK_ENCRYPTION_KEY) : undefined;
      const [updatedKey] = await db
        .update(byok_api_keys)
        .set({
          ...(encrypted ? { encrypted_api_key: encrypted } : {}),
          ...(provider_settings ? { provider_settings } : {}),
        })
        .where(eq(byok_api_keys.id, id))
        .returning({
          id: byok_api_keys.id,
          provider_id: byok_api_keys.provider_id,
          created_at: byok_api_keys.created_at,
          updated_at: byok_api_keys.updated_at,
          created_by: byok_api_keys.created_by,
          management_source: byok_api_keys.management_source,
          is_enabled: byok_api_keys.is_enabled,
          provider_settings: byok_api_keys.provider_settings,
        });

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

      return {
        ...updatedKey,
        provider_name: getProviderName(updatedKey.provider_id, updatedKey.provider_settings),
      };
    }),

  setEnabled: baseProcedure
    .input(SetBYOKKeyEnabledInputSchema)
    .output(BYOKApiKeyResponseSchema)
    .mutation(async ({ input, ctx }): Promise<BYOKApiKeyResponse> => {
      const { organizationId, id, is_enabled } = input;

      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ORGANIZATION_BILLING_ROLES);
      }

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

      if (ManualByokProviderIdSchema.safeParse(existingKey.provider_id).success) {
        requireManualByokEnabled();
      }

      const [updatedKey] = await db
        .update(byok_api_keys)
        .set({
          is_enabled,
        })
        .where(eq(byok_api_keys.id, id))
        .returning({
          id: byok_api_keys.id,
          provider_id: byok_api_keys.provider_id,
          created_at: byok_api_keys.created_at,
          updated_at: byok_api_keys.updated_at,
          created_by: byok_api_keys.created_by,
          management_source: byok_api_keys.management_source,
          is_enabled: byok_api_keys.is_enabled,
          provider_settings: byok_api_keys.provider_settings,
        });

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

      return {
        ...updatedKey,
        provider_name: getProviderName(updatedKey.provider_id, updatedKey.provider_settings),
      };
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
          organization_id: byok_api_keys.organization_id,
          kilo_user_id: byok_api_keys.kilo_user_id,
          provider_id: byok_api_keys.provider_id,
          encrypted_api_key: byok_api_keys.encrypted_api_key,
          management_source: byok_api_keys.management_source,
          provider_settings: byok_api_keys.provider_settings,
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

      const decryptedKey = decryptByokRow(existingKey);

      const manualProviderId = ManualByokProviderIdSchema.safeParse(existingKey.provider_id);
      if (manualProviderId.success) {
        requireManualByokEnabled();
        const parsedSettings = safeParseManualByokProviderDefinition(existingKey.provider_settings);
        if (!parsedSettings.success) {
          return { success: false, message: GENERIC_TEST_FAILURE_MESSAGE };
        }
        const settings = parsedSettings.data;
        const model = settings.models[0];
        const apiKind = settings.supported_apis[0];
        const baseUrl = getManualByokBaseUrl(settings, apiKind);
        if (!baseUrl) {
          return { success: false, message: GENERIC_TEST_FAILURE_MESSAGE };
        }
        try {
          const response = await testManualProvider(
            baseUrl,
            apiKind,
            model.id,
            decryptedKey.decryptedAPIKey,
            settings.use_x_api_key
          );
          return response.ok
            ? { success: true, message: `API key test success. Model: ${model.id}.` }
            : { success: false, message: GENERIC_TEST_FAILURE_MESSAGE };
        } catch {
          logByokWarning('Manual BYOK key test request failed', {
            providerId: existingKey.provider_id,
          });
          return { success: false, message: GENERIC_TEST_FAILURE_MESSAGE };
        }
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

      function setup() {
        const provider = UserByokProviderIdSchema.parse(decryptedKey.providerId);
        const model = UserByokTestModels[provider];

        const directByokProvider = DIRECT_BYOK_PROVIDERS.find(plan => plan.id === provider);
        if (directByokProvider) {
          return {
            finalProvider: provider,
            model: createAiSdkProvider(directByokProvider, decryptedKey.decryptedAPIKey)(model),
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
        const { finalProvider, model, providerOptions } = setup();
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
        const message = AISDKError.isInstance(e) ? e.message : undefined;
        logByokWarning('BYOK key test request failed', {
          providerId: decryptedKey.providerId,
          message,
        });
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

      if (ManualByokProviderIdSchema.safeParse(existingKey.provider_id).success) {
        requireManualByokEnabled();
      }

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
