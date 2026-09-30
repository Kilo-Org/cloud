import { createDefaultCodeReviewConfig } from './default-config';

const modelSlug = 'vendor/default-model';

describe('createDefaultCodeReviewConfig', () => {
  it('returns the canonical Code Reviewer defaults', () => {
    expect(createDefaultCodeReviewConfig({ modelSlug })).toEqual({
      review_style: 'balanced',
      focus_areas: [],
      custom_instructions: null,
      model_slug: modelSlug,
      thinking_effort: null,
      gate_threshold: 'off',
      repository_selection_mode: 'all',
      selected_repository_ids: [],
      manually_added_repositories: [],
      disable_review_md: true,
      review_memory_enabled: false,
      review_analytics_enabled: false,
    });
  });

  it('overrides analytics state for analytics-created rows', () => {
    expect(
      createDefaultCodeReviewConfig({ modelSlug, reviewAnalyticsEnabled: true })
    ).toMatchObject({
      review_analytics_enabled: true,
    });
  });
});
