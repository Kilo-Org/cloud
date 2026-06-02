import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { db } from '@/lib/drizzle';
import { sentryLogger } from '@/lib/utils.server';
import {
  byok_api_keys,
  coding_plan_subscriptions,
  MODELS_BY_PROVIDER_ADMIN_URL,
} from '@kilocode/db/schema';
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
  type BYOKApiKeyResponse,
} from '@/lib/ai-gateway/byok/types';
import {
  UserByokProviderIdSchema,
  UserByokTestModels,
  VercelUserByokInferenceProviderIdSchema,
} from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  getVercelModelsMetadata,
  getOpenRouterModelsMetadata,
} from '@/lib/ai-gateway/providers/gateway-models-cache';
import { createGateway, generateText } from 'ai';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import { getVercelInferenceProviderConfigForUserByok } from '@/lib/ai-gateway/providers/vercel';
import { decryptByokRow } from '@/lib/ai-gateway/byok';
import type { GatewayProviderOptions } from '@ai-sdk/gateway';
import { mapModelIdToVercel } from '@/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { isCodestralModel } from '@/lib/ai-gateway/providers/mistral';
import { isKiloExclusiveModel } from '@/lib/ai-gateway/models';
import DIRECT_BYOK_PROVIDERS from '@/lib/ai-gateway/providers/direct-byok/direct-byok-definitions';
import {
  createAiSdkProvider,
  formatDirectByokModelId,
} from '@/lib/ai-gateway/providers/direct-byok';

const CODESTRAL_FIM_URL = 'https://codestral.mistral.ai/v1/fim/completions';
const CODESTRAL_TEST_MODEL = 'codestral-2508';
const GENERIC_TEST_FAILURE_MESSAGE =
  'API key test failed. Check the credential and supported models, then try again.';
const logByokWarning = sentryLogger('byok-key-test', 'warning');

async function testCodestralApiKey(apiKey: string): Promise<{ success: boolean; message: string }> {
  try {
    const res = await fetch(CODESTRAL_FIM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: CODESTRAL_TEST_MODEL,
        prompt: 'def hi():\n    ',
        suffix: '\n',
        max_tokens: 1,
        stream: false,
      }),
    });
    // Always drain the body so the underlying Undici connection is released.
    await res.text().catch(() => '');
    if (res.ok) {
      return {
        success: true,
        message: `API key test success. Provider: codestral. Model: ${CODESTRAL_TEST_MODEL}.`,
      };
    }
    logByokWarning('Codestral BYOK key test failed', {
      providerId: 'codestral',
      status: res.status,
    });
    return { success: false, message: GENERIC_TEST_FAILURE_MESSAGE };
  } catch {
    logByokWarning('Codestral BYOK key test request failed', { providerId: 'codestral' });
    return { success: false, message: GENERIC_TEST_FAILURE_MESSAGE };
  }
}

