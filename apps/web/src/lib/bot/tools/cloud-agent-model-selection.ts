import { listAvailableCustomLlms } from '@/lib/ai-gateway/custom-llm/listAvailableCustomLlms';
import { isFreeModel } from '@/lib/ai-gateway/models';
import {
  getDirectByokModelsForOrganization,
  getDirectByokModelsForUser,
} from '@/lib/ai-gateway/providers/direct-byok';
import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import type { Owner } from '@/lib/integrations/core/types';
import {
  createAllowPredicateFromDenyList,
  type ProviderAwareAllowPredicate,
} from '@/lib/model-allow.server';
import { getEffectiveModelRestrictions } from '@/lib/organizations/model-restrictions';
import { getOrganizationById } from '@/lib/organizations/organizations';
import z from 'zod';

export type SelectableCloudAgentModel = {
  id: string;
  name: string;
  provider?: string;
  created?: number;
  isFree?: boolean;
  preferredIndex?: number;
  contextLength?: number;
};

type CatalogSourceModel = {
  id: string;
  name: string;
  created?: number;
  isFree?: boolean;
  preferredIndex?: number;
  context_length?: number | null;
  top_provider?: {
    context_length?: number | null;
  };
};

export const modelSelectionSchema = z.object({
  selectedModelId: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string().max(500),
  alternatives: z.array(z.string()).max(5).default([]),
});

export type CloudAgentModelSelection = z.infer<typeof modelSelectionSchema>;

export type SelectCloudAgentModel = (input: {
  modelRequest: string;
  prompt: string;
  catalog: SelectableCloudAgentModel[];
}) => Promise<CloudAgentModelSelection>;

type ModelPolicy = {
  isAllowed: ProviderAwareAllowPredicate;
};

export type CloudAgentModelCatalogDeps = {
  getBaseModels?: () => Promise<CatalogSourceModel[]>;
  getOrganizationByokModels?: (organizationId: string) => Promise<CatalogSourceModel[]>;
  getUserByokModels?: (userId: string) => Promise<CatalogSourceModel[]>;
  getOrganizationCustomModels?: (organizationId: string) => Promise<CatalogSourceModel[]>;
  getOrganizationModelPolicy?: (organizationId: string) => Promise<ModelPolicy | undefined>;
};

export type ResolveCloudAgentModelInput = {
  modelRequest: string | undefined;
  defaultModel: string;
  prompt: string;
  owner: Owner;
};

export type ResolveCloudAgentModelResult =
  | { ok: true; model: string }
  | { ok: false; response: string };

const alwaysAllowed: ProviderAwareAllowPredicate = async () => true;

async function getDefaultBaseModels(): Promise<CatalogSourceModel[]> {
  const response = await getEnhancedOpenRouterModels();
  return response.data;
}

async function getDefaultOrganizationModelPolicy(
  organizationId: string
): Promise<ModelPolicy | undefined> {
  const organization = await getOrganizationById(organizationId);
  if (!organization) {
    return undefined;
  }

  const { modelDenyList, providerDenyList } = getEffectiveModelRestrictions(organization);
  if (modelDenyList.length === 0 && providerDenyList.length === 0) {
    return undefined;
  }

  return { isAllowed: createAllowPredicateFromDenyList(modelDenyList, providerDenyList) };
}

function getProviderFromModelId(modelId: string): string | undefined {
  const separatorIndex = modelId.indexOf('/');
  if (separatorIndex <= 0) {
    return undefined;
  }
  return modelId.slice(0, separatorIndex);
}

function toSelectableModel(model: CatalogSourceModel): SelectableCloudAgentModel | null {
  if (!model.id || !model.name) {
    return null;
  }

  const contextLength = model.context_length ?? model.top_provider?.context_length ?? undefined;
  return {
    id: model.id,
    name: model.name,
    provider: getProviderFromModelId(model.id),
    created: model.created,
    isFree: model.isFree ?? isFreeModel(model.id),
    preferredIndex: model.preferredIndex,
    contextLength: contextLength ?? undefined,
  };
}

