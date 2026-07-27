import {
  REMOTE_MODEL_CATALOG_MAX_SERIALIZED_BYTES,
  REMOTE_MODEL_IDENTITY_MAX_LENGTH,
  REMOTE_MODEL_MAX_MODELS_PER_PROVIDER,
  REMOTE_MODEL_MAX_PROVIDERS,
  REMOTE_MODEL_MAX_VARIANTS_PER_MODEL,
  createModelRefKeyMap,
  modelRefSchema,
  modelRefsEqual,
  remoteModelCatalogV1Schema,
  remoteModelCatalogWireV1Schema,
} from './remote-model-catalog';

function createSdkModel(providerID: string, id: string, variants: string[] = [], name = id) {
  return {
    id,
    providerID,
    api: { id, url: '', npm: '' },
    name,
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 16_000 },
    status: 'active' as const,
    options: {},
    headers: {},
    release_date: '',
    variants: Object.fromEntries(variants.map(variant => [variant, {}])),
  };
}

type SdkModelFixture = ReturnType<typeof createSdkModel> & {
  recommendedIndex?: number;
  isFree?: boolean;
  mayTrainOnYourPrompts?: boolean;
  hasUserByokAvailable?: boolean;
};

function createSdkProvider(
  id: string,
  models: SdkModelFixture[] = [createSdkModel(id, `model-${id}`)]
) {
  return {
    id,
    name: id,
    source: 'custom' as const,
    env: [],
    options: {},
    models: Object.fromEntries(models.map(model => [model.id, model])),
  };
}

function createWireCatalog(all: ReturnType<typeof createSdkProvider>[]) {
  return {
    all,
    default: Object.fromEntries(
      all.flatMap(provider => {
        const modelID = Object.keys(provider.models)[0];
        return modelID ? [[provider.id, modelID]] : [];
      })
    ),
    connected: all.map(provider => provider.id),
    failed: [],
    protocolVersion: 1 as const,
    truncated: false,
  };
}

function getSerializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function createCatalogWithSerializedBytes(targetBytes: number) {
  for (let count = 256; count <= 2_048; count += 64) {
    const models = Array.from({ length: count }, (_, index) =>
      createSdkModel(
        `provider-${Math.floor(index / REMOTE_MODEL_MAX_MODELS_PER_PROVIDER)}`,
        `model-${index}`,
        [],
        ''
      )
    );
    const providers = Array.from(
      { length: Math.ceil(count / REMOTE_MODEL_MAX_MODELS_PER_PROVIDER) },
      (_, providerIndex) =>
        createSdkProvider(
          `provider-${providerIndex}`,
          models.slice(
            providerIndex * REMOTE_MODEL_MAX_MODELS_PER_PROVIDER,
            (providerIndex + 1) * REMOTE_MODEL_MAX_MODELS_PER_PROVIDER
          )
        )
    );
    const catalog = createWireCatalog(providers);
    let remainingBytes = targetBytes - getSerializedByteLength(catalog);
    if (remainingBytes < 0 || remainingBytes > count * REMOTE_MODEL_IDENTITY_MAX_LENGTH) continue;

    for (const model of models) {
      const addedBytes = Math.min(remainingBytes, REMOTE_MODEL_IDENTITY_MAX_LENGTH);
      model.name = 'x'.repeat(addedBytes);
      remainingBytes -= addedBytes;
      if (remainingBytes === 0) break;
    }
    if (getSerializedByteLength(catalog) === targetBytes) return catalog;
  }
  throw new Error(`Cannot create a catalog with ${targetBytes} serialized bytes`);
}

function createUtf8OversizedCatalog() {
  for (let count = 256; count <= 2_048; count += 64) {
    const models = Array.from({ length: count }, (_, index) =>
      createSdkModel(
        `provider-${Math.floor(index / REMOTE_MODEL_MAX_MODELS_PER_PROVIDER)}`,
        `model-${index}`,
        [],
        'é'.repeat(REMOTE_MODEL_IDENTITY_MAX_LENGTH)
      )
    );
    const providers = Array.from(
      { length: Math.ceil(count / REMOTE_MODEL_MAX_MODELS_PER_PROVIDER) },
      (_, providerIndex) =>
        createSdkProvider(
          `provider-${providerIndex}`,
          models.slice(
            providerIndex * REMOTE_MODEL_MAX_MODELS_PER_PROVIDER,
            (providerIndex + 1) * REMOTE_MODEL_MAX_MODELS_PER_PROVIDER
          )
        )
    );
    const catalog = createWireCatalog(providers);
    if (
      JSON.stringify(catalog).length < REMOTE_MODEL_CATALOG_MAX_SERIALIZED_BYTES &&
      getSerializedByteLength(catalog) > REMOTE_MODEL_CATALOG_MAX_SERIALIZED_BYTES
    ) {
      return catalog;
    }
  }
  throw new Error('Cannot create a UTF-8 oversized catalog');
}

