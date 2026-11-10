import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ai_gateway_metadata_cache } from '@kilocode/db/schema';
import { EndpointsSchema, ModelSchema } from '@kilocode/db/schema-types';
import { db, sql } from '@kilocode/web-shared/lib/drizzle';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  NO_ENDPOINTS_RESOURCE,
  formatModelIds,
  gatewayModelEndpointsUrl,
  gatewayModelsSource,
  joinGatewayModelEndpoints,
  readStoredGatewayModels,
  retainPreviousEntries,
  type ListedGatewayModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';

const gateway = {
  type: 'vercel',
  apiUrl: 'https://gateway.test/v1',
  apiUrlOverrides: {},
  disableUrlSuffix: false,
  apiKey: 'test-key',
  apiKeyHeader: null,
  supportedChatApis: ['chat_completions'],
  responseTransforms: null,
  async transformRequest() {},
} satisfies Provider;

const otherGateway = { ...gateway, apiUrl: 'https://other-gateway.test/v1' } satisfies Provider;

const modelsSource = gatewayModelsSource(gateway, '/models');

const fillerModels = Array.from({ length: 100 }, (_, index) => ({
  id: `filler/model-${index}`,
  name: `Filler ${index}`,
}));

async function storeRows(rows: ReadonlyArray<[url: string, data: unknown]>) {
  await db.insert(ai_gateway_metadata_cache).values(rows.map(([url, data]) => ({ url, data })));
}

function storeList(models: unknown[]) {
  return storeRows([[modelsSource.url, { data: [...models, ...fillerModels] }]]);
}

function endpointsRow(modelId: string, data: unknown): [string, unknown] {
  return [gatewayModelEndpointsUrl(gateway, modelId), data];
}

function endpointsBody(endpoints: unknown) {
  return { data: { id: 'ignored', endpoints } };
}

function read() {
  return readStoredGatewayModels(gateway, modelsSource, db);
}

function modelsOf(listed: ListedGatewayModel[] | null) {
  return listed?.map(({ model }) => model);
}

function storedEndpointsOf(listed: ListedGatewayModel[] | null) {
  return new Map(
    listed?.flatMap(({ model, endpoints }) =>
      endpoints === undefined ? [] : [[model.id, endpoints] as const]
    )
  );
}

const upstreamModel = {
  id: 'vendor/full',
  name: 'Full',
  description: 'A long upstream description',
  created: 1_700_000_000,
  pricing: { prompt: '0.000001', completion: '0.000002' },
  type: 'language',
  alias_target: { slug: 'vendor/full-0731' },
  architecture: {
    input_modalities: ['text', 'image'],
    output_modalities: ['text'],
    tokenizer: 'Other',
  },
  reasoning: { mandatory: false, supported_efforts: ['low', 'high'] },
};

const upstreamEndpoints = [
  {
    name: 'Provider One | vendor/full',
    tag: 'provider-one/fp8',
    provider_name: 'Provider One',
    context_length: 200_000,
    pricing: {
      prompt: '0.000001',
      completion: '0.000002',
      input_cache_read: '0.0000001',
      discount: 0.25,
      overrides: [{ prompt: '0.000003' }],
    },
    has_zdr: true,
    has_no_training: false,
    uptime_last_30m: 99.5,
    latency_last_30m: { p50: 120 },
  },
  { tag: 'provider-two', provider_name: 'Provider Two', status: 0 },
];

