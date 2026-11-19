import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import {
  ORGANIZATION_BILLING_ROLES,
  ORGANIZATION_MANAGE_ROLES,
  canManageOrganization,
  type OrganizationRole,
} from '@kilocode/app-shared/organizations';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import {
  BYOK_PROVIDER_UNAVAILABLE_MESSAGE,
  MANAGED_KEY_PROVIDER_OCCUPIED_MESSAGE,
  MANAGED_KEY_READ_ONLY_MESSAGE,
} from '@kilocode/app-shared/byok-errors';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import {
  ByokRoutingPreviewSchema,
  previewByokRouting,
} from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';
import { byok_api_keys, MODELS_BY_PROVIDER_ADMIN_URL } from '@kilocode/db/schema';
import { and, eq, ne, sql } from 'drizzle-orm';
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
  CreateByokEndpointInputSchema,
  UpdateByokEndpointInputSchema,
  ListByokEndpointModelsInputSchema,
  ListByokEndpointModelsResponseSchema,
  BYOKKeyTestResultSchema,
  type BYOKApiKeyResponse,
  type BYOKKeyTestResult,
} from '@/lib/byok/types';
import { isUniqueViolation } from '@/lib/db-errors';
import { sanitizeErrorForTelemetry } from '@/lib/sanitize-error-for-telemetry';
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
  getSystemOneModelIds,
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
  getByokKeyPriority,
  decryptByokRow,
  getByokKmsContext,
  getModelGatewayUserByokProviders,
  readByokEndpointDefinition,
  isGatewayUserByokEligibleModel,
  servesCatalogModels,
  type ByokOwner,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { encryptByokForStorage } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import { GatewayAuthenticationError, type GatewayProviderOptions } from '@ai-sdk/gateway';
