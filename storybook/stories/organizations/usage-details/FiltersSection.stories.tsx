import type { Meta, StoryObj } from '@storybook/nextjs';
import { FiltersSection } from '@/components/organizations/usage-details/FiltersSection';
import { mockTimeseriesData } from '../../../src/mockData/usage-details';

const meta: Meta<typeof FiltersSection> = {
  title: 'Organizations/UsageDetails/FiltersSection',
  component: FiltersSection,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    Story => (
      <div className="bg-background min-h-screen p-8">
        <div className="m-auto w-full max-w-[1140px]">
          <Story />
        </div>
      </div>
    ),
  ],
  args: {
    selectedMetric: 'cost',
    timeseriesData: mockTimeseriesData,
    filteredTimeseriesData: mockTimeseriesData,
    activeFilters: [],
    onFilter: (subType, value) => {
      console.log('Filter clicked:', subType, value);
    },
    onExclude: (subType, value) => {
      console.log('Exclude clicked:', subType, value);
    },
  },
};

export default meta;
type Story = StoryObj<typeof FiltersSection>;

export const Default: Story = {};
