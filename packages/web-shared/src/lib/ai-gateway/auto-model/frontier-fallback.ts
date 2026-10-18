import {
  isVirtualAutoModelId,
  detectRequiredInputModalities,
  estimateRoutingTokens,
  getReasoningVariantKeys,
  type FrontierFallbackEntry,
} from '@kilocode/auto-routing-contracts';
import {
  getFrontierFallback,
  initializeFrontierFallback,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client';
import {
  getEffectiveModelDecision,
  resolveOrganizationDefaultModelPolicy,
} from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import { getEnhancedOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { findKiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { getModelIdToProviderSlugsIndex } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import {
  CLAUDE_SONNET_CURRENT_MODEL_ID,
  CLAUDE_OPUS_CURRENT_MODEL_ID,
} from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic.constants';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { ResolvedAutoModel } from '@kilocode/web-shared/lib/ai-gateway/auto-model';

export async function getOwnerFrontierFallback(owner: {
  userId: string;
  organizationId: string | null;
}): Promise<FrontierFallbackEntry | null> {
  const settingsOwner = owner.organizationId
    ? { ownerType: 'org' as const, ownerId: owner.organizationId }
    : { ownerType: 'user' as const, ownerId: owner.userId };
  let result = await getFrontierFallback(settingsOwner).catch(() => null);
  if (result === null || result.status === 429 || result.status >= 500) {
    result = await getFrontierFallback(settingsOwner);
  }
  if (result.status !== 200 || !('configuredPool' in result.body)) {
    throw new Error(
      result.status === 404
        ? 'Frontier fallback settings are not deployed'
        : 'Frontier fallback settings are unavailable'
    );
  }
  if (result.body.frontierFallback !== undefined) return result.body.frontierFallback;

  const policy = owner.organizationId
    ? await resolveOrganizationDefaultModelPolicy({ organizationId: owner.organizationId })
    : null;
  const baselinePolicy = policy
    ? {
        ...policy,
        memberGrant: policy.requireModelInCurrentSnapshot
          ? { mode: 'organization_baseline' as const }
          : { mode: 'unrestricted' as const },
      }
    : null;
  if (
    baselinePolicy?.requireModelInCurrentSnapshot &&
    (await getModelIdToProviderSlugsIndex()).size === 0
  ) {
    throw new Error('Frontier fallback model policy snapshot is unavailable');
  }
  const catalog = await getEnhancedOpenRouterModels();
  const candidates = [CLAUDE_SONNET_CURRENT_MODEL_ID, CLAUDE_OPUS_CURRENT_MODEL_ID].flatMap(
    model => {
      const candidate = catalog.data.find(candidate => candidate.id === model);
      return candidate && getReasoningVariantKeys(candidate.opencode?.variants).includes('medium')
        ? [candidate]
        : [];
    }
  );
  if (candidates.length === 0) {
    throw new Error('Frontier fallback model catalog is unavailable');
  }
  let frontierFallback: FrontierFallbackEntry | null = null;
  for (const candidate of candidates) {
    const model = candidate.id;
    if (baselinePolicy && !(await getEffectiveModelDecision(baselinePolicy, model)).allowed) {
      continue;
    }
    frontierFallback = { model, variant: 'medium' };
    break;
  }
  const initialized = await initializeFrontierFallback({ ...settingsOwner, frontierFallback });
  if (
    initialized.status !== 200 ||
    !('configuredPool' in initialized.body) ||
    initialized.body.frontierFallback === undefined
  ) {
    throw new Error('Frontier fallback settings could not be initialized');
  }
  return initialized.body.frontierFallback;
}

function hasOnlyPdfFileInputs(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasOnlyPdfFileInputs);
  if (value === null || typeof value !== 'object') return true;
  const part = value as Record<string, unknown>;
  if (
    part.type === 'file' ||
    part.type === 'input_file' ||
    part.type === 'document' ||
    'input_file' in part
  ) {
    const nestedFile = part.file ?? part.input_file;
    const file =
      nestedFile !== null && typeof nestedFile === 'object'
        ? (nestedFile as Record<string, unknown>)
        : part;
    const source =
      file.source !== null && typeof file.source === 'object'
        ? (file.source as Record<string, unknown>)
        : file;
    const mediaType = source.media_type ?? file.mime_type;
    const data = file.file_data ?? source.data;
    const isPdf =
      typeof mediaType === 'string'
        ? mediaType.toLowerCase() === 'application/pdf'
        : typeof data === 'string' && /^data:application\/pdf(?:;|,)/i.test(data);
    if (!isPdf) return false;
  }
  return ['messages', 'input', 'content', 'parts', 'system'].every(key =>
    hasOnlyPdfFileInputs(part[key])
  );
}

export async function resolveEligibleFrontierFallback(
  entry: FrontierFallbackEntry,
  context: {
    apiKind: GatewayRequest['kind'] | null;
    body: unknown;
    isModelAllowed: (modelId: string) => Promise<boolean>;
  }
): Promise<ResolvedAutoModel | null> {
  if (isVirtualAutoModelId(entry.model) || !(await context.isModelAllowed(entry.model))) {
    return null;
  }
  const catalog = await getEnhancedOpenRouterModels();
  const model = catalog.data.find(model => model.id === entry.model);
  if (!model || !model.architecture.output_modalities.includes('text')) return null;
  const exclusive = findKiloExclusiveModel(entry.model);
  if (
    exclusive &&
    context.apiKind !== null &&
    !exclusive.provider.supportedChatApis.some(api => api === context.apiKind)
  ) {
    return null;
  }
  const modalities = new Set(
    model.architecture.input_modalities.map(modality =>
      modality === 'image_url' ? 'image' : modality
    )
  );
  if (
    detectRequiredInputModalities(context.body).some(
      modality =>
        !modalities.has(modality) &&
        !(modality === 'file' && modalities.has('pdf') && hasOnlyPdfFileInputs(context.body))
    )
  ) {
    return null;
  }
  const tokens = estimateRoutingTokens(context.body);
  if (tokens > 0 && (model.context_length <= 0 || tokens > model.context_length)) return null;
  const variants = model.opencode?.variants;
  const variantKeys = getReasoningVariantKeys(variants);
  if (entry.variant === null) {
    return variantKeys.length > 0 ? null : { model: entry.model };
  }
  const variant = variants?.[entry.variant];
  if (!variant || !variantKeys.includes(entry.variant)) return null;
  return {
    model: entry.model,
    ...(variant.reasoning ? { reasoning: { ...variant.reasoning } } : {}),
    ...(variant.verbosity ? { verbosity: variant.verbosity } : {}),
  };
}