async function filterAllowedModels(
  models: SelectableCloudAgentModel[],
  isAllowed: ProviderAwareAllowPredicate
): Promise<SelectableCloudAgentModel[]> {
  const allowedModels: SelectableCloudAgentModel[] = [];
  for (const model of models) {
    if (await isAllowed(model.id)) {
      allowedModels.push(model);
    }
  }
  return allowedModels;
}

function dedupeModels(models: SelectableCloudAgentModel[]): SelectableCloudAgentModel[] {
  const byId = new Map<string, SelectableCloudAgentModel>();
  for (const model of models) {
    if (!byId.has(model.id)) {
      byId.set(model.id, model);
    }
  }
  return [...byId.values()];
}

export async function buildSelectableCloudAgentModelCatalog(
  owner: Owner,
  deps: CloudAgentModelCatalogDeps = {}
): Promise<SelectableCloudAgentModel[]> {
  const getBaseModels = deps.getBaseModels ?? getDefaultBaseModels;
  const getOrganizationByokModels =
    deps.getOrganizationByokModels ?? getDirectByokModelsForOrganization;
  const getUserByokModels = deps.getUserByokModels ?? getDirectByokModelsForUser;
  const getOrganizationCustomModels = deps.getOrganizationCustomModels ?? listAvailableCustomLlms;
  const getOrganizationModelPolicy =
    deps.getOrganizationModelPolicy ?? getDefaultOrganizationModelPolicy;

  const baseModels = await getBaseModels();
  const ownerModels =
    owner.type === 'org'
      ? [
          ...(await getOrganizationByokModels(owner.id)),
          ...(await getOrganizationCustomModels(owner.id)),
        ]
      : await getUserByokModels(owner.id);

  const selectableModels = dedupeModels(
    [...baseModels, ...ownerModels].map(toSelectableModel).filter(model => model !== null)
  );

  const policy = owner.type === 'org' ? await getOrganizationModelPolicy(owner.id) : undefined;
  return filterAllowedModels(selectableModels, policy?.isAllowed ?? alwaysAllowed);
}

function formatModelList(modelIds: string[]): string {
  if (modelIds.length === 0) {
    return 'No close alternatives were found.';
  }
  return `Available alternatives: ${modelIds.map(id => `\`${id}\``).join(', ')}.`;
}

function scoreModelForRequest(model: SelectableCloudAgentModel, request: string): number {
  const searchable = `${model.id} ${model.name}`.toLowerCase();
  const normalizedRequest = request.toLowerCase();
  const tokens = normalizedRequest.split(/[^a-z0-9.-]+/).filter(token => token.length >= 2);

  let score = 0;
  if (searchable.includes(normalizedRequest)) {
    score += 10;
  }

  for (const token of tokens) {
    if (searchable.includes(token)) {
      score += 1;
    }
  }

  if (model.preferredIndex !== undefined) {
    score += Math.max(0, 5 - model.preferredIndex / 10);
  }

  return score;
}

const catalogMatchStopWords = new Set([
  'a',
  'an',
  'and',
  'best',
  'for',
  'latest',
  'model',
  'newest',
  'of',
  'the',
  'to',
  'use',
  'using',
  'version',
  'with',
]);

function getCatalogMatchTerms(request: string): string[] {
  return request
    .toLowerCase()
    .split(/[^a-z0-9.-]+/)
    .filter(token => token.length >= 2 && !catalogMatchStopWords.has(token));
}

function getVersionParts(model: SelectableCloudAgentModel): number[] {
  const matches = `${model.id} ${model.name}`.match(/\d+(?:\.\d+)*/g) ?? [];
  return (
    matches
      .map(match => match.split('.').map(part => Number(part)))
      .sort(compareVersionParts)
      .at(-1) ?? []
  );
}

function compareVersionParts(a: number[], b: number[]): number {
  const maxLength = Math.max(a.length, b.length);
  for (let index = 0; index < maxLength; index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function compareCatalogMatches(a: SelectableCloudAgentModel, b: SelectableCloudAgentModel): number {
  if (a.preferredIndex !== undefined && b.preferredIndex !== undefined) {
    return a.preferredIndex - b.preferredIndex;
  }
  if (a.preferredIndex !== undefined) {
    return -1;
  }
  if (b.preferredIndex !== undefined) {
    return 1;
  }

  const createdDiff = (b.created ?? 0) - (a.created ?? 0);
  if (createdDiff !== 0) {
    return createdDiff;
  }

  return compareVersionParts(getVersionParts(b), getVersionParts(a));
}

function findDirectCatalogMatch(
  request: string,
  catalog: SelectableCloudAgentModel[]
): SelectableCloudAgentModel | undefined {
  const terms = getCatalogMatchTerms(request);
  if (terms.length === 0 || terms.length > 3) {
    return undefined;
  }

  const matches = catalog.filter(model => {
    const searchable = `${model.id} ${model.name}`.toLowerCase();
    return terms.every(term => searchable.includes(term));
  });

  if (matches.length === 0) {
    return undefined;
  }

  return [...matches].sort(compareCatalogMatches)[0];
}

function findModelSuggestions(
  request: string,
  catalog: SelectableCloudAgentModel[],
  alternatives: string[] = []
): string[] {
  const catalogIds = new Set(catalog.map(model => model.id));
  const validAlternatives = alternatives.filter(id => catalogIds.has(id));
  const scored = catalog
    .map(model => ({ model, score: scoreModelForRequest(model, request) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.model.id);

  return [...new Set([...validAlternatives, ...scored, ...catalog.map(model => model.id)])].slice(
    0,
    5
  );
}

export function buildCloudAgentModelSelectionPrompt(input: {
  modelRequest: string;
  prompt: string;
  catalog: SelectableCloudAgentModel[];
}): string {
  const catalogJson = JSON.stringify(input.catalog);
  return `Choose the best exact Cloud Agent model ID for the user's request.