import {
  getVercelModelIdOverrides,
  mapModelIdToVercel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import {
  findVercelOnlyModels,
  getVendorNamesByModelPrefix,
  getVercelOnlyModelName,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/find-vercel-only-models';
import { isAutoSmallFreeModel } from '@kilocode/web-shared/lib/ai-gateway/auto-small-free-model';
import type { NonChatVercelModelType } from '@kilocode/web-shared/lib/ai-gateway/providers/non-chat-routes';
import { getKiloEmbeddingModelCatalogFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/embeddings/openrouter-embedding-models';
import { getOpenRouterTranscriptionModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import DIRECT_BYOK_PROVIDERS from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/direct-byok-definitions';
import {
  createAiSdkProvider,
  directByokProviderForKey,
  findDirectByokProvider,
  formatDirectByokModelId,
  listDirectByokCatalogModels,
  offersCatalogMode,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { parseAwsBedrockCredentials } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/bedrock-byok';
import { parseGcpVertexCredentials } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/vertex-byok';
import { isByokEndpointsEnabled, isExperimentalByokEnabled } from '@/lib/byok/experimental-byok';
import { ADD_BYOK_PROVIDERS, getByokProviderDisplayName } from '@/lib/byok/provider-names';
import { sortByokKeysInRouteOrder } from '@kilocode/web-shared/lib/ai-gateway/byok/route-order';
import { OPENAI_CHATGPT_PROVIDER_ID } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/provider-id';
import {
  generateByokEndpointProviderId,
  isByokEndpointProviderId,
  parseByokEndpointCredentials,
} from '@kilocode/web-shared/lib/ai-gateway/byok-endpoint';
import { isByokServableCatalogModelId } from '@kilocode/web-shared/lib/ai-gateway/byok/servable-catalog-model';
import { BYOK_ENDPOINT_MAX_MODELS, type ByokEndpointCredentials } from '@kilocode/db/schema-types';
import {
  ByokEndpointRequestError,
  fetchByokEndpointModels,
  findByokEndpointBaseUrlViolation,
} from '@/lib/byok/endpoint-upstream';
import { testByokEndpoint } from '@/lib/byok/endpoint-test';
import { endpointOriginChanged } from '@/lib/byok/endpoint-origin';

const KEYS_CHANGED_MESSAGE = 'Your API keys changed. Reload the page and try again.';
const ENDPOINT_NOT_FOUND_MESSAGE = 'BYOK endpoint not found';
const ENDPOINT_CHANGED_MESSAGE = 'The endpoint changed; reload and try again';
const ENDPOINT_HOST_CHANGED_MESSAGE = 'Enter the credentials again to use a different host';
const ENDPOINT_CREDENTIALS_UNREADABLE_MESSAGE =
  'The stored endpoint credentials could not be read. Try again, or enter the credentials again.';
const logByokWarning = sentryLogger('byok-key-test', 'warning');
const logByokWriteWarning = sentryLogger('byok-key-write', 'warning');

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type BYOKKeyTestOutcome = DistributiveOmit<BYOKKeyTestResult, 'success' | 'message'>;

/**
 * `success` and `message` are legacy: installed app builds predate the outcome
 * union and read only these two fields, so they receive the sentence those
 * builds showed before the union existed. Remove the pair with the next
 * release train.
 */
function testResultWithLegacyCopy(
  result: BYOKKeyTestOutcome,
  context: { providerId?: string; finishReason?: string } = {}
): BYOKKeyTestResult {
  switch (result.outcome) {
    case 'ok':
      return {
        ...result,
        success: true,
        message: `API key test success. Provider: ${result.provider}. Model: ${result.model}.`,
      };
    case 'incomplete':
      return {
        ...result,
        success: false,
        message: `API key test failed: ${context.finishReason}`,
      };
    case 'unsupported-provider':
      return {
        ...result,
        success: false,
        message: `Provider ${context.providerId} is no longer supported.`,
      };
    case 'unreadable-key':
      return {
        ...result,
        success: false,
        message: 'API key test failed: the stored key could not be read. Try again later.',
      };
    case 'deprecated-provider':
      return {
        ...result,
        success: false,
        message: 'Codestral is deprecated and its API key can no longer be tested.',
      };
    case 'rejected':
      return {
        ...result,
        success: false,
        message:
          'API key test failed: Vercel AI Gateway rejected this API key. Check that the key is correct and has not been revoked.',
      };
    case 'failed':
      return {
        ...result,
        success: false,
        message: result.detail
          ? `API key test failed: ${result.detail}`
          : 'API key test failed. Check the credential and try again.',
      };
  }
}

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
      code: 'UNPROCESSABLE_CONTENT',
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
  organization_id: byok_api_keys.organization_id,
};

function inRouteOrder<T extends { provider_id: string; settings: unknown }>(keys: T[]): T[] {
  return sortByokKeysInRouteOrder(keys, key => ({
    providerId: key.provider_id,
    priority: getByokKeyPriority(key.settings),
  }));
}

function ownedKeys(owner: ByokOwner) {
  return eq(
    owner.type === 'organization' ? byok_api_keys.organization_id : byok_api_keys.kilo_user_id,
    owner.id
  );
}

async function writeKeyPriorities(
  tx: DrizzleTransaction,
  owner: ByokOwner,
  keyIds: readonly string[]
) {
  for (const [priority, id] of keyIds.entries()) {
    await tx
      .update(byok_api_keys)
      .set({ settings: sql`${byok_api_keys.settings} || ${JSON.stringify({ priority })}::jsonb` })
      .where(and(eq(byok_api_keys.id, id), ownedKeys(owner)));
  }
}

type BYOKKeyRow = Omit<
  BYOKApiKeyResponse,
  | 'provider_name'
  | 'serve_catalog_models'
  | 'supports_catalog_mode'
  | 'can_change_catalog_mode'
  | 'is_endpoint'
  | 'endpoint'
> & { settings: unknown; organization_id: string | null };

/**
 * Catalog mode decides whether organization model and provider policies apply to the key, so on organization
 * keys only the roles that edit those policies may change it.
 */
function canChangeCatalogMode(organizationRole: OrganizationRole | null) {
  return organizationRole === null || canManageOrganization(organizationRole);
}

/** The endpoint definition names the organization's upstream, so only the roles that manage keys see it. */
function canReadEndpointDefinition(organizationRole: OrganizationRole | null) {
  return (
    organizationRole === null ||
    (ORGANIZATION_BILLING_ROLES as OrganizationRole[]).includes(organizationRole)
  );
}

async function supportsCatalogMode(providerId: string) {
  if (isByokEndpointProviderId(providerId)) return true;
  const provider = findDirectByokProvider(providerId);
  return provider !== undefined && offersCatalogMode(provider);
}

async function toBYOKApiKeyResponse(
  { settings, organization_id, ...key }: BYOKKeyRow,
  organizationRole: OrganizationRole | null
): Promise<BYOKApiKeyResponse> {
  const isEndpoint = isByokEndpointProviderId(key.provider_id);
  // A stored definition that no longer parses is listed without it, so the rest of the list still loads.
  const definition = readByokEndpointDefinition({
    provider_id: key.provider_id,
    organization_id,
    settings,
  });
  const supportsCatalog = await supportsCatalogMode(key.provider_id);
  const serveCatalogModels = servesCatalogModels(settings);
  return {
    ...key,
    provider_name: definition?.name ?? getByokProviderDisplayName(key.provider_id),
    is_endpoint: isEndpoint,
    endpoint: definition && canReadEndpointDefinition(organizationRole) ? definition : null,
    serve_catalog_models: serveCatalogModels,
    supports_catalog_mode: supportsCatalog,
    // An enabled key can always leave catalog mode, even after its provider loses its mappings.
    can_change_catalog_mode:
      (supportsCatalog || serveCatalogModels) &&
      key.management_source === 'user' &&
      canChangeCatalogMode(organizationRole),
  };
}

async function rejectUnavailableExperimentalProvider(
  providerId: string,
  organizationId: string | null | undefined
) {
  if (
    isExperimentalByokProviderId(providerId) &&
    !(await isExperimentalByokEnabled(organizationId))
  ) {
    logByokWriteWarning('BYOK key write refused: provider is not available for this account', {
      providerId,
      organizationId: organizationId ?? null,
    });
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: BYOK_PROVIDER_UNAVAILABLE_MESSAGE,
    });
  }
}

async function rejectUnavailableEndpoints(organizationId: string) {
  if (!(await isByokEndpointsEnabled(organizationId))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'BYOK endpoints are not available yet.',
    });
  }
}