beforeEach(async () => {
  await db.delete(ai_gateway_metadata_cache).where(sql`true`);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('readStoredGatewayModels', () => {
  it('returns null when the list is not stored', async () => {
    await storeRows([endpointsRow('vendor/a', endpointsBody([]))]);

    await expect(read()).resolves.toBeNull();
  });

  it('returns the listed models in order, each with its endpoints', async () => {
    await storeList([{ id: 'vendor/b', name: 'B' }, upstreamModel, { id: 'vendor/a', name: 'A' }]);
    await storeRows([
      endpointsRow('vendor/a', endpointsBody([{ provider_name: 'a' }])),
      endpointsRow('vendor/b', endpointsBody([])),
      endpointsRow('vendor/full', endpointsBody(upstreamEndpoints)),
    ]);

    const stored = await read();

    expect(modelsOf(stored)).toEqual([
      { id: 'vendor/b', name: 'B' },
      {
        id: 'vendor/full',
        name: 'Full',
        type: 'language',
        alias_target: { slug: 'vendor/full-0731' },
        architecture: { output_modalities: ['text'] },
        reasoning: { mandatory: false, supported_efforts: ['low', 'high'] },
      },
      { id: 'vendor/a', name: 'A' },
      ...fillerModels,
    ]);
    expect(storedEndpointsOf(stored)).toEqual(
      new Map([
        ['vendor/b', []],
        [
          'vendor/full',
          [
            {
              tag: 'provider-one/fp8',
              provider_name: 'Provider One',
              context_length: 200_000,
              pricing: {
                prompt: '0.000001',
                completion: '0.000002',
                input_cache_read: '0.0000001',
                discount: 0.25,
              },
              has_zdr: true,
              has_no_training: false,
            },
            { tag: 'provider-two', provider_name: 'Provider Two' },
          ],
        ],
        ['vendor/a', [{ provider_name: 'a' }]],
      ])
    );
  });

  it('queries only the keys the schemas read', async () => {
    const execute = jest.spyOn(db, 'execute');
    await storeList([upstreamModel]);
    await storeRows([endpointsRow('vendor/full', endpointsBody(upstreamEndpoints))]);

    await read();

    const [query] = execute.mock.calls[0];
    const { rows } = await db.execute(query);
    expect(rows).toEqual([
      {
        models: {
          data: [
            {
              id: 'vendor/full',
              name: 'Full',
              type: 'language',
              alias_target: { slug: 'vendor/full-0731' },
              architecture: { output_modalities: ['text'] },
              reasoning: { mandatory: false, supported_efforts: ['low', 'high'] },
            },
            ...fillerModels,
          ],
        },
        endpoints: [
          {
            data: {
              endpoints: [
                {
                  tag: 'provider-one/fp8',
                  provider_name: 'Provider One',
                  context_length: 200_000,
                  pricing: {
                    prompt: '0.000001',
                    completion: '0.000002',
                    input_cache_read: '0.0000001',
                    discount: 0.25,
                  },
                  has_zdr: true,
                  has_no_training: false,
                },
                { tag: 'provider-two', provider_name: 'Provider Two' },
              ],
            },
          },
          ...fillerModels.map(() => null),
        ],
      },
    ]);
  });

  it('maps a stored missing endpoints resource to its marker', async () => {
    await storeList([{ id: 'vendor/a-batch', name: 'A batch' }]);
    await storeRows([endpointsRow('vendor/a-batch', { status: 404 })]);

    const stored = await read();

    expect(storedEndpointsOf(stored)).toEqual(new Map([['vendor/a-batch', NO_ENDPOINTS_RESOURCE]]));
  });

  it('leaves out models whose endpoints row is missing or does not parse', async () => {
    await storeList([
      { id: 'vendor/ok', name: 'OK' },
      { id: 'vendor/missing', name: 'Missing' },
      { id: 'vendor/not-a-list', name: 'Not a list' },
      { id: 'vendor/not-an-object', name: 'Not an object' },
      { id: 'vendor/no-data', name: 'No data' },
    ]);
    await storeRows([
      endpointsRow('vendor/ok', endpointsBody([{ provider_name: 'ok' }])),
      endpointsRow('vendor/not-a-list', endpointsBody('not-a-list')),
      endpointsRow('vendor/not-an-object', endpointsBody([{ provider_name: 'ok' }, 'nope'])),
      endpointsRow('vendor/no-data', { status: 500 }),
    ]);

    const stored = await read();

    expect(
      modelsOf(stored)
        ?.slice(0, 5)
        .map(model => model.id)
    ).toEqual([
      'vendor/ok',
      'vendor/missing',
      'vendor/not-a-list',
      'vendor/not-an-object',
      'vendor/no-data',
    ]);
    expect(storedEndpointsOf(stored)).toEqual(new Map([['vendor/ok', [{ provider_name: 'ok' }]]]));
  });

  it.each([
    ['a non-list data field', { data: 'nope' }],
    ['a model without an id', { data: [...fillerModels, { name: 'No id' }] }],
    ['a non-object model', { data: [...fillerModels, 'vendor/a'] }],
    ['a body without data', { models: fillerModels }],
  ])('throws when the stored list has %s', async (_label, list) => {
    await storeRows([[modelsSource.url, list]]);

    await expect(read()).rejects.toThrow();
  });

  it('throws when the stored list looks truncated', async () => {
    await storeRows([[modelsSource.url, { data: fillerModels.slice(1) }]]);

    await expect(read()).rejects.toThrow(
      `Suspicious: ${modelsSource.url} returned 99 entries, fewer than 100`
    );
  });

  it('keeps the zod semantics of JSON null values', async () => {
    const modelWithNulls = {
      id: 'vendor/nulls',
      name: 'Nulls',
      type: null,
      alias_target: null,
      architecture: null,
      reasoning: null,
    };
    const endpointsBodies = {
      'vendor/null-flags': endpointsBody([
        { provider_name: 'flags', has_zdr: null, has_no_training: null },
      ]),
      'vendor/null-tag': endpointsBody([{ tag: null, provider_name: 'tag' }]),
      'vendor/null-pricing': endpointsBody([{ provider_name: 'pricing', pricing: null }]),
      'vendor/null-price': endpointsBody([
        { provider_name: 'price', pricing: { prompt: '1', completion: '2', image: null } },
      ]),
      'vendor/null-context-length': endpointsBody([
        { provider_name: 'context', context_length: null },
      ]),
    };
    await storeList([
      modelWithNulls,
      ...Object.keys(endpointsBodies).map(id => ({ id, name: id })),
    ]);
    await storeRows(Object.entries(endpointsBodies).map(([id, body]) => endpointsRow(id, body)));

    const stored = await read();

    expect(stored?.[0]?.model).toEqual(ModelSchema.parse(modelWithNulls));
    expect(stored?.[0]?.model).toEqual({ id: 'vendor/nulls', name: 'Nulls' });
    for (const [id, body] of Object.entries(endpointsBodies)) {
      expect([id, storedEndpointsOf(stored).has(id)]).toEqual([
        id,
        EndpointsSchema.safeParse(body).success,
      ]);
    }
    expect(storedEndpointsOf(stored)).toEqual(
      new Map([['vendor/null-flags', [{ provider_name: 'flags' }]]])
    );
  });

  it('joins only endpoints rows of the given gateway', async () => {
    await storeList([
      { id: 'vendor/a', name: 'A' },
      { id: 'vendor/b', name: 'B' },
    ]);
    await storeRows([
      endpointsRow('vendor/a', endpointsBody([{ provider_name: 'own' }])),
      [gatewayModelEndpointsUrl(otherGateway, 'vendor/a'), endpointsBody([{ provider_name: 'x' }])],
      [gatewayModelEndpointsUrl(otherGateway, 'vendor/b'), endpointsBody([{ provider_name: 'x' }])],
    ]);

    const stored = await read();

    expect(storedEndpointsOf(stored)).toEqual(new Map([['vendor/a', [{ provider_name: 'own' }]]]));
  });

  it('matches model ids that contain alias and variant characters', async () => {
    const modelIds = ['~vendor/model-latest', 'vendor/model:free'];
    await storeList(modelIds.map(id => ({ id, name: id })));
    await storeRows(modelIds.map(id => endpointsRow(id, endpointsBody([{ provider_name: id }]))));

    const stored = await read();

    expect(storedEndpointsOf(stored)).toEqual(
      new Map([
        ['~vendor/model-latest', [{ provider_name: '~vendor/model-latest' }]],
        ['vendor/model:free', [{ provider_name: 'vendor/model:free' }]],
      ])
    );
  });
});

describe('joinGatewayModelEndpoints', () => {
  const listedFillers = fillerModels.map((model): ListedGatewayModel => ({
    model,
    endpoints: [{ provider_name: 'filler' }],
  }));

  it('attaches endpoints and reports models without endpoints or an endpoints resource', () => {
    const joined = joinGatewayModelEndpoints(gateway, [
      { model: { id: 'vendor/c', name: 'C' }, endpoints: undefined },
      { model: { id: 'vendor/b-batch', name: 'B batch' }, endpoints: NO_ENDPOINTS_RESOURCE },
      { model: { id: 'vendor/a', name: 'A' }, endpoints: [{ provider_name: 'a' }] },
      { model: { id: 'vendor/a-batch', name: 'A batch' }, endpoints: NO_ENDPOINTS_RESOURCE },
      { model: { id: 'vendor/b', name: 'B' }, endpoints: undefined },
      ...listedFillers,
    ]);

    expect(Object.keys(joined.models)).toEqual([
      'vendor/a',
      ...fillerModels.map(model => model.id),
    ]);
    expect(joined.models['vendor/a']).toEqual({
      id: 'vendor/a',
      name: 'A',
      endpoints: [{ provider_name: 'a' }],
    });
    expect(joined.withoutEndpointsResource).toEqual(['vendor/a-batch', 'vendor/b-batch']);
    expect(joined.withoutStoredEndpoints).toEqual(['vendor/b', 'vendor/c']);
  });

  it('throws when fewer than 100 models have endpoints', () => {
    expect(() =>
      joinGatewayModelEndpoints(gateway, [
        { model: { id: 'vendor/a-batch', name: 'A batch' }, endpoints: NO_ENDPOINTS_RESOURCE },
        ...listedFillers.slice(1),
      ])
    ).toThrow('Suspicious: total number of vercel models is 99 < 100');
  });
});

describe('retainPreviousEntries', () => {
  const model = (id: string, provider: string, aliasTarget?: string) => ({
    id,
    name: id,
    ...(aliasTarget && { alias_target: { slug: aliasTarget } }),
    endpoints: [{ provider_name: provider }],
  });

  it('keeps previous entries for models without stored endpoints and aliases to them', () => {
    const previous = {
      '~vendor/a-latest': model('~vendor/a-latest', 'before', 'vendor/a'),
      'vendor/a': model('vendor/a', 'before'),
      'vendor/kept': model('vendor/kept', 'before'),
    };
    const joined = {
      models: {
        '~vendor/a-latest': model('~vendor/a-latest', 'now', 'vendor/new'),
        '~vendor/kept-latest': model('~vendor/kept-latest', 'now', 'vendor/kept'),
        '~vendor/fresh-latest': model('~vendor/fresh-latest', 'now', 'vendor/new'),
        'vendor/a': model('vendor/a', 'now'),
      },
      withoutEndpointsResource: [],
      withoutStoredEndpoints: ['vendor/kept', 'vendor/new'],
    };

    expect(retainPreviousEntries(joined, previous)).toEqual({
      '~vendor/a-latest': previous['~vendor/a-latest'],
      '~vendor/kept-latest': joined.models['~vendor/kept-latest'],
      'vendor/a': joined.models['vendor/a'],
      'vendor/kept': previous['vendor/kept'],
    });
  });
});

describe('formatModelIds', () => {
  const modelIds = (count: number) => Array.from({ length: count }, (_, index) => `m${index}`);

  it('lists up to 20 model ids', () => {
    expect(formatModelIds(modelIds(20))).toBe(modelIds(20).join(', '));
  });

  it('lists the first 20 model ids and counts the rest', () => {
    expect(formatModelIds(modelIds(23))).toBe(`${modelIds(20).join(', ')} and 3 more`);
  });
});
