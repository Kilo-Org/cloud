import { createDefaultCodeReviewConfig } from './default-config';

describe('createDefaultCodeReviewConfig', () => {
  it('overrides analytics state for analytics-created rows', () => {
    expect(createDefaultCodeReviewConfig({ reviewAnalyticsEnabled: true })).toMatchObject({
      review_analytics_enabled: true,
    });
  });
});