async function rejectDisallowedEndpointUrl(baseUrl: string) {
  const violation = await findByokEndpointBaseUrlViolation(baseUrl);
  if (violation) throw new TRPCError({ code: 'BAD_REQUEST', message: violation });
}

/** The organization's endpoint key `id`, or NOT_FOUND for any other key. */
async function findOrganizationEndpointKey(organizationId: string, id: string) {
  const [key] = await db
    .select({
      id: byok_api_keys.id,
      organization_id: byok_api_keys.organization_id,
      kilo_user_id: byok_api_keys.kilo_user_id,
      provider_id: byok_api_keys.provider_id,
      encrypted_api_key_envelope: byok_api_keys.encrypted_api_key_envelope,
      management_source: byok_api_keys.management_source,
      settings: byok_api_keys.settings,
    })
    .from(byok_api_keys)
    .where(and(eq(byok_api_keys.id, id), eq(byok_api_keys.organization_id, organizationId)));
  if (!key || !isByokEndpointProviderId(key.provider_id)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: ENDPOINT_NOT_FOUND_MESSAGE });
  }
  return key;
}

/**
 * Stored credentials may only be sent to the host they were saved for. Returns the stored base
 * URL, which a write that keeps the credentials must still find in place.
 */
function rejectEndpointHostChange(
  key: Parameters<typeof readByokEndpointDefinition>[0],
  baseUrl: string
): string {
  const stored = readByokEndpointDefinition(key);
  if (!stored || endpointOriginChanged(stored.base_url, baseUrl)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: ENDPOINT_HOST_CHANGED_MESSAGE });
  }
  return stored.base_url;
}

