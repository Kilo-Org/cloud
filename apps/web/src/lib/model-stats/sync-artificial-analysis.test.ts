import { describe, expect, it } from '@jest/globals';
import {
  groupByReasoningFamily,
  resolveAaModel,
  type ArtificialAnalysisModel,
} from './sync-artificial-analysis';

function aaModel(slug: string, codingIndex: number | null = 50): ArtificialAnalysisModel {
  return {
    id: slug,
    name: slug,
    slug,
    evaluations: { artificial_analysis_coding_index: codingIndex },
  };
}

function resolve(aaSlug: string, models: ArtificialAnalysisModel[]) {
  const bySlug = new Map(models.map(model => [model.slug, model]));
  return resolveAaModel(aaSlug, bySlug, groupByReasoningFamily(models))?.slug;
}

describe('resolveAaModel', () => {
  it('picks the highest reasoning effort for a family slug', () => {
    const models = ['gpt-5-2-low', 'gpt-5-2', 'gpt-5-2-xhigh', 'gpt-5-2-medium'].map(s =>
      aaModel(s)
    );
    expect(resolve('gpt-5-2', models)).toBe('gpt-5-2-xhigh');
  });

  it('prefers the thinking variant over the bare slug', () => {
    const models = [aaModel('claude-4-5-sonnet'), aaModel('claude-4-5-sonnet-thinking')];
    expect(resolve('claude-4-5-sonnet', models)).toBe('claude-4-5-sonnet-thinking');
  });

  it('keeps the bare default over lower explicit efforts', () => {
    const models = [aaModel('gpt-5'), aaModel('gpt-5-low'), aaModel('gpt-5-minimal')];
    expect(resolve('gpt-5', models)).toBe('gpt-5');
  });

  it('honours an explicitly pinned effort', () => {
    const models = [aaModel('gpt-5-2-xhigh'), aaModel('gpt-5-2-medium')];
    expect(resolve('gpt-5-2-medium', models)).toBe('gpt-5-2-medium');
  });

  it('skips variants without a coding index', () => {
    const models = [aaModel('gpt-5-2-high'), aaModel('gpt-5-2-xhigh', null)];
    expect(resolve('gpt-5-2', models)).toBe('gpt-5-2-high');
  });

  it('returns undefined when nothing matches', () => {
    expect(resolve('unknown', [aaModel('gpt-5')])).toBeUndefined();
  });
});
