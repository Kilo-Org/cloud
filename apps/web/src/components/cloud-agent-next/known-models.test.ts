import { describe, expect, it } from '@jest/globals';
import type { GatewayCatalog, KnownModel } from './known-models';
import {
  encodeKnownModels,
  parseKnownModels,
  rememberKnownModel,
  withKnownModel,
} from './known-models';

const sonnet: KnownModel = {
  id: 'anthropic/claude-sonnet-4',
  name: 'Anthropic: Claude Sonnet 4',
  variants: ['none', 'high'],
  mayTrainOnYourPrompts: false,
  contextLength: 200000,
};
const freeModel: KnownModel = {
  id: 'vendor/free-model:free',
  name: 'Vendor: Free Model (free)',
  variants: [],
  mayTrainOnYourPrompts: true,
};

const loading: GatewayCatalog = {
  modelOptions: [],
  isLoadingModels: true,
  contextLengthByModelId: new Map(),
};

describe('known models cookie', () => {
  it('reads back what it wrote for the same user only', () => {
    const encoded = decodeURIComponent(encodeKnownModels([sonnet, freeModel], 'user-1'));

    expect(parseKnownModels(encoded, 'user-1')).toEqual([sonnet, freeModel]);
    expect(parseKnownModels(encoded, 'user-2')).toEqual([]);
    expect(parseKnownModels('{not json', 'user-1')).toEqual([]);
  });

  it('stays under its size budget and keeps the most recent models', () => {
    const models = Array.from({ length: 8 }, (_, index) => ({
      ...sonnet,
      id: `an-organization-with-a-long-name/a-model-with-a-long-name-${index}`,
      name: `An Organization With A Long Name: A Model With A Long Name ${index}`,
      variants: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    }));

    const encoded = encodeKnownModels(models, 'user-1');
    const parsed = parseKnownModels(decodeURIComponent(encoded), 'user-1');

    expect(encoded.length).toBeLessThanOrEqual(1500);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed).toEqual(models.slice(0, parsed.length));
  });

  it('moves a used model first and keeps the list when nothing changed', () => {
    const models = [freeModel, sonnet];

    expect(rememberKnownModel(models, sonnet)).toEqual([sonnet, freeModel]);
    expect(rememberKnownModel(models, freeModel)).toBe(models);
  });
});

describe('withKnownModel', () => {
  it('offers only the known selected model while the catalog loads', () => {
    const catalog = withKnownModel(loading, [freeModel, sonnet], sonnet.id);

    expect(catalog.isLoadingModels).toBe(false);
    expect(catalog.modelOptions).toEqual([
      {
        id: sonnet.id,
        name: sonnet.name,
        variants: sonnet.variants,
        mayTrainOnYourPrompts: false,
      },
    ]);
    expect(catalog.contextLengthByModelId.get(sonnet.id)).toBe(200000);
  });

  it('keeps loading for an unknown model and keeps a loaded catalog', () => {
    const loaded = { ...loading, isLoadingModels: false };

    expect(withKnownModel(loading, [freeModel], sonnet.id)).toBe(loading);
    expect(withKnownModel(loaded, [sonnet], sonnet.id)).toBe(loaded);
  });
});