async function fetchSupportedModels(): Promise<Record<string, string[]>> {
  const [vercelModelMetadata, openRouterModelMetadata] = await Promise.all([
    getVercelModelsMetadata(),
    getOpenRouterModelsMetadata(),
  ]);

  if (Object.keys(vercelModelMetadata).length === 0) {
    throw new Error(
      'No Vercel model metadata in Redis, use the admin panel at ' + MODELS_BY_PROVIDER_ADMIN_URL
    );
  }

  if (Object.keys(openRouterModelMetadata).length === 0) {
    throw new Error(
      'No OpenRouter model metadata in Redis, use the admin panel at ' +
        MODELS_BY_PROVIDER_ADMIN_URL
    );
  }

  const result: Record<string, string[]> = {};

  result['codestral'] = ['Codestral (mistralai/codestral-2508)'];

  for (const openRouterModel of Object.values(openRouterModelMetadata)) {
    if (isKiloExclusiveModel(openRouterModel.id)) continue;
    const vercelModel = vercelModelMetadata[mapModelIdToVercel(openRouterModel.id, false)];
    if (!vercelModel) continue;
    if (isCodestralModel(vercelModel.id)) continue;
    if (vercelModel.type !== 'language') continue;
    for (const endpoint of vercelModel.endpoints) {
      const providerParsed = VercelUserByokInferenceProviderIdSchema.safeParse(endpoint.tag);
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
  listSupportedModels: baseProcedure
    .output(z.record(z.string(), z.array(z.string())))
    .query(fetchSupportedModels),

  list: baseProcedure
    .input(ListBYOKKeysInputSchema)
    .output(z.array(BYOKApiKeyResponseSchema))
    .query(async ({ input, ctx }): Promise<BYOKApiKeyResponse[]> => {
      const { organizationId } = input;

      // If organizationId provided, verify membership; otherwise use user's own keys
      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId);
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
        })
        .from(byok_api_keys)
        .where(
          organizationId
            ? eq(byok_api_keys.organization_id, organizationId)
            : eq(byok_api_keys.kilo_user_id, ctx.user.id)
        );

      // Map provider_id to provider_name (will be enhanced in UI with actual provider names)
      return keys.map(key => ({
        ...key,
        provider_name: key.provider_id,
      }));
    }),

  create: baseProcedure
    .input(CreateBYOKKeyInputSchema)
    .output(BYOKApiKeyResponseSchema)
    .mutation(async ({ input, ctx }): Promise<BYOKApiKeyResponse> => {
      const { organizationId, provider_id, api_key } = input;

      // If organizationId provided, verify owner/billing access
      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager']);
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
        provider_name: provider_id,
      };
    }),

  update: baseProcedure
    .input(UpdateBYOKKeyInputSchema)
    .output(BYOKApiKeyResponseSchema)
    .mutation(async ({ input, ctx }): Promise<BYOKApiKeyResponse> => {
      const { organizationId, id, api_key } = input;

      // If organizationId provided, verify owner/billing access
      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager']);
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

      const encrypted = encryptApiKey(api_key, BYOK_ENCRYPTION_KEY);
      const transfersCodingPlanOwnership =
        !organizationId && existingKey.management_source === 'coding_plan';

      const updatedKey = await db.transaction(async tx => {
        const [updated] = await tx
          .update(byok_api_keys)
          .set(
            transfersCodingPlanOwnership
              ? { encrypted_api_key: encrypted, management_source: 'user' }
              : { encrypted_api_key: encrypted }
          )
          .where(eq(byok_api_keys.id, id))
          .returning({
            id: byok_api_keys.id,
            provider_id: byok_api_keys.provider_id,
            created_at: byok_api_keys.created_at,
            updated_at: byok_api_keys.updated_at,
            created_by: byok_api_keys.created_by,
            management_source: byok_api_keys.management_source,
            is_enabled: byok_api_keys.is_enabled,
          });

        if (!updated) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'BYOK key not found' });
        }
        if (transfersCodingPlanOwnership) {
          await tx
            .update(coding_plan_subscriptions)
            .set({ installed_byok_key_id: null })
            .where(eq(coding_plan_subscriptions.installed_byok_key_id, id));
        }
        return updated;
      });

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
        provider_name: updatedKey.provider_id,
      };
    }),

  setEnabled: baseProcedure
    .input(SetBYOKKeyEnabledInputSchema)
    .output(BYOKApiKeyResponseSchema)
    .mutation(async ({ input, ctx }): Promise<BYOKApiKeyResponse> => {
      const { organizationId, id, is_enabled } = input;

      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager']);
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
        provider_name: updatedKey.provider_id,
      };
    }),

  testApiKey: baseProcedure
    .input(TestBYOKKeyInputSchema)
    .output(z.object({ success: z.boolean(), message: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { organizationId, id } = input;

      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager']);
      }

      const [existingKey] = await db
        .select({
          organization_id: byok_api_keys.organization_id,
          kilo_user_id: byok_api_keys.kilo_user_id,
          provider_id: byok_api_keys.provider_id,
          encrypted_api_key: byok_api_keys.encrypted_api_key,
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

      const decryptedKey = decryptByokRow(existingKey);

      // Codestral keys only authenticate against codestral.mistral.ai, not api.mistral.ai
      // (the endpoint the Vercel gateway's `mistral` provider uses). Test the key directly
      // against the Codestral FIM endpoint instead of going through the gateway.
      if (decryptedKey.providerId === 'codestral') {
        return await testCodestralApiKey(decryptedKey.decryptedAPIKey);
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
            apiKey: PROVIDERS.VERCEL_AI_GATEWAY.apiKey,
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
          return { success: false, message: GENERIC_TEST_FAILURE_MESSAGE };
        }

        const metadata = output.providerMetadata?.gateway?.routing as
          | { originalModelId?: string; finalProvider?: string }
          | undefined;

        return {
          success: true,
          message: `API key test success. Provider: ${metadata?.finalProvider ?? finalProvider}. Model: ${metadata?.originalModelId ?? model.modelId}.`,
        };
      } catch {
        logByokWarning('BYOK key test request failed', { providerId: decryptedKey.providerId });
        return { success: false, message: GENERIC_TEST_FAILURE_MESSAGE };
      }
    }),

  delete: baseProcedure
    .input(DeleteBYOKKeyInputSchema)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const { organizationId, id } = input;

      // If organizationId provided, verify owner/billing access
      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager']);
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
