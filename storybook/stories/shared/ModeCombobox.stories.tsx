import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import {
  ModeCombobox,
  LEGACY_MODE_OPTIONS,
  type ModeComboboxProps,
} from '@/components/shared/ModeCombobox';
import type { AgentMode } from '@/components/cloud-agent/types';

type StoryProps = Omit<ModeComboboxProps<AgentMode>, 'onValueChange' | 'options'>;

function ModeComboboxStory({ value = 'code', ...props }: StoryProps) {
  const [selected, setSelected] = useState<AgentMode>(value);

  return (
    <div className="max-w-md space-y-3">
      <ModeCombobox
        {...props}
        value={selected}
        onValueChange={setSelected}
        options={LEGACY_MODE_OPTIONS}
      />
      {selected && (
        <p className="text-muted-foreground text-xs">
          Selected: <span className="font-mono">{selected}</span>
        </p>
      )}
    </div>
  );
}

const meta: Meta<typeof ModeComboboxStory> = {
  title: 'Shared/ModeCombobox',
  component: ModeComboboxStory,
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
      description: 'Placeholder text when no mode is selected',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the combobox is disabled',
    },
    isLoading: {
      control: 'boolean',
      description: 'Whether the component is in a loading state',
    },
    variant: {
      control: 'select',
      options: ['full', 'compact'],
      description: 'Variant style - full (default) or compact for inline use',
    },
    className: {
      control: 'text',
      description: 'Optional className for the trigger button',
    },
  },
};

export default meta;

type Story = StoryObj<typeof ModeComboboxStory>;

export const Default: Story = {
  args: {},
};

export const WithSelection: Story = {
  args: {
    value: 'architect',
  },
};

export const CodeMode: Story = {
  args: {
    value: 'code',
    helperText: 'Write and modify code',
  },
};

export const ArchitectMode: Story = {
  args: {
    value: 'architect',
    helperText: 'Plan and design solutions',
  },
};

export const AskMode: Story = {
  args: {
    value: 'ask',
    helperText: 'Get answers and explanations',
  },
};

export const DebugMode: Story = {
  args: {
    value: 'debug',
    helperText: 'Find and fix issues',
  },
};

export const OrchestratorMode: Story = {
  args: {
    value: 'orchestrator',
    helperText: 'Coordinate complex tasks',
  },
};

export const Loading: Story = {
  args: {
    isLoading: true,
  },
};

export const Disabled: Story = {
  args: {
    value: 'code',
    disabled: true,
  },
};

export const CustomLabels: Story = {
  args: {
    label: 'Agent Mode',
    placeholder: 'Choose a mode...',
    helperText: 'Select how the agent should operate',
  },
};

// Compact variant stories - for inline use (e.g., chat footer toolbar)
export const Compact: Story = {
  args: {
    value: 'code',
    variant: 'compact',
  },
  decorators: [
    Story => (
      <div className="flex items-center gap-4 rounded-lg bg-zinc-900 p-4">
        <span className="text-muted-foreground text-sm">Chat toolbar context:</span>
        <Story />
      </div>
    ),
  ],
};

export const CompactAllModes: Story = {
  args: {
    variant: 'compact',
  },
  render: () => {
    const modes: AgentMode[] = ['code', 'architect', 'ask', 'debug', 'orchestrator'];
    return (
      <div className="flex flex-col gap-4">
        {modes.map(mode => (
          <div key={mode} className="flex items-center gap-4 rounded-lg bg-zinc-900 p-4">
            <span className="text-muted-foreground w-24 text-sm capitalize">{mode}:</span>
            <ModeCombobox
              value={mode}
              variant="compact"
              onValueChange={() => {}}
              options={LEGACY_MODE_OPTIONS}
            />
          </div>
        ))}
      </div>
    );
  },
};

export const CompactDisabled: Story = {
  args: {
    value: 'code',
    variant: 'compact',
    disabled: true,
  },
  decorators: [
    Story => (
      <div className="flex items-center gap-4 rounded-lg bg-zinc-900 p-4">
        <span className="text-muted-foreground text-sm">Disabled state:</span>
        <Story />
      </div>
    ),
  ],
};

export const CompactLoading: Story = {
  args: {
    variant: 'compact',
    isLoading: true,
  },
  decorators: [
    Story => (
      <div className="flex items-center gap-4 rounded-lg bg-zinc-900 p-4">
        <span className="text-muted-foreground text-sm">Loading state:</span>
        <Story />
      </div>
    ),
  ],
};
