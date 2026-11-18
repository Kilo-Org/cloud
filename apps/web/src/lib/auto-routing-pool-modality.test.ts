import { describe, expect, it } from '@jest/globals';
import {
  computePoolModalityCoverage,
  formatModalityList,
  poolModalityUnknownMessage,
  poolModalityWarningMessage,
  type ModalityCatalogModel,
} from './auto-routing-pool-modality';

function model(id: string, inputModalities?: readonly string[] | null): ModalityCatalogModel {
  return { id, inputModalities };
}

describe('computePoolModalityCoverage', () => {
  it('reports covered when every catalog modality is accepted by the pool', () => {
    const coverage = computePoolModalityCoverage({
      poolModelIds: ['b'],
      catalog: [model('a', ['text', 'image']), model('b', ['text', 'image'])],
    });
    expect(coverage).toEqual({ status: 'covered' });
  });

  it('reports pending, not unknown, while the catalog is loading or failed to load', () => {
    expect(computePoolModalityCoverage({ poolModelIds: ['b'], catalog: null })).toEqual({
      status: 'pending',
    });
  });

  it('reports covered for an empty pool (inherits the platform pool)', () => {
    expect(
      computePoolModalityCoverage({ poolModelIds: [], catalog: [model('a', ['text', 'image'])] })
    ).toEqual({ status: 'covered' });
  });

  it('reports a single missing modality', () => {
    const coverage = computePoolModalityCoverage({
      poolModelIds: ['b'],
      catalog: [model('a', ['text', 'image']), model('b', ['text'])],
    });
    expect(coverage).toEqual({ status: 'missing', missing: ['image'] });
  });

  it('reports every catalog modality the pool cannot serve, in vocabulary order', () => {
    const coverage = computePoolModalityCoverage({
      poolModelIds: ['b'],
      catalog: [model('a', ['text', 'image', 'audio', 'video']), model('b', ['text'])],
    });
    expect(coverage).toEqual({ status: 'missing', missing: ['image', 'audio', 'video'] });
  });

  it('ignores modalities no catalog model declares', () => {
    const coverage = computePoolModalityCoverage({
      poolModelIds: ['b'],
      catalog: [model('a', ['text']), model('b', ['text'])],
    });
    expect(coverage).toEqual({ status: 'covered' });
  });

  it('unions modalities across the whole pool', () => {
    const coverage = computePoolModalityCoverage({
      poolModelIds: ['b', 'c'],
      catalog: [model('a', ['text', 'image']), model('b', ['text']), model('c', ['text', 'image'])],
    });
    expect(coverage).toEqual({ status: 'covered' });
  });

  it('reports unknown instead of a gap for a model absent from the catalog', () => {
    const coverage = computePoolModalityCoverage({
      poolModelIds: ['a', 'removed/model'],
      catalog: [model('a', ['text', 'image'])],
    });
    expect(coverage).toEqual({ status: 'unknown', unknownModelIds: ['removed/model'] });
  });

  it('reports unknown when a pool model has no catalog modality data', () => {
    const coverage = computePoolModalityCoverage({
      poolModelIds: ['b'],
      catalog: [model('a', ['text', 'image']), model('b')],
    });
    expect(coverage).toEqual({ status: 'unknown', unknownModelIds: ['b'] });
  });

  it('does not claim a gap when the pool mixes known and unknown models', () => {
    const coverage = computePoolModalityCoverage({
      poolModelIds: ['b', 'ghost'],
      catalog: [model('a', ['text', 'image', 'video']), model('b', ['text'])],
    });
    expect(coverage).toEqual({ status: 'unknown', unknownModelIds: ['ghost'] });
  });
});

describe('poolModalityWarningMessage', () => {
  it('names the enforced modalities and the default-model fallback', () => {
    expect(poolModalityWarningMessage(['image'])).toBe(
      'No model in this pool accepts image input. Requests with image input fall back to the default model.'
    );
  });

  it('omits the fallback claim for modalities the router does not enforce', () => {
    expect(poolModalityWarningMessage(['audio', 'video'])).toBe(
      'No model in this pool accepts audio or video input.'
    );
  });

  it('lists enforcement only for the enforced subset of a mixed gap', () => {
    expect(poolModalityWarningMessage(['image', 'audio'])).toBe(
      'No model in this pool accepts image or audio input. Requests with image input fall back to the default model.'
    );
  });
});

describe('formatModalityList', () => {
  it('joins two items with "or" and three-plus with a serial comma', () => {
    expect(formatModalityList(['image'])).toBe('image');
    expect(formatModalityList(['audio', 'video'])).toBe('audio or video');
    expect(formatModalityList(['image', 'audio', 'video'])).toBe('image, audio, or video');
    expect(formatModalityList([])).toBe('');
  });
});

describe('poolModalityUnknownMessage', () => {
  it('pluralizes by count', () => {
    expect(poolModalityUnknownMessage(['ghost'])).toBe(
      'Modality coverage is unknown: 1 model is not in the model catalog.'
    );
    expect(poolModalityUnknownMessage(['ghost', 'removed/model'])).toBe(
      'Modality coverage is unknown: 2 models are not in the model catalog.'
    );
  });
});
