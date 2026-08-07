import { listInstanceModels } from './instance-model-catalog';
import {
  REMOTE_MODEL_CATALOG_MAX_SERIALIZED_BYTES,
  REMOTE_MODEL_IDENTITY_MAX_LENGTH,
  REMOTE_MODEL_MAX_MODELS_PER_PROVIDER,
} from './schemas';
import { CommandDeliveredError, UserWebCommandError } from './user-web-connection';

function makeFakeConnection() {
  return {
    sendCommandToConnection: jest.fn(),
  };
}

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

function createSdkProvider(
  id: string,
  models: ReturnType<typeof createSdkModel>[] = [createSdkModel(id, `model-${id}`)]
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

describe('listInstanceModels', () => {
  it('sends exactly one sessionless list_models with protocol version 1 and no session or mutation id', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockResolvedValue({
      protocolVersion: 1,
      all: [],
      default: {},
      connected: [],
      failed: [],
      truncated: false,
    });

    const result = await listInstanceModels(connection, 'cli-owner-1');

    expect(result).toEqual({
      ok: true,
      catalog: { protocolVersion: 1, providers: [], truncated: false },
    });
    expect(connection.sendCommandToConnection).toHaveBeenCalledTimes(1);
    const recorded = connection.sendCommandToConnection.mock.calls[0]?.[0];
    expect(recorded).toEqual({
      command: 'list_models',
      data: { protocolVersion: 1 },
      expectedConnectionId: 'cli-owner-1',
    });
    expect(recorded).not.toHaveProperty('mutationId');
    expect(recorded).not.toHaveProperty('sessionId');
    expect(recorded?.data).not.toHaveProperty('sessionId');
  });

  it('resolves a valid wire catalog with the transformed connected-only sorted shape', async () => {
    const connection = makeFakeConnection();
    const zeta = createSdkProvider('zeta-provider');
    zeta.name = 'Zeta Provider';
    const alpha = createSdkProvider('alpha-provider', [
      createSdkModel('alpha-provider', 'beta', [], 'Beta'),
      createSdkModel('alpha-provider', 'alpha', [], 'Alpha'),
    ]);
    alpha.name = 'Alpha Provider';
    const disconnected = createSdkProvider('disconnected');
    connection.sendCommandToConnection.mockResolvedValue({
      ...createWireCatalog([zeta, alpha, disconnected]),
      connected: ['zeta-provider', 'alpha-provider'],
    });

    const result = await listInstanceModels(connection, 'cli-owner-1');

    expect(result).toEqual({
      ok: true,
      catalog: {
        protocolVersion: 1,
        providers: [
          {
            id: 'alpha-provider',
            name: 'Alpha Provider',
            models: [
              {
                id: 'alpha',
                name: 'Alpha',
                variants: [],
                capabilities: { attachment: true, reasoning: true },
                limits: { context: 128_000, output: 16_000 },
              },
              {
                id: 'beta',
                name: 'Beta',
                variants: [],
                capabilities: { attachment: true, reasoning: true },
                limits: { context: 128_000, output: 16_000 },
              },
            ],
          },
          {
            id: 'zeta-provider',
            name: 'Zeta Provider',
            models: [
              {
                id: 'model-zeta-provider',
                name: 'model-zeta-provider',
                variants: [],
                capabilities: { attachment: true, reasoning: true },
                limits: { context: 128_000, output: 16_000 },
              },
            ],
          },
        ],
        truncated: false,
      },
    });
  });

  it('classifies the old-CLI invalid list_models command as unsupported', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(
      new CommandDeliveredError('invalid list_models command')
    );

    await expect(listInstanceModels(connection, 'cli-owner-1')).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    });
    expect(connection.sendCommandToConnection).toHaveBeenCalledTimes(1);
  });

  it('classifies any other delivered CommandDeliveredError as transport', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(
      new CommandDeliveredError('failed to list models')
    );

    await expect(listInstanceModels(connection, 'cli-owner-1')).resolves.toEqual({
      ok: false,
      reason: 'transport',
    });
  });

  it('classifies a structured relay error with a non-retryable code as unsupported', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(
      new UserWebCommandError({ code: 'CLI_UPGRADE_REQUIRED', message: 'upgrade required' })
    );

    await expect(listInstanceModels(connection, 'cli-owner-1')).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('classifies an over-cap catalog relay code as unsupported so it is never retried', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(
      new UserWebCommandError({ code: 'CATALOG_TOO_LARGE', message: 'catalog too large' })
    );

    await expect(listInstanceModels(connection, 'cli-owner-1')).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('classifies every retryable relay code as transport', async () => {
    const retryableCodes = [
      'SESSION_OWNER_CHANGED',
      'CATALOG_REQUEST_PENDING',
      'COMMAND_EXPIRED',
      'PENDING_COMMAND_LIMIT',
    ];

    for (const code of retryableCodes) {
      const connection = makeFakeConnection();
      connection.sendCommandToConnection.mockRejectedValue(
        new UserWebCommandError({ code, message: 'try again' })
      );

      await expect(listInstanceModels(connection, 'cli-owner-1')).resolves.toEqual({
        ok: false,
        reason: 'transport',
      });
    }
  });

  it('classifies a plain transport-level rejection as transport', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(new Error('Command timed out'));

    await expect(listInstanceModels(connection, 'cli-owner-1')).resolves.toEqual({
      ok: false,
      reason: 'transport',
    });
  });

  it('classifies a resolved payload with an unknown top-level key as invalid', async () => {
    const connection = makeFakeConnection();
    const wire = createWireCatalog([createSdkProvider('provider')]);
    connection.sendCommandToConnection.mockResolvedValue({ ...wire, sneaky: 'value' });

    await expect(listInstanceModels(connection, 'cli-owner-1')).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('classifies a resolved payload over the serialized byte limit as invalid', async () => {
    const connection = makeFakeConnection();
    const overLimit = createCatalogWithSerializedBytes(
      REMOTE_MODEL_CATALOG_MAX_SERIALIZED_BYTES + 1
    );
    connection.sendCommandToConnection.mockResolvedValue(overLimit);

    expect(getSerializedByteLength(overLimit)).toBe(REMOTE_MODEL_CATALOG_MAX_SERIALIZED_BYTES + 1);
    await expect(listInstanceModels(connection, 'cli-owner-1')).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('keeps a schema-valid catalog with an empty-model connected provider SDK-valid', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockResolvedValue(
      createWireCatalog([createSdkProvider('provider', [])])
    );

    const result = await listInstanceModels(connection, 'cli-owner-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.catalog.providers).toEqual([{ id: 'provider', name: 'provider', models: [] }]);
    }
  });
});
