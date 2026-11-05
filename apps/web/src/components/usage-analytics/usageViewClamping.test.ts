import { ALL_USAGE_VIEWS, resolveUsageView } from './useUsageDashboardState';
import { getVisibleUsageViews } from './UsageViewNavigation';

describe('resolveUsageView', () => {
  it('keeps the overview default when no options restrict the views', () => {
    expect(resolveUsageView(null, ALL_USAGE_VIEWS, 'overview')).toBe('overview');
    expect(resolveUsageView('feature-adoption', ALL_USAGE_VIEWS, 'overview')).toBe(
      'feature-adoption'
    );
    expect(resolveUsageView('ai-usage', ALL_USAGE_VIEWS, 'overview')).toBe('ai-usage');
    expect(resolveUsageView('bogus', ALL_USAGE_VIEWS, 'overview')).toBe('overview');
  });

  it('clamps adoption views to AI usage once adoption is complete', () => {
    const allowed = ['ai-usage'] as const;
    expect(resolveUsageView('overview', allowed, 'ai-usage')).toBe('ai-usage');
    expect(resolveUsageView('feature-adoption', allowed, 'ai-usage')).toBe('ai-usage');
    expect(resolveUsageView(null, allowed, 'ai-usage')).toBe('ai-usage');
    expect(resolveUsageView('ai-usage', allowed, 'ai-usage')).toBe('ai-usage');
  });
});

describe('getVisibleUsageViews', () => {
  it('shows all three views to an enterprise org that has not completed adoption', () => {
    expect(getVisibleUsageViews({})).toEqual(['overview', 'feature-adoption', 'ai-usage']);
  });

  it('shows only AI usage once adoption is complete', () => {
    expect(getVisibleUsageViews({ featureAdoptionComplete: true })).toEqual(['ai-usage']);
  });

  it('shows only AI usage for sales demo orgs', () => {
    expect(getVisibleUsageViews({ isSalesDemo: true })).toEqual(['ai-usage']);
  });
});