async function decryptEndpointCredentials(
  row: Parameters<typeof decryptByokRow>[0]
): Promise<ByokEndpointCredentials | null> {
  try {
    return parseByokEndpointCredentials((await decryptByokRow(row)).decryptedAPIKey);
  } catch (e) {
    logByokWarning('Could not decrypt BYOK endpoint credentials', {
      providerId: row.provider_id,
      message: e instanceof Error ? e.message : undefined,
    });
    return null;
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
    const entries = await listDirectByokCatalogModels(provider);
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
      'No Vercel model metadata in the database, refresh the metadata cache in the admin panel at ' +
        MODELS_BY_PROVIDER_ADMIN_URL
    );
  }

  if (Object.keys(openRouterModelMetadata).length === 0) {
    throw new Error(
      'No OpenRouter model metadata in the database, refresh the metadata cache in the admin panel at ' +
        MODELS_BY_PROVIDER_ADMIN_URL
    );
  }

  const result: Record<string, string[]> = {};

  result['codestral'] = ['Codestral (mistralai/codestral-2508)'];

  const addSupportedModel = (providerId: string, model: { id: string; name: string }) => {
    if (!result[providerId]) result[providerId] = [];
    result[providerId].push(model.name + ' (' + model.id + ')');
  };

  const addGatewayModel = async (model: { id: string; name: string }) => {
    for (const providerId of await getModelGatewayUserByokProviders(model.id)) {
      addSupportedModel(providerId, model);
    }
    const vercelModel = vercelModelMetadata[await mapModelIdToVercel(model.id)];
    if (vercelModel?.type !== 'language') return;
    for (const endpoint of vercelModel.endpoints) {
      const providerId = getVercelUserByokProviderIdForEndpoint(
        endpoint.provider_name ?? endpoint.tag
      );
      if (!providerId) continue;
      addSupportedModel(providerId, model);
    }
  };

  // System One models are listed with their label below.
  const systemOneModelIds = new Set(getSystemOneModelIds(openRouterModelMetadata));
  const openRouterModels = Object.values(openRouterModelMetadata);
  for (const openRouterModel of openRouterModels) {
    if (isAutoSmallFreeModel(openRouterModel.id) || systemOneModelIds.has(openRouterModel.id)) {
      continue;
    }
    await addGatewayModel(openRouterModel);
  }

  const vendorNames = getVendorNamesByModelPrefix(openRouterModels);
  const vercelOnlyModels = findVercelOnlyModels({
    openRouterModelIds: Object.keys(openRouterModelMetadata),
    openRouterModels,
    vercelMetadata: vercelModelMetadata,
    overrides: await getVercelModelIdOverrides(),
  });
  for (const vercelOnlyModel of vercelOnlyModels) {
    await addGatewayModel({
      id: vercelOnlyModel.id,
      name: getVercelOnlyModelName(vercelOnlyModel, vendorNames),
    });
  }

  // Embeddings and System One use the OpenRouter key, the Vercel AI Gateway key, and provider keys
  // sent through Vercel, but only for OpenRouter catalog ids Vercel serves under the mapped id.
  // Direct BYOK keys never serve them. Transcriptions use only the OpenRouter key.
  const addNonChatModel = async (
    model: { id: string; name: string },
    endpoint: { label: string; vercelType?: NonChatVercelModelType }
  ) => {
    if (!isGatewayUserByokEligibleModel(model.id)) return;
    const labelled = { id: model.id, name: `${model.name}, ${endpoint.label}` };
    addSupportedModel('openrouter', labelled);
    if (!endpoint.vercelType) return;
    const vercelModel = vercelModelMetadata[await mapModelIdToVercel(model.id)];
    if (vercelModel?.type !== endpoint.vercelType) return;
    addSupportedModel('vercel-ai-gateway', labelled);
    for (const vercelEndpoint of vercelModel.endpoints) {
      const providerId = getVercelUserByokProviderIdForEndpoint(
        vercelEndpoint.provider_name ?? vercelEndpoint.tag
      );
      if (providerId) addSupportedModel(providerId, labelled);
    }
  };
  for (const modelId of systemOneModelIds) {
    if (modelId.startsWith('~')) continue;
    const model = openRouterModelMetadata[modelId];
    await addNonChatModel(
      { id: modelId, name: model?.name ?? modelId },
      { label: 'System One', vercelType: 'evaluation' }
    );
  }
  for (const model of (await getKiloEmbeddingModelCatalogFromDatabase())?.models ?? []) {
    await addNonChatModel(model, { label: 'embeddings', vercelType: 'embedding' });
  }
  const transcriptionModels = await getOpenRouterTranscriptionModels().catch(() => null);
  for (const model of transcriptionModels?.data ?? []) {
    await addNonChatModel(model, { label: 'transcription' });
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

  /** Whether BYOK endpoints can be added. */
  byokEndpointsEnabled: baseProcedure
    .input(ListBYOKKeysInputSchema)
    .output(z.boolean())
    .query(async ({ input, ctx }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      return isByokEndpointsEnabled(input.organizationId);
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
      return Promise.all(
        inRouteOrder(keys).map(key => toBYOKApiKeyResponse(key, organizationRole))
      );
    }),

  /**
   * The providers a key can be added for, in the add form's order. Resolved on
   * the server so every client offers the same list and validation: the mobile
   * picker and the web select read this one query instead of each carrying a
   * copy of the provider table.
   */
  listProviders: baseProcedure
    .input(ListBYOKKeysInputSchema)
    .output(z.array(z.object({ id: UserByokProviderIdSchema, name: z.string() })))
    .query(async ({ input, ctx }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const experimentalByokEnabled = await isExperimentalByokEnabled(input.organizationId);
      return ADD_BYOK_PROVIDERS.filter(
        provider => experimentalByokEnabled || !isExperimentalByokProviderId(provider.id)
      );
    }),

  /**
   * Sets the priority of every scoped key: each request uses the first key in this order that can
   * serve it. The ChatGPT connection is not a listed key and keeps its own step.
   */
  reorder: baseProcedure
    .input(ReorderBYOKKeysInputSchema)
    .output(z.array(BYOKApiKeyResponseSchema))
    .mutation(async ({ input, ctx }): Promise<BYOKApiKeyResponse[]> => {
      const { organizationId } = input;
      const organizationRole = organizationId
        ? await ensureOrganizationAccess(ctx, organizationId, ORGANIZATION_MANAGE_ROLES)
        : null;
      const owner = byokOwner(ctx.user.id, organizationId);
      const keys = await db.transaction(async tx => {
        const owned = await tx
          .select({ id: byok_api_keys.id })
          .from(byok_api_keys)
          .where(and(ownedKeys(owner), ne(byok_api_keys.provider_id, OPENAI_CHATGPT_PROVIDER_ID)))
          .for('update');
        const ownedIds = new Set(owned.map(key => key.id));
        if (owned.length !== input.keyIds.length || input.keyIds.some(id => !ownedIds.has(id))) {
          throw new TRPCError({ code: 'CONFLICT', message: KEYS_CHANGED_MESSAGE });
        }
        await writeKeyPriorities(tx, owner, input.keyIds);
        if (organizationId) {
          await createAuditLog({
            action: 'organization.settings.change',
            actor_email: ctx.user.google_user_email,
            actor_id: ctx.user.id,
            actor_name: ctx.user.google_user_name,
            message: 'Updated BYOK key priorities',
            organization_id: organizationId,
            tx,
          });
        }
        return tx
          .select(BYOK_KEY_COLUMNS)
          .from(byok_api_keys)
          .where(ownedKeys(owner))
          .orderBy(...BYOK_KEY_ORDER);
      });
      return Promise.all(
        inRouteOrder(keys).map(key => toBYOKApiKeyResponse(key, organizationRole))
      );
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

      if (isByokEndpointProviderId(provider_id)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Endpoints are added with createEndpoint.',
        });
      }
      await rejectUnavailableExperimentalProvider(provider_id, organizationId);
      validateUserByokCredential(provider_id, api_key);

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
      let newKey: BYOKKeyRow;
      try {
        [newKey] = await db
          .insert(byok_api_keys)
          .values({
            id: keyId,
            organization_id: organizationId ?? null,
            kilo_user_id: organizationId ? null : ctx.user.id,
            provider_id,
            encrypted_api_key_envelope: envelope,
            created_by: ctx.user.id,
          })
          .returning(BYOK_KEY_COLUMNS);
      } catch (error) {
        // A second key for the same owner and provider violates the unique
        // constraint. The driver error carries the SQL, its parameters and the
        // envelope, so neither it nor its message may reach the client.
        if (isUniqueViolation(error)) {
          // A coding-plan row owns the provider for this owner, so the refusal
          // names the plan instead of asking for a removal the owner cannot do.
          // This lookup can fail on its own, and a failure here would put the
          // driver's message on the wire, so it answers the generic sentence.
          let existingKey: { management_source: string } | undefined;
          try {
            [existingKey] = await db
              .select({ management_source: byok_api_keys.management_source })
              .from(byok_api_keys)
              .where(
                and(
                  ownedKeys(byokOwner(ctx.user.id, organizationId)),
                  eq(byok_api_keys.provider_id, provider_id)
                )
              );
          } catch (lookupError) {
            logByokWriteWarning('BYOK key conflict lookup failed', {
              providerId: provider_id,
              message: sanitizeErrorForTelemetry(lookupError).message,
            });
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'The key could not be stored. Try again.',
            });
          }
          if (existingKey?.management_source === 'coding_plan') {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: MANAGED_KEY_PROVIDER_OCCUPIED_MESSAGE,
            });
          }
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'A key for this provider already exists. Remove it before you add another.',
          });
        }
        logByokWriteWarning('BYOK key create failed', {
          providerId: provider_id,
          message: sanitizeErrorForTelemetry(error).message,
        });
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'The key could not be stored. Try again.',
        });
      }

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
      if (isByokEndpointProviderId(existingKey.provider_id)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Endpoints are updated with updateEndpoint.',
        });
      }
      await rejectUnavailableExperimentalProvider(
        existingKey.provider_id,
        existingKey.organization_id
      );
      validateUserByokCredential(existingKey.provider_id, api_key);

      const envelope = await encryptByokForStorage({
        apiKey: api_key,
        context: getByokKmsContext(existingKey),
        actorUserId: ctx.user.id,
      });
      // The update never writes the owner or provider columns, so neither unique
      // (owner, provider) constraint can fire here and there is no conflict
      // branch. Any other driver error must not reach the client with its SQL
      // or parameters.
      let updatedKey: BYOKKeyRow;
      try {
        [updatedKey] = await db
          .update(byok_api_keys)
          .set({ encrypted_api_key_envelope: envelope })
          .where(eq(byok_api_keys.id, id))
          .returning(BYOK_KEY_COLUMNS);
      } catch (error) {
        logByokWriteWarning('BYOK key update failed', {
          providerId: existingKey.provider_id,
          message: sanitizeErrorForTelemetry(error).message,
        });
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'The key could not be saved. Try again.',
        });
      }

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
      if (serve_catalog_models && !(await supportsCatalogMode(existingKey.provider_id))) {
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
    .output(BYOKKeyTestResultSchema)
    .mutation(async ({ input, ctx }): Promise<BYOKKeyTestResult> => {
      const { organizationId, id, modelId } = input;

      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ORGANIZATION_BILLING_ROLES);
      }

      const [existingKey] = await db
        .select({
          id: byok_api_keys.id,
          organization_id: byok_api_keys.organization_id,
          kilo_user_id: byok_api_keys.kilo_user_id,
          provider_id: byok_api_keys.provider_id,
          encrypted_api_key_envelope: byok_api_keys.encrypted_api_key_envelope,
          management_source: byok_api_keys.management_source,
          settings: byok_api_keys.settings,
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
        return testResultWithLegacyCopy(
          { outcome: 'unsupported-provider' },
          { providerId: existingKey.provider_id }
        );
      }

      let decryptedKey: Awaited<ReturnType<typeof decryptByokRow>>;
      try {
        decryptedKey = await decryptByokRow(existingKey);
      } catch (e) {
        logByokWarning('BYOK key test could not decrypt the stored key', {
          providerId: existingKey.provider_id,
          message: e instanceof Error ? e.message : undefined,
        });
        return testResultWithLegacyCopy({ outcome: 'unreadable-key' });
      }

      if (isByokEndpointProviderId(existingKey.provider_id)) {
        const endpoint = readByokEndpointDefinition(existingKey) ?? undefined;
        const provider = directByokProviderForKey({ providerId: providerId.data, endpoint });
        if (!provider || !existingKey.organization_id) {
          return testResultWithLegacyCopy({
            outcome: 'failed',
            detail: 'the stored endpoint configuration is invalid.',
          });
        }
        try {
          return testResultWithLegacyCopy(
            await testByokEndpoint({
              provider,
              credential: decryptedKey.decryptedAPIKey,
              modelId,
              userId: ctx.user.id,
              organizationId: existingKey.organization_id,
            })
          );
        } catch (e) {
          logByokWarning('BYOK endpoint test request failed', {
            providerId: existingKey.provider_id,
            message: e instanceof Error ? e.message : undefined,
          });
          return testResultWithLegacyCopy({ outcome: 'failed' });
        }
      }

      // Codestral is deprecated and its key only authenticates against codestral.mistral.ai,
      // which the gateway test path below cannot reach (it routes codestral to api.mistral.ai).
      // Decline to test it rather than returning a misleading failure for a still-valid key.
      if (decryptedKey.providerId === 'codestral') {
        return testResultWithLegacyCopy({ outcome: 'deprecated-provider' });
      }

      async function setup() {
        const provider = UserByokProviderIdSchema.parse(decryptedKey.providerId);
        if (isByokEndpointProviderId(provider)) throw new Error('Endpoint keys are tested above');
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
          return testResultWithLegacyCopy(
            { outcome: 'incomplete' },
            { finishReason: output.finishReason }
          );
        }

        const metadata = output.providerMetadata?.gateway?.routing as
          | { originalModelId?: string; finalProvider?: string }
          | undefined;

        const testedProvider = metadata?.finalProvider ?? finalProvider;
        const testedModel = metadata?.originalModelId ?? model.modelId;

        return testResultWithLegacyCopy({
          outcome: 'ok',
          provider: testedProvider,
          model: testedModel,
        });
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
          return testResultWithLegacyCopy({ outcome: 'rejected' });
        }
        return testResultWithLegacyCopy(
          message ? { outcome: 'failed', detail: message } : { outcome: 'failed' }
        );
      }
    }),

  /**
   * Which of the given endpoint model ids a catalog-mode endpoint would serve, that is, which are
   * live Kilo catalog ids that the endpoint may take over.
   */
  listEndpointCatalogModelIds: baseProcedure
    .input(
      z.object({
        organizationId: z.string(),
        modelIds: z.array(z.string().max(200)).max(BYOK_ENDPOINT_MAX_MODELS * 10),
      })
    )
    .output(z.array(z.string()))
    .query(async ({ input, ctx }) => {
      await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_BILLING_ROLES);
      const modelIds = [...new Set(input.modelIds)];
      const served = await Promise.all(modelIds.map(isByokServableCatalogModelId));
      return modelIds.filter((_, index) => served[index]);
    }),

  /** Adds an organization's own endpoint as a BYOK key. */
  createEndpoint: baseProcedure
    .input(CreateByokEndpointInputSchema)
    .output(BYOKApiKeyResponseSchema)
    .mutation(async ({ input, ctx }): Promise<BYOKApiKeyResponse> => {
      const { organizationId, definition, credentials } = input;
      const organizationRole = await ensureOrganizationAccess(
        ctx,
        organizationId,
        ORGANIZATION_BILLING_ROLES
      );
      await rejectUnavailableEndpoints(organizationId);
      await rejectDisallowedEndpointUrl(definition.base_url);

      const keyId = crypto.randomUUID();
      const providerId = generateByokEndpointProviderId();
      const envelope = await encryptByokForStorage({
        apiKey: JSON.stringify(credentials),
        context: {
          key_id: keyId,
          owner_type: 'organization',
          owner_id: organizationId,
          provider_id: providerId,
        },
        actorUserId: ctx.user.id,
      });

      const [newKey] = await db
        .insert(byok_api_keys)
        .values({
          id: keyId,
          organization_id: organizationId,
          provider_id: providerId,
          encrypted_api_key_envelope: envelope,
          settings: { endpoint: definition },
          created_by: ctx.user.id,
        })
        .returning(BYOK_KEY_COLUMNS);

      await createAuditLog({
        action: 'organization.settings.change',
        actor_email: ctx.user.google_user_email,
        actor_id: ctx.user.id,
        actor_name: ctx.user.google_user_name,
        message: `Added BYOK endpoint ${definition.name} (${providerId})`,
        organization_id: organizationId,
      });

      return toBYOKApiKeyResponse(newKey, organizationRole);
    }),

  /** Replaces an endpoint's definition, and its credentials when given. */
  updateEndpoint: baseProcedure
    .input(UpdateByokEndpointInputSchema)
    .output(BYOKApiKeyResponseSchema)
    .mutation(async ({ input, ctx }): Promise<BYOKApiKeyResponse> => {
      const { organizationId, id, definition, credentials } = input;
      const organizationRole = await ensureOrganizationAccess(
        ctx,
        organizationId,
        ORGANIZATION_BILLING_ROLES
      );
      await rejectUnavailableEndpoints(organizationId);
      const existingKey = await findOrganizationEndpointKey(organizationId, id);
      rejectManagedKeyMutation(existingKey.management_source);
      const checkedBaseUrl = credentials
        ? undefined
        : rejectEndpointHostChange(existingKey, definition.base_url);
      await rejectDisallowedEndpointUrl(definition.base_url);

      const envelope = credentials
        ? await encryptByokForStorage({
            apiKey: JSON.stringify(credentials),
            context: getByokKmsContext(existingKey),
            actorUserId: ctx.user.id,
          })
        : undefined;
      const [updatedKey] = await db
        .update(byok_api_keys)
        .set({
          // Merged like the other settings writes, so priority and catalog mode stay.
          settings: sql`${byok_api_keys.settings} || ${JSON.stringify({ endpoint: definition })}::jsonb`,
          ...(envelope && { encrypted_api_key_envelope: envelope }),
        })
        .where(
          and(
            eq(byok_api_keys.id, id),
            eq(byok_api_keys.organization_id, organizationId),
            // The host check above read the stored base URL; without new credentials the write
            // is valid only while it is still there.
            checkedBaseUrl === undefined
              ? undefined
              : sql`${byok_api_keys.settings}->'endpoint'->>'base_url' = ${checkedBaseUrl}`
          )
        )
        .returning(BYOK_KEY_COLUMNS);
      if (!updatedKey) {
        throw new TRPCError(
          checkedBaseUrl === undefined
            ? { code: 'NOT_FOUND', message: ENDPOINT_NOT_FOUND_MESSAGE }
            : { code: 'CONFLICT', message: ENDPOINT_CHANGED_MESSAGE }
        );
      }

      await createAuditLog({
        action: 'organization.settings.change',
        actor_email: ctx.user.google_user_email,
        actor_id: ctx.user.id,
        actor_name: ctx.user.google_user_name,
        message: `Updated BYOK endpoint ${definition.name} (${existingKey.provider_id})${credentials ? ' and its credentials' : ''}`,
        organization_id: organizationId,
      });

      return toBYOKApiKeyResponse(updatedKey, organizationRole);
    }),

  /**
   * The models an endpoint lists at `GET <base_url>/models`, ready to add to its definition. Uses
   * the given credentials, or the stored credentials of endpoint key `id`.
   */
  listModelsFromEndpoint: baseProcedure
    .input(ListByokEndpointModelsInputSchema)
    .output(ListByokEndpointModelsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, base_url, id } = input;
      await ensureOrganizationAccess(ctx, organizationId, ORGANIZATION_BILLING_ROLES);
      await rejectUnavailableEndpoints(organizationId);

      let credentials = input.credentials;
      if (!credentials && id) {
        const key = await findOrganizationEndpointKey(organizationId, id);
        rejectEndpointHostChange(key, base_url);
        const stored = await decryptEndpointCredentials(key);
        if (!stored) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: ENDPOINT_CREDENTIALS_UNREADABLE_MESSAGE,
          });
        }
        credentials = stored;
      }
      if (!credentials) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enter credentials to import models' });
      }

      try {
        return { models: await fetchByokEndpointModels({ baseUrl: base_url, credentials }) };
      } catch (e) {
        if (e instanceof ByokEndpointRequestError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
        }
        logByokWarning('BYOK endpoint model import failed', {
          message: e instanceof Error ? e.message : undefined,
        });
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The endpoint models could not be imported. Check the URL and credentials.',
        });
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
