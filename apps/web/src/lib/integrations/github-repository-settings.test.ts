import { describe, expect, it } from '@jest/globals';
import { resolveRepositorySettings } from './github-repository-settings';

describe('resolveRepositorySettings', () => {
  it('uses the installation default model and review mode when there is no override', () => {
    const settings = resolveRepositorySettings({
      metadata: { model_slug: 'model-a', pr_review_mode: 'on' },
    });

    expect(settings).toEqual({ modelSlug: 'model-a', prReviewMode: 'on' });
  });

  it('applies a repository override independently per field', () => {
    const settings = resolveRepositorySettings(
      { metadata: { model_slug: 'model-a', pr_review_mode: 'on' } },
      { bot_mention_model_slug: 'model-b', pr_review_mode: null }
    );

    // model overridden; review mode still inherits the installation default.
    expect(settings).toEqual({ modelSlug: 'model-b', prReviewMode: 'on' });
  });

  it('falls back to the bot default model when the installation has none set', () => {
    const settings = resolveRepositorySettings({ metadata: {} });

    expect(settings.modelSlug).toBeTruthy();
  });

  it('fails closed to off when the installation has no recognized review mode', () => {
    expect(resolveRepositorySettings({ metadata: {} }).prReviewMode).toBe('off');
    expect(resolveRepositorySettings({ metadata: { pr_review_mode: 'manual' } }).prReviewMode).toBe(
      'off'
    );
    expect(resolveRepositorySettings({ metadata: null }).prReviewMode).toBe('off');
  });

  it('treats a JSON literal null metadata the same as SQL null', () => {
    // Some legacy rows may have stored the JSON literal `null` rather than SQL NULL.
    const settings = resolveRepositorySettings({ metadata: null });

    expect(settings.prReviewMode).toBe('off');
  });
});
