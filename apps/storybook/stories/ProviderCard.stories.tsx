import type { Meta, StoryObj } from '@storybook/nextjs';
import { ProviderCard } from '@/components/models/ProviderCard';
import { mockAnthropicProvider } from '../src/mockData/providers';

const meta: Meta<typeof ProviderCard> = {
  title: 'Organizations/Models/ProviderCard',
  component: ProviderCard,
  parameters: {
    layout: 'padded',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Collapsed: Story = {
  args: {
    provider: mockAnthropicProvider,
    isExpanded: false,
    isFullySelected: false,
    isPartiallySelected: false,
    onToggleExpansion: () => {},
    onToggleProvider: () => {},
    onToggleModel: () => {},
    isModelSelected: () => false,
  },
};

export const AllowAllModels_Checked: Story = {
  args: {
    provider: mockAnthropicProvider,
    isExpanded: true,
    isFullySelected: true,
    isPartiallySelected: false,
    onToggleExpansion: () => {},
    onToggleProvider: () => {},
    onToggleModel: () => {},
    isModelSelected: () => true,
    allowAllModels: true,
  },
};

export const AllowAllModels_Unchecked: Story = {
  args: {
    provider: mockAnthropicProvider,
    isExpanded: true,
    isFullySelected: true,
    isPartiallySelected: false,
    onToggleExpansion: () => {},
    onToggleProvider: () => {},
    onToggleModel: () => {},
    isModelSelected: () => true,
    allowAllModels: false,
  },
};
