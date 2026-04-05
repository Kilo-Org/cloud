import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import {
  BranchCombobox,
  type BranchComboboxProps,
  type BranchOption,
} from '@/components/shared/BranchCombobox';

const mockBranches: BranchOption[] = [
  { name: 'main', isDefault: true },
  { name: 'develop', isDefault: false },
  { name: 'feature/user-auth', isDefault: false },
  { name: 'feature/new-dashboard', isDefault: false },
  { name: 'bugfix/login-issue', isDefault: false },
  { name: 'release/v2.0.0', isDefault: false },
];

const manyBranches: BranchOption[] = [
  { name: 'main', isDefault: true },
  { name: 'develop', isDefault: false },
  { name: 'staging', isDefault: false },
  { name: 'feature/user-auth', isDefault: false },
  { name: 'feature/new-dashboard', isDefault: false },
  { name: 'feature/api-refactor', isDefault: false },
  { name: 'feature/payment-integration', isDefault: false },
  { name: 'feature/notification-system', isDefault: false },
  { name: 'feature/search-optimization', isDefault: false },
  { name: 'feature/mobile-responsive', isDefault: false },
  { name: 'bugfix/login-issue', isDefault: false },
  { name: 'bugfix/data-sync', isDefault: false },
  { name: 'bugfix/memory-leak', isDefault: false },
  { name: 'hotfix/security-patch', isDefault: false },
  { name: 'release/v1.0.0', isDefault: false },
  { name: 'release/v1.1.0', isDefault: false },
  { name: 'release/v2.0.0', isDefault: false },
];

type StoryProps = Omit<BranchComboboxProps, 'onValueChange' | 'branches'> & {
  branches?: BranchComboboxProps['branches'];
};

function BranchComboboxStory({ value, branches = mockBranches, ...props }: StoryProps) {
  const [selected, setSelected] = useState(value);

  return (
    <div className="max-w-md space-y-3">
      <BranchCombobox {...props} branches={branches} value={selected} onValueChange={setSelected} />
      {selected && (
        <p className="text-muted-foreground text-xs">
          Selected: <span className="font-mono">{selected}</span>
        </p>
      )}
    </div>
  );
}

const meta: Meta<typeof BranchComboboxStory> = {
  title: 'Shared/BranchCombobox',
  component: BranchComboboxStory,
  tags: ['autodocs'],
  argTypes: {
    label: {
      control: 'text',
      description: 'Label text displayed above the combobox',
    },
    helperText: {
      control: 'text',
      description: 'Helper text displayed below the combobox',
    },
    placeholder: {
      control: 'text',
      description: 'Placeholder text when no branch is selected',
    },
    searchPlaceholder: {
      control: 'text',
      description: 'Placeholder text in the search input',
    },
    noResultsText: {
      control: 'text',
      description: 'Text displayed when search yields no results',
    },
    emptyStateText: {
      control: 'text',
      description: 'Text displayed when branches array is empty',
    },
    loadingText: {
      control: 'text',
      description: 'Text displayed during loading state',
    },
    required: {
      control: 'boolean',
      description: 'Whether the field is required',
    },
    hideLabel: {
      control: 'boolean',
      description: 'Whether to hide the label',
    },
    isLoading: {
      control: 'boolean',
      description: 'Whether the component is in a loading state',
    },
    error: {
      control: 'text',
      description: 'Error message to display',
    },
  },
};

export default meta;

type Story = StoryObj<typeof BranchComboboxStory>;

export const Default: Story = {
  args: {
    branches: mockBranches,
  },
};

export const WithSelection: Story = {
  args: {
    branches: mockBranches,
    value: 'main',
  },
};

export const WithNonDefaultSelection: Story = {
  args: {
    branches: mockBranches,
    value: 'feature/user-auth',
  },
};

export const Loading: Story = {
  args: {
    branches: mockBranches,
    isLoading: true,
  },
};

export const Error: Story = {
  args: {
    branches: mockBranches,
    error: 'Unable to connect to GitHub',
  },
};

export const Empty: Story = {
  args: {
    branches: [],
  },
};

export const ManyBranches: Story = {
  args: {
    branches: manyBranches,
    helperText: 'Try searching to filter the long list',
  },
};

export const Required: Story = {
  args: {
    branches: mockBranches,
    required: true,
    helperText: 'This field is required',
  },
};

export const Optional: Story = {
  args: {
    branches: mockBranches,
    required: false,
    helperText: 'Optionally select a branch',
  },
};

export const HiddenLabel: Story = {
  args: {
    branches: mockBranches,
    hideLabel: true,
  },
};

export const CustomLabels: Story = {
  args: {
    branches: mockBranches,
    label: 'Deploy Branch',
    placeholder: 'Choose a branch...',
    searchPlaceholder: 'Type to filter branches...',
    noResultsText: 'No matching branches found',
    helperText: 'Select the branch to deploy from',
  },
};

export const SingleBranch: Story = {
  args: {
    branches: [{ name: 'main', isDefault: true }],
    helperText: 'Repository has only one branch',
  },
};