describe('remoteModelCatalogV1Schema', () => {
  it('normalizes the SDK ProviderListResponse shape without rewriting model identities', () => {
    const model: SdkModelFixture = createSdkModel(
      'custom/provider:v1',
      'team/model.v2-beta',
      ['reasoning/high'],
      'Team model'
    );
    model.recommendedIndex = 4;
    model.isFree = true;
    model.mayTrainOnYourPrompts = false;
    model.hasUserByokAvailable = true;
    const connected = createSdkProvider('custom/provider:v1', [model]);
    connected.name = 'Private deployment';
    const disconnected = createSdkProvider('disconnected');
    const wire = {
      ...createWireCatalog([connected, disconnected]),
      connected: ['custom/provider:v1'],
      currentModel: {
        model: { providerID: 'custom/provider:v1', modelID: 'team/model.v2-beta' },
        variant: 'reasoning/high',
      },
      defaultModel: { providerID: 'custom/provider:v1', modelID: 'team/model.v2-beta' },
    };

    expect(remoteModelCatalogV1Schema.parse(wire)).toEqual({
      protocolVersion: 1,
      providers: [
        {
          id: 'custom/provider:v1',
          name: 'Private deployment',
          models: [
            {
              id: 'team/model.v2-beta',
              name: 'Team model',
              variants: ['reasoning/high'],
              recommendedIndex: 4,
              isFree: true,
              mayTrainOnYourPrompts: false,
              hasUserByokAvailable: true,
              capabilities: { attachment: true, reasoning: true },
              limits: { context: 128_000, output: 16_000 },
            },
          ],
        },
      ],
      currentModel: wire.currentModel,
      defaultModel: wire.defaultModel,
      truncated: false,
    });
  });

  it('orders providers and models to match the CLI TUI picker', () => {
    const zeta = createSdkProvider('zeta-provider');
    zeta.name = 'Zeta Provider';
    const alpha = createSdkProvider('alpha-provider', [
      createSdkModel('alpha-provider', 'beta', [], 'Beta'),
      createSdkModel('alpha-provider', 'alpha', [], 'Alpha'),
    ]);
    alpha.name = 'Alpha Provider';
    const kiloLater = {
      ...createSdkModel('kilo', 'kilo-later', [], 'Kilo Later'),
      recommendedIndex: 2,
    };
    const kiloFirst = {
      ...createSdkModel('kilo', 'kilo-first', [], 'Kilo First'),
      recommendedIndex: 0,
    };
    const kiloByok = {
      ...createSdkModel('kilo', 'kilo-byok', [], 'Kilo BYOK'),
      hasUserByokAvailable: true,
    };
    const kilo = createSdkProvider('kilo', [kiloLater, kiloByok, kiloFirst]);
    kilo.name = 'Kilo Gateway';
    const opencode = createSdkProvider('opencode', [
      { ...createSdkModel('opencode', 'z-model', [], 'Z Model'), isFree: true },
      { ...createSdkModel('opencode', 'a-model', [], 'A Model'), isFree: true },
    ]);
    opencode.name = 'OpenCode';

    const parsed = remoteModelCatalogV1Schema.parse(
      createWireCatalog([zeta, kilo, alpha, opencode])
    );

    expect(parsed.providers.map(provider => provider.id)).toEqual([
      'opencode',
      'alpha-provider',
      'kilo',
      'zeta-provider',
    ]);
    expect(parsed.providers[0]?.models.map(model => model.id)).toEqual(['a-model', 'z-model']);
    expect(parsed.providers[1]?.models.map(model => model.id)).toEqual(['alpha', 'beta']);
    expect(parsed.providers[2]?.models.map(model => model.id)).toEqual([
      'kilo-first',
      'kilo-later',
      'kilo-byok',
    ]);
  });

  it('rejects duplicate provider IDs and inconsistent model identities', () => {
    const duplicate = createSdkProvider('provider');
    expect(
      remoteModelCatalogWireV1Schema.safeParse(createWireCatalog([duplicate, duplicate])).success
    ).toBe(false);

    const wrongKey = createSdkProvider('provider');
    const model = wrongKey.models['model-provider'];
    if (!model) throw new Error('Expected model fixture');
    wrongKey.models = { 'wrong-key': model };

    const wrongProvider = createSdkProvider('provider');
    wrongProvider.models['model-provider'] = { ...model, providerID: 'other-provider' };

    const wrongApiID = createSdkProvider('provider');
    wrongApiID.models['model-provider'] = { ...model, api: { ...model.api, id: 'other-model' } };

    for (const provider of [wrongKey, wrongProvider, wrongApiID]) {
      expect(remoteModelCatalogWireV1Schema.safeParse(createWireCatalog([provider])).success).toBe(
        false
      );
    }
  });

  it('rejects dangling connected and default references, including inherited property names', () => {
    const provider = createSdkProvider('provider');
    const base = createWireCatalog([provider]);

    expect(
      remoteModelCatalogWireV1Schema.safeParse({ ...base, connected: ['missing'] }).success
    ).toBe(false);
    expect(
      remoteModelCatalogWireV1Schema.safeParse({
        ...base,
        default: { provider: 'toString' },
      }).success
    ).toBe(false);
  });

  it('rejects credential-bearing provider and model configuration', () => {
    const provider = createSdkProvider('provider');
    const base = createWireCatalog([provider]);
    const model = provider.models['model-provider'];
    if (!model) throw new Error('Expected model fixture');

    expect(
      remoteModelCatalogWireV1Schema.safeParse({
        ...base,
        all: [{ ...provider, key: 'secret' }],
      }).success
    ).toBe(false);
    expect(
      remoteModelCatalogWireV1Schema.safeParse({
        ...base,
        all: [{ ...provider, env: ['PRIVATE_API_KEY'] }],
      }).success
    ).toBe(false);
    expect(
      remoteModelCatalogWireV1Schema.safeParse({
        ...base,
        all: [{ ...provider, options: { apiKey: 'secret' } }],
      }).success
    ).toBe(false);
    expect(
      remoteModelCatalogWireV1Schema.safeParse({
        ...base,
        all: [
          {
            ...provider,
            models: { [model.id]: { ...model, headers: { authorization: 'secret' } } },
          },
        ],
      }).success
    ).toBe(false);
    expect(
      remoteModelCatalogWireV1Schema.safeParse({
        ...base,
        all: [
          {
            ...provider,
            models: { [model.id]: { ...model, api: { ...model.api, url: 'https://private' } } },
          },
        ],
      }).success
    ).toBe(false);
    expect(
      remoteModelCatalogWireV1Schema.safeParse({
        ...base,
        all: [
          {
            ...provider,
            models: { [model.id]: { ...model, variants: { precise: { apiKey: 'secret' } } } },
          },
        ],
      }).success
    ).toBe(false);

    const otherUnsafeModels = [
      { ...model, options: { apiKey: 'secret' } },
      { ...model, api: { ...model.api, npm: 'file:///private/provider' } },
      { ...model, cost: { ...model.cost, input: 1 } },
      { ...model, release_date: 'private-release-metadata' },
    ];
    for (const unsafeModel of otherUnsafeModels) {
      expect(
        remoteModelCatalogWireV1Schema.safeParse({
          ...base,
          all: [{ ...provider, models: { [model.id]: unsafeModel } }],
        }).success
      ).toBe(false);
    }
  });

  it('accepts exactly 512 KiB and rejects one serialized byte over the limit', () => {
    const atLimit = createCatalogWithSerializedBytes(REMOTE_MODEL_CATALOG_MAX_SERIALIZED_BYTES);
    const overLimit = createCatalogWithSerializedBytes(
      REMOTE_MODEL_CATALOG_MAX_SERIALIZED_BYTES + 1
    );

    expect(getSerializedByteLength(atLimit)).toBe(REMOTE_MODEL_CATALOG_MAX_SERIALIZED_BYTES);
    expect(remoteModelCatalogWireV1Schema.safeParse(atLimit).success).toBe(true);
    expect(getSerializedByteLength(overLimit)).toBe(REMOTE_MODEL_CATALOG_MAX_SERIALIZED_BYTES + 1);
    expect(remoteModelCatalogWireV1Schema.safeParse(overLimit).success).toBe(false);
  });

  it('measures the serialized catalog limit in UTF-8 bytes', () => {
    const catalog = createUtf8OversizedCatalog();

    expect(JSON.stringify(catalog).length).toBeLessThan(REMOTE_MODEL_CATALOG_MAX_SERIALIZED_BYTES);
    expect(getSerializedByteLength(catalog)).toBeGreaterThan(
      REMOTE_MODEL_CATALOG_MAX_SERIALIZED_BYTES
    );
    expect(remoteModelCatalogWireV1Schema.safeParse(catalog).success).toBe(false);
  });

  it('enforces provider, per-provider model, and per-model variant count bounds', () => {
    const tooManyProviders = Array.from({ length: REMOTE_MODEL_MAX_PROVIDERS + 1 }, (_, index) =>
      createSdkProvider(`provider-${index}`)
    );
    const tooManyModels = Array.from(
      { length: REMOTE_MODEL_MAX_MODELS_PER_PROVIDER + 1 },
      (_, index) => createSdkModel('provider', `model-${index}`)
    );
    const tooManyVariants = Array.from(
      { length: REMOTE_MODEL_MAX_VARIANTS_PER_MODEL + 1 },
      (_, index) => `variant-${index}`
    );

    expect(
      remoteModelCatalogWireV1Schema.safeParse(createWireCatalog(tooManyProviders)).success
    ).toBe(false);
    expect(
      remoteModelCatalogWireV1Schema.safeParse(
        createWireCatalog([createSdkProvider('provider', tooManyModels)])
      ).success
    ).toBe(false);
    expect(
      remoteModelCatalogWireV1Schema.safeParse(
        createWireCatalog([
          createSdkProvider('provider', [createSdkModel('provider', 'model', tooManyVariants)]),
        ])
      ).success
    ).toBe(false);
  });

  it('requires exact non-empty identities within the v1 length bound', () => {
    const validIdentity = 'p'.repeat(REMOTE_MODEL_IDENTITY_MAX_LENGTH);

    expect(
      modelRefSchema.parse({ providerID: 'provider/with/slash', modelID: validIdentity })
    ).toEqual({ providerID: 'provider/with/slash', modelID: validIdentity });
    expect(modelRefSchema.safeParse({ providerID: '', modelID: 'model' }).success).toBe(false);
    expect(
      modelRefSchema.safeParse({
        providerID: 'provider',
        modelID: 'm'.repeat(REMOTE_MODEL_IDENTITY_MAX_LENGTH + 1),
      }).success
    ).toBe(false);
  });
});

