import { describe, expect, test } from '@jest/globals';
import type {
  NormalizedOpenRouterResponse,
  NormalizedProvider,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import { computeSnapshotDiff } from '@/lib/ai-gateway/providers/openrouter/snapshot-diff';

function buildSnapshot(
  providers: Array<{ slug: string; models: string[] }>
): NormalizedOpenRouterResponse {
  const mapped: NormalizedProvider[] = providers.map(({ slug, models }) => ({
    name: slug,
    displayName: slug,
    slug,
    dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
    models: models.map(modelSlug => ({
      slug: modelSlug,
      name: modelSlug,
      author: slug,
      description: '',
      context_length: 0,
      input_modalities: [],
      output_modalities: [],
      group: 'other',
      updated_at: '',
      endpoint: {
        provider_display_name: slug,
        is_free: false,
        pricing: { prompt: '0', completion: '0' },
      },
    })),
  }));

  return {
    providers: mapped,
    total_providers: mapped.length,
    total_models: mapped.reduce((sum, p) => sum + p.models.length, 0),
    generated_at: '2026-01-01T00:00:00Z',
  };
}

describe('computeSnapshotDiff', () => {
  test('returns empty diff when old snapshot is null', () => {
    const snapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    const diff = computeSnapshotDiff(null, snapshot);

    expect(diff.addedByProvider.size).toBe(0);
    expect(diff.removedByProvider.size).toBe(0);
    expect(diff.oldModelProvidersIndex.size).toBe(0);
    expect(diff.newModelProvidersIndex.get('z-ai/glm-5')).toEqual(new Set(['z-ai']));
  });

  test('returns empty diff maps when snapshots are identical', () => {
    const snapshot = buildSnapshot([
      { slug: 'z-ai', models: ['z-ai/glm-5'] },
      { slug: 'anthropic', models: ['anthropic/claude-4.6'] },
    ]);
    const diff = computeSnapshotDiff(snapshot, snapshot);

    expect(diff.addedByProvider.size).toBe(0);
    expect(diff.removedByProvider.size).toBe(0);
  });

  test('detects new model on existing provider', () => {
    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    const newSnapshot = buildSnapshot([
      { slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1', 'z-ai/glm-5.1-air'] },
    ]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);

    expect(diff.addedByProvider.get('z-ai')).toEqual(['z-ai/glm-5.1', 'z-ai/glm-5.1-air']);
    expect(diff.removedByProvider.size).toBe(0);
  });

  test('detects brand-new provider with its models', () => {
    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    const newSnapshot = buildSnapshot([
      { slug: 'z-ai', models: ['z-ai/glm-5'] },
      { slug: 'xyz-corp', models: ['xyz-corp/foo', 'xyz-corp/bar'] },
    ]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);

    expect(diff.addedByProvider.get('xyz-corp')).toEqual(['xyz-corp/bar', 'xyz-corp/foo']);
    expect(diff.addedByProvider.has('z-ai')).toBe(false);
  });

  test('detects model removed from catalog', () => {
    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-4.0', 'z-ai/glm-5'] }]);
    const newSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);

    expect(diff.removedByProvider.get('z-ai')).toEqual(['z-ai/glm-4.0']);
    expect(diff.addedByProvider.size).toBe(0);
  });

  test('detects additional provider offering an existing model as addition for that provider only', () => {
    const oldSnapshot = buildSnapshot([
      { slug: 'openai', models: ['openai/gpt-4o'] },
      { slug: 'azure', models: [] },
    ]);
    const newSnapshot = buildSnapshot([
      { slug: 'openai', models: ['openai/gpt-4o'] },
      { slug: 'azure', models: ['openai/gpt-4o'] },
    ]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);

    expect(diff.addedByProvider.get('azure')).toEqual(['openai/gpt-4o']);
    expect(diff.addedByProvider.has('openai')).toBe(false);
    expect(diff.removedByProvider.size).toBe(0);
  });

  test('normalizes variant suffixes like :free', () => {
    const oldSnapshot = buildSnapshot([{ slug: 'openai', models: ['openai/gpt-4o'] }]);
    const newSnapshot = buildSnapshot([
      { slug: 'openai', models: ['openai/gpt-4o', 'openai/gpt-4o:free'] },
    ]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);

    expect(diff.addedByProvider.size).toBe(0);
    expect(diff.newModelProvidersIndex.get('openai/gpt-4o')).toEqual(new Set(['openai']));
  });

  test('sorts model ids alphabetically within each provider group', () => {
    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: [] }]);
    const newSnapshot = buildSnapshot([
      { slug: 'z-ai', models: ['z-ai/beta', 'z-ai/alpha', 'z-ai/gamma'] },
    ]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);

    expect(diff.addedByProvider.get('z-ai')).toEqual(['z-ai/alpha', 'z-ai/beta', 'z-ai/gamma']);
  });

  test('handles simultaneous additions and removals', () => {
    const oldSnapshot = buildSnapshot([
      { slug: 'z-ai', models: ['z-ai/glm-4.0', 'z-ai/glm-5'] },
      { slug: 'anthropic', models: ['anthropic/claude-4.5'] },
    ]);
    const newSnapshot = buildSnapshot([
      { slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] },
      { slug: 'anthropic', models: ['anthropic/claude-4.5', 'anthropic/claude-4.6'] },
    ]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);

    expect(diff.addedByProvider.get('z-ai')).toEqual(['z-ai/glm-5.1']);
    expect(diff.addedByProvider.get('anthropic')).toEqual(['anthropic/claude-4.6']);
    expect(diff.removedByProvider.get('z-ai')).toEqual(['z-ai/glm-4.0']);
  });
});
