import type { ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs';

import { AnalyticsBreakdownBars } from '@/components/code-reviews/analytics/AnalyticsBreakdownBars';

type AnalyticsBreakdownBarsArgs = ComponentProps<typeof AnalyticsBreakdownBars>;

const populatedArgs = {
  impactBreakdown: {
    impact: {
      low: 5,
      medium: 11,
      high: 6,
      unclassified: 2,
    },
    complexity: [
      { value: 'high', count: 6, lowConfidenceCount: 1 },
      { value: 'low', count: 8, lowConfidenceCount: 0 },
      { value: 'medium', count: 10, lowConfidenceCount: 1 },
    ],
    changeTypes: [
      { value: 'feature', count: 5, lowConfidenceCount: 1 },
      { value: 'documentation', count: 1, lowConfidenceCount: 0 },
      { value: 'bug_fix', count: 5, lowConfidenceCount: 0 },
      { value: 'other', count: 1, lowConfidenceCount: 0 },
      { value: 'refactor', count: 4, lowConfidenceCount: 0 },
      { value: 'test', count: 2, lowConfidenceCount: 0 },
      { value: 'maintenance', count: 3, lowConfidenceCount: 1 },
      { value: 'mixed', count: 1, lowConfidenceCount: 0 },
      { value: 'dependency', count: 2, lowConfidenceCount: 0 },
    ],
  },
  modelBreakdown: [
    {
      model: 'anthropic/claude-sonnet-4.6',
      trackedReviews: 14,
      totalFindings: 18,
      criticalFindings: 4,
      warningFindings: 10,
      suggestionFindings: 4,
    },
    {
      model: 'openai/gpt-5.1',
      trackedReviews: 10,
      totalFindings: 13,
      criticalFindings: 1,
      warningFindings: 7,
      suggestionFindings: 5,
    },
  ],
  findingBreakdown: [
    { value: 'correctness', total: 10, critical: 1, warning: 6, suggestion: 3 },
    { value: 'security', total: 6, critical: 2, warning: 3, suggestion: 1 },
    { value: 'reliability', total: 5, critical: 0, warning: 4, suggestion: 1 },
    { value: 'maintainability', total: 4, critical: 0, warning: 1, suggestion: 3 },
    { value: 'performance', total: 3, critical: 0, warning: 2, suggestion: 1 },
    { value: 'test_quality', total: 2, critical: 0, warning: 0, suggestion: 2 },
    { value: 'data_integrity', total: 1, critical: 1, warning: 0, suggestion: 0 },
  ],
  securityBreakdown: [
    { value: 'auth_access', total: 2, critical: 1, warning: 1, suggestion: 0 },
    { value: 'injection', total: 2, critical: 1, warning: 1, suggestion: 0 },
    {
      value: 'dependency_supply_chain',
      total: 1,
      critical: 0,
      warning: 0,
      suggestion: 1,
    },
    {
      value: 'request_resource_boundary',
      total: 1,
      critical: 0,
      warning: 1,
      suggestion: 0,
    },
  ],
} satisfies AnalyticsBreakdownBarsArgs;

const emptyOptionalDataArgs = {
  impactBreakdown: {
    impact: {
      low: 0,
      medium: 0,
      high: 0,
      unclassified: 0,
    },
    complexity: [],
    changeTypes: [],
  },
  modelBreakdown: [],
  findingBreakdown: [],
  securityBreakdown: [],
} satisfies AnalyticsBreakdownBarsArgs;

const meta = {
  title: 'Code Reviews/Analytics/AnalyticsBreakdownBars',
  component: AnalyticsBreakdownBars,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    Story => (
      <div className="bg-background min-h-screen p-4 md:p-6">
        <div className="mx-auto w-full max-w-[1140px]">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof AnalyticsBreakdownBars>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  args: populatedArgs,
};

export const EmptyOptionalData: Story = {
  args: emptyOptionalDataArgs,
};
