import * as z from 'zod';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import { parseCloudAgentCookie } from './cloud-agent-cookie';

/**
 * Catalog entries of the models this browser used on one account's Cloud Agent
 * routes. They are kept in a cookie, so the server renders a chat's model picker
 * final while the catalog loads.
 */
export type KnownModel = {
  id: string;
  name: string;
  variants: string[];
  mayTrainOnYourPrompts: boolean;
  contextLength?: number;
};

export type GatewayCatalog = {
  modelOptions: ModelOption[];
  isLoadingModels: boolean;
  contextLengthByModelId: ReadonlyMap<string, number>;
};

export const KNOWN_MODELS_COOKIE = 'cloud-agent-models';

const MAX_KNOWN_MODELS = 8;
const MAX_ENCODED_LENGTH = 1500;

const storedModelSchema = z.object({
  i: z.string().max(120),
  n: z.string().max(120),
  v: z.array(z.string().max(32)).max(12),
  t: z.literal(1).optional(),
  c: z.number().int().positive().optional(),
});
type StoredModel = z.infer<typeof storedModelSchema>;

const storedSchema = z.object({
  u: z.string(),
  m: z.array(storedModelSchema).max(MAX_KNOWN_MODELS),
});

function toStored(model: KnownModel): StoredModel {
  return {
    i: model.id,
    n: model.name,
    v: model.variants,
    ...(model.mayTrainOnYourPrompts ? { t: 1 as const } : {}),
    ...(model.contextLength ? { c: model.contextLength } : {}),
  };
}

export function toKnownModel(option: ModelOption, contextLength: number | undefined): KnownModel {
  return {
    id: option.id,
    name: option.name,
    variants: option.variants ?? [],
    mayTrainOnYourPrompts: option.mayTrainOnYourPrompts === true,
    ...(contextLength ? { contextLength } : {}),
  };
}

/** The stored models, or an empty list when the cookie is missing, malformed or another user's. */
export function parseKnownModels(value: string | undefined, userId: string): KnownModel[] {
  const stored = parseCloudAgentCookie(value, userId, storedSchema);
  return (stored?.m ?? []).map(model => ({
    id: model.i,
    name: model.n,
    variants: model.v,
    mayTrainOnYourPrompts: model.t === 1,
    ...(model.c ? { contextLength: model.c } : {}),
  }));
}

/** The encoded cookie value. When the models do not fit, the least recent are left out. */
export function encodeKnownModels(models: readonly KnownModel[], userId: string): string {
  let kept = models.slice(0, MAX_KNOWN_MODELS);
  const encode = () => encodeURIComponent(JSON.stringify({ u: userId, m: kept.map(toStored) }));
  let value = encode();
  while (value.length > MAX_ENCODED_LENGTH && kept.length > 0) {
    kept = kept.slice(0, -1);
    value = encode();
  }
  return value;
}

/**
 * The list with this model first. The same list comes back when the model is already
 * first and unchanged, or when it is too large to store.
 */
export function rememberKnownModel(
  models: readonly KnownModel[],
  model: KnownModel
): readonly KnownModel[] {
  const stored = toStored(model);
  if (models[0] && JSON.stringify(toStored(models[0])) === JSON.stringify(stored)) return models;
  if (!storedModelSchema.safeParse(stored).success) return models;
  return [model, ...models.filter(known => known.id !== model.id)].slice(0, MAX_KNOWN_MODELS);
}

/**
 * While the catalog loads, a known entry stands in for the selected model, so the
 * picker renders final. It is the only option until the catalog of the session's
 * organization arrives, so no model outside that organization's policy is offered.
 */
export function withKnownModel(
  catalog: GatewayCatalog,
  knownModels: readonly KnownModel[],
  selectedModelId: string | undefined
): GatewayCatalog {
  if (!catalog.isLoadingModels) return catalog;
  const known = knownModels.find(model => model.id === selectedModelId);
  if (!known) return catalog;
  return {
    modelOptions: [
      {
        id: known.id,
        name: known.name,
        variants: known.variants,
        mayTrainOnYourPrompts: known.mayTrainOnYourPrompts,
      },
    ],
    isLoadingModels: false,
    contextLengthByModelId: new Map(
      known.contextLength ? [[known.id, known.contextLength] as const] : []
    ),
  };
}
