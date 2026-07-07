import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs';
import {
  CostInsightsAskKiloView,
  CostInsightsDashboardView,
  CostInsightsShellView,
  type CostInsightsDashboardData,
  type CostInsightsPage,
} from '@/components/cost-insights';
import {
  anomalyAlert,
  anomalyMetrics,
  codingPlanSuggestion,
  dashboardData,
  emptyDashboardData,
  evidenceAnomaly,
  kiloPassSuggestion,
  longLabelDrivers,
  organizationOwner,
  spendDriversByRange,
  threshold7DayAlert,
  thresholdAlert,
} from './costInsightsFixtures';

const meta: Meta<typeof CostInsightsDashboardView> = {
  title: 'Cost Insights/Overview',
  component: CostInsightsDashboardView,
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof CostInsightsDashboardView>;

type OverviewStoryOptions = {
  isLoading?: boolean;
  isError?: boolean;
  attention?: 'none' | 'alert';
  pendingSuggestionId?: string;
};

function CostInsightsOverviewStory({
  data,
  options = {},
  initialPage = 'dashboard',
}: {
  data: CostInsightsDashboardData;
  options?: OverviewStoryOptions;
  initialPage?: CostInsightsPage;
}) {
  const [activePage, setActivePage] = useState<CostInsightsPage>(initialPage);

  const basePath =
    data.owner.type === 'organization'
      ? '/organizations/acme-cost-insights/cost-insights'
      : '/cost-insights';

  return (
    <CostInsightsShellView
      owner={data.owner}
      activePage={activePage}
      attention={options.attention ?? (data.alerts.length > 0 ? 'alert' : 'none')}
      basePath={basePath}
      onPageChange={setActivePage}
    >
      {activePage === 'ask' ? (
        <CostInsightsAskKiloView />
      ) : (
        <CostInsightsDashboardView
          data={data}
          isLoading={options.isLoading}
          isError={options.isError}
          activityHref={`${basePath}/activity`}
          pendingSuggestionId={options.pendingSuggestionId}
        />
      )}
    </CostInsightsShellView>
  );
}

function renderDashboard(data: CostInsightsDashboardData, options: OverviewStoryOptions = {}) {
  return <CostInsightsOverviewStory data={data} options={options} />;
}

export const PersonalOverview: Story = {
  render: () => renderDashboard(dashboardData()),
};

export const AlertsNotSetUp: Story = {
  render: () =>
    renderDashboard(
      dashboardData({
        enabled: false,
        alerts: [],
      })
    ),
};

export const NoSpendYet: Story = {
  render: () => renderDashboard(emptyDashboardData()),
};

export const AlertsNeedReview: Story = {
  render: () =>
    renderDashboard(
      dashboardData({
        alerts: [anomalyAlert, thresholdAlert],
        metrics: anomalyMetrics(),
        evidence: evidenceAnomaly,
      }),
      { attention: 'alert' }
    ),
};

export const SevenDayThresholdAlert: Story = {
  render: () =>
    renderDashboard(dashboardData({ alerts: [threshold7DayAlert] }), { attention: 'alert' }),
};

export const KiloPassSuggestion: Story = {
  render: () => renderDashboard(dashboardData({ suggestions: [kiloPassSuggestion] })),
};

export const CodingPlanSuggestion: Story = {
  render: () => renderDashboard(dashboardData({ suggestions: [codingPlanSuggestion] })),
};

export const SuggestionDismissPending: Story = {
  render: () =>
    renderDashboard(dashboardData({ suggestions: [kiloPassSuggestion] }), {
      pendingSuggestionId: kiloPassSuggestion.id,
    }),
};

export const AlertAndSuggestion: Story = {
  render: () =>
    renderDashboard(
      dashboardData({
        alerts: [anomalyAlert],
        suggestions: [kiloPassSuggestion],
        metrics: anomalyMetrics(),
        evidence: evidenceAnomaly,
      }),
      { attention: 'alert' }
    ),
};

export const ReadOnlyAdmin: Story = {
  render: () =>
    renderDashboard(
      dashboardData({
        owner: { ...organizationOwner, authorizedRole: 'admin' },
        alerts: [thresholdAlert],
        suggestions: [kiloPassSuggestion],
        metrics: anomalyMetrics(),
      }),
      { attention: 'alert' }
    ),
};

export const Loading: Story = {
  render: () => renderDashboard(dashboardData(), { isLoading: true }),
};

export const LoadError: Story = {
  render: () => renderDashboard(dashboardData(), { isError: true }),
};

export const MobileOrganizationOverview: Story = {
  render: () =>
    renderDashboard(
      dashboardData({
        owner: organizationOwner,
        driversByRange: spendDriversByRange(longLabelDrivers),
        memberLimitsHref: '/organizations/acme/members/limits',
      })
    ),
  globals: {
    viewport: { value: 'mobile2', isRotated: false },
  },
};