Rules:
- Return selectedModelId as one exact id from the catalog, or null if there is no good match.
- Do not invent model ids or aliases.
- Prefer current, high-quality coding models when the request asks for quality or coding ability.
- Prefer free or low-cost models only when the request explicitly asks for cheap, low-cost, or free.
- Prefer faster/smaller models only when the request asks for fast, quick, small, or lightweight.
- Use high confidence only when the request clearly maps to one catalog entry.
- Use medium confidence when there are several reasonable matches but one is clearly best.
- Use low confidence with selectedModelId null when the request is ambiguous or unavailable.

Model request: ${input.modelRequest}

User task for context:
${input.prompt}

Catalog JSON:
${catalogJson}`;
}

export async function resolveCloudAgentModel(
  input: ResolveCloudAgentModelInput & {
    selectModel: SelectCloudAgentModel;
    catalogDeps?: CloudAgentModelCatalogDeps;
  }
): Promise<ResolveCloudAgentModelResult> {
  const modelRequest = input.modelRequest?.trim();
  if (!modelRequest) {
    return { ok: true, model: input.defaultModel };
  }

  const catalog = await buildSelectableCloudAgentModelCatalog(input.owner, input.catalogDeps);
  const catalogIds = new Set(catalog.map(model => model.id));

  if (catalogIds.has(modelRequest)) {
    return { ok: true, model: modelRequest };
  }

  const directCatalogMatch = findDirectCatalogMatch(modelRequest, catalog);
  if (directCatalogMatch) {
    return { ok: true, model: directCatalogMatch.id };
  }

  if (modelRequest.includes('/')) {
    return {
      ok: false,
      response: `Error selecting Cloud Agent model: requested model \`${modelRequest}\` is not available for this integration. ${formatModelList(findModelSuggestions(modelRequest, catalog))}`,
    };
  }

  const selection = await input.selectModel({
    modelRequest,
    prompt: input.prompt,
    catalog,
  });

  if (!selection.selectedModelId || selection.confidence === 'low') {
    return {
      ok: false,
      response: `Error selecting Cloud Agent model: I could not confidently match \`${modelRequest}\` to an available model. ${formatModelList(findModelSuggestions(modelRequest, catalog, selection.alternatives))}`,
    };
  }

  if (!catalogIds.has(selection.selectedModelId)) {
    return {
      ok: false,
      response: `Error selecting Cloud Agent model: the selector chose unavailable model \`${selection.selectedModelId}\`. ${formatModelList(findModelSuggestions(modelRequest, catalog, selection.alternatives))}`,
    };
  }

  return { ok: true, model: selection.selectedModelId };
}