describe('modelRefsEqual', () => {
  it('compares exact provider and model identities without parsing separators', () => {
    const model = { providerID: 'custom/provider', modelID: 'family/model:v1' };

    expect(modelRefsEqual(model, { ...model })).toBe(true);
    expect(modelRefsEqual(model, { providerID: 'other/provider', modelID: model.modelID })).toBe(
      false
    );
    expect(modelRefsEqual(model, { providerID: model.providerID, modelID: 'model:v1' })).toBe(
      false
    );
  });
});

describe('createModelRefKeyMap', () => {
  it('round-trips exact refs through opaque keys without provider/model collisions', () => {
    const keyMap = createModelRefKeyMap();
    const first = { providerID: 'provider/one', modelID: 'shared/model' };
    const second = { providerID: 'provider/two', modelID: 'shared/model' };

    const firstKey = keyMap.getOrCreateKey(first);
    const secondKey = keyMap.getOrCreateKey(second);

    expect(firstKey).not.toBe(secondKey);
    expect(firstKey).not.toContain(first.providerID);
    expect(firstKey).not.toContain(first.modelID);
    expect(keyMap.getOrCreateKey({ ...first })).toBe(firstKey);
    expect(keyMap.getModelRef(firstKey)).toEqual(first);
    expect(keyMap.getModelRef(secondKey)).toEqual(second);
    expect(keyMap.getModelRef('unknown-key')).toBeUndefined();
  });
});
