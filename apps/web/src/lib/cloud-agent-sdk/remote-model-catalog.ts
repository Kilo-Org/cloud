import type { ModelRef, ModelSelection, RemoteModelCatalogV1 } from './schemas';

export {
  REMOTE_MODEL_CATALOG_MAX_SERIALIZED_BYTES,
  REMOTE_MODEL_IDENTITY_MAX_LENGTH,
  REMOTE_MODEL_MAX_MODELS_PER_PROVIDER,
  REMOTE_MODEL_MAX_MODELS_TOTAL,
  REMOTE_MODEL_MAX_PROVIDERS,
  REMOTE_MODEL_MAX_VARIANTS_PER_MODEL,
  REMOTE_MODEL_MAX_VARIANTS_TOTAL,
  modelRefSchema,
  modelSelectionSchema,
  remoteModelCatalogV1Schema,
  remoteModelCatalogWireV1Schema,
  type ModelRef,
  type ModelSelection,
  type RemoteModelCatalogV1,
  type RemoteModelCatalogWireV1,
} from './schemas';
export {
  getRemoteModelRecommendedRank,
  isRemoteModelRecommended,
  sortRemoteModelCatalogProviders,
} from './remote-model-order';

// Catalog strings are user/plugin-controlled metadata and may be private.
// Treat them as display data, never executable config or independent telemetry.
export type RemoteModelState = {
  ownerConnectionId: string | null;
  protocol: 'unknown' | 'legacy' | 'v1';
  catalog?: RemoteModelCatalogV1;
  refresh: 'idle' | 'loading' | 'error';
  error?: string;
};

export type RemoteModelOverride =
  | { source: 'cli-catalog'; selection: ModelSelection }
  | { source: 'legacy-gateway'; selection: ModelSelection };

export type ModelRefKeyMap = {
  getOrCreateKey: (modelRef: ModelRef) => string;
  getModelRef: (key: string) => ModelRef | undefined;
};

export function modelRefsEqual(left: ModelRef, right: ModelRef): boolean {
  return left.providerID === right.providerID && left.modelID === right.modelID;
}

export function createModelRefKeyMap(): ModelRefKeyMap {
  const keysByProviderAndModel = new Map<string, Map<string, string>>();
  const modelRefsByKey = new Map<string, ModelRef>();

  return {
    getOrCreateKey(modelRef) {
      let keysByModel = keysByProviderAndModel.get(modelRef.providerID);
      if (!keysByModel) {
        keysByModel = new Map();
        keysByProviderAndModel.set(modelRef.providerID, keysByModel);
      }

      const existingKey = keysByModel.get(modelRef.modelID);
      if (existingKey) return existingKey;

      const key = `remote-model-${modelRefsByKey.size}`;
      const storedModelRef = { providerID: modelRef.providerID, modelID: modelRef.modelID };
      keysByModel.set(modelRef.modelID, key);
      modelRefsByKey.set(key, storedModelRef);
      return key;
    },
    getModelRef(key) {
      return modelRefsByKey.get(key);
    },
  };
}
