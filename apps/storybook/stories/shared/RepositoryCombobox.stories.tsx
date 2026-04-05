import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import {
  RepositoryCombobox,
  type RepositoryComboboxProps,
} from '@/components/shared/RepositoryCombobox';

const mockRepositories = [
  { id: 1, fullName: 'kilocode/platform', private: true },
  { id: 2, fullName: 'kilocode/frontend', private: false },
  { id: 3, fullName: 'kilocode/mobile', private: true },
  { id: 4, fullName: 'kilocode/devops', private: false },
  { id: 5, fullName: 'kilocode/experimental', private: true },
];

type StoryProps = Omit<RepositoryComboboxProps, 'onValueChange' | 'repositories'> & {
  repositories?: RepositoryComboboxProps['repositories'];
};

function RepositoryComboboxStory({ value, repositories = mockRepositories, ...props }: StoryProps) {
  const [selected, setSelected] = useState(value);

  return (
    <div className="max-w-md space-y-3">
      <RepositoryCombobox
        {...props}
        repositories={repositories}
        value={selected}
        onValueChange={setSelected}
      />
      {selected && (
        <p className="text-muted-foreground text-xs">
          Selected: <span className="font-mono">{selected}</span>
        </p>
      )}
    </div>
  );
}

const meta: Meta<typeof RepositoryComboboxStory> = {
  title: 'Shared/RepositoryCombobox',
  component: RepositoryComboboxStory,
  tags: ['autodocs'],
};

export default meta;

type Story = StoryObj<typeof RepositoryComboboxStory>;

export const Default: Story = {
  args: {
    repositories: mockRepositories,
  },
};

export const Loading: Story = {
  args: {
    repositories: mockRepositories,
    isLoading: true,
  },
};

export const ErrorState: Story = {
  args: {
    repositories: mockRepositories,
    error: 'Failed to reach GitHub',
  },
};

export const Empty: Story = {
  args: {
    repositories: [],
  },
};
