import type { Meta, StoryObj } from '@storybook/nextjs';
import {
  CostInsightsSettingsView,
  CostInsightsShellView,
  type CostInsightsSettingsData,
} from '@/components/cost-insights';
import { organizationOwner, personalOwner, settingsData } from './costInsightsFixtures';

const meta: Meta<typeof CostInsightsSettingsView> = {
  title: 'Cost Insights/Alert Settings',
  component: CostInsightsSettingsView,
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof CostInsightsSettingsView>;

function renderSettings(data: CostInsightsSettingsData) {
  const basePath =
    data.owner.type === 'organization'
      ? '/organizations/acme-cost-insights/cost-insights'
      : '/cost-insights';
  return (
    <CostInsightsShellView owner={data.owner} activePage="config" basePath={basePath}>
      <CostInsightsSettingsView data={data} />
    </CostInsightsShellView>
  );
}

export const ThresholdConfigured: Story = {
  render: () => renderSettings(settingsData()),
};

export const SevenDayThresholdOnly: Story = {
  render: () =>
    renderSettings(
      settingsData({
        thresholdUsd: '',
        threshold7DayUsd: '500.00',
        threshold30DayUsd: '',
      })
    ),
};

export const AlertsOffWithSavedOptions: Story = {
  render: () =>
    renderSettings(
      settingsData({
        enabled: false,
        thresholdUsd: '150.00',
        saveState: 'dirty',
      })
    ),
};

export const SuggestionsOff: Story = {
  render: () =>
    renderSettings(
      settingsData({
        suggestionsEnabled: false,
        saveState: 'dirty',
      })
    ),
};

export const SpendAnomaliesOff: Story = {
  render: () =>
    renderSettings(
      settingsData({
        anomalyAlertsEnabled: false,
        saveState: 'dirty',
      })
    ),
};

export const InvalidThreshold: Story = {
  render: () =>
    renderSettings(
      settingsData({
        thresholdUsd: '10.125',
        validations: {
          thresholdUsd: 'Enter a threshold with no more than two decimal places.',
        },
        saveState: 'dirty',
      })
    ),
};

export const InvalidSevenDayThreshold: Story = {
  render: () =>
    renderSettings(
      settingsData({
        threshold7DayUsd: '500.001',
        validations: {
          threshold7DayUsd: 'Enter a threshold with no more than two decimal places.',
        },
        saveState: 'dirty',
      })
    ),
};

export const Saving: Story = {
  render: () => renderSettings(settingsData({ saveState: 'saving' })),
};

export const SaveError: Story = {
  render: () => renderSettings(settingsData({ saveState: 'error' })),
};

export const AdminReadOnly: Story = {
  render: () =>
    renderSettings(
      settingsData({
        owner: { ...organizationOwner, authorizedRole: 'admin' },
        readOnly: true,
      })
    ),
};

export const Mobile: Story = {
  render: () => renderSettings(settingsData({ owner: personalOwner, saveState: 'dirty' })),
  globals: {
    viewport: { value: 'mobile2', isRotated: false },
  },
};
