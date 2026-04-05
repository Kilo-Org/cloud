import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import {
  ModelCombobox,
  type ModelComboboxProps,
  type ModelOption,
} from '@/components/shared/ModelCombobox';

// Models that demonstrate the sorting: preferred models + other models
const sortingDemoModels: ModelOption[] = [
  // Some preferred models (will appear in "Recommended" section)
  { id: 'x-ai/grok-code-fast-1', name: 'Grok Code Fast 1' },
  { id: 'anthropic/claude-opus-4.5', name: 'Claude Opus 4.5' },
  { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
  { id: 'openai/gpt-5.1', name: 'GPT-5.1' },

  // Other models (will appear in "All Models" section, sorted alphabetically)
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
  { id: 'anthropic/claude-haiku-3.5', name: 'Claude Haiku 3.5' },
  { id: 'openai/gpt-4o', name: 'GPT-4o' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
  { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
  { id: 'google/gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
  { id: 'meta/llama-3.3-70b', name: 'Llama 3.3 70B' },
];

const sampleModels: ModelOption[] = [
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
  { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4' },
  { id: 'anthropic/claude-haiku-3.5', name: 'Claude Haiku 3.5' },
  { id: 'openai/gpt-4o', name: 'GPT-4o' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
  { id: 'openai/o1', name: 'O1' },
  { id: 'openai/o1-mini', name: 'O1 Mini' },
  { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
  { id: 'google/gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
  { id: 'meta/llama-3.3-70b', name: 'Llama 3.3 70B' },
];

const organizationFilteredModels: ModelOption[] = [
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
  { id: 'openai/gpt-4o', name: 'GPT-4o' },
  { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
];

// Models demonstrating vision support icons
const visionSupportModels: ModelOption[] = [
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', supportsVision: true },
  { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4', supportsVision: true },
  { id: 'anthropic/claude-haiku-3.5', name: 'Claude Haiku 3.5', supportsVision: true },
  { id: 'openai/gpt-4o', name: 'GPT-4o', supportsVision: true },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', supportsVision: true },
  { id: 'openai/o1', name: 'O1' }, // no vision support = no icon
  { id: 'openai/o1-mini', name: 'O1 Mini' }, // no vision support = no icon
  { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash', supportsVision: true },
  { id: 'google/gemini-1.5-pro', name: 'Gemini 1.5 Pro', supportsVision: true },
  { id: 'meta/llama-3.3-70b', name: 'Llama 3.3 70B' }, // no vision support = no icon
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat' }, // no vision support = no icon
];

const manyModels: ModelOption[] = [
  // Anthropic
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
  { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4' },
  { id: 'anthropic/claude-haiku-3.5', name: 'Claude Haiku 3.5' },
  { id: 'anthropic/claude-sonnet-3.5', name: 'Claude Sonnet 3.5' },
  { id: 'anthropic/claude-opus-3', name: 'Claude Opus 3' },
  { id: 'anthropic/claude-haiku-3', name: 'Claude Haiku 3' },
  // OpenAI
  { id: 'openai/gpt-4o', name: 'GPT-4o' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
  { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
  { id: 'openai/gpt-4', name: 'GPT-4' },
  { id: 'openai/gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
  { id: 'openai/o1', name: 'O1' },
  { id: 'openai/o1-mini', name: 'O1 Mini' },
  { id: 'openai/o1-preview', name: 'O1 Preview' },
  // Google
  { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
  { id: 'google/gemini-2.0-pro', name: 'Gemini 2.0 Pro' },
  { id: 'google/gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
  { id: 'google/gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
  { id: 'google/gemini-1.0-pro', name: 'Gemini 1.0 Pro' },
  // Meta
  { id: 'meta/llama-3.3-70b', name: 'Llama 3.3 70B' },
  { id: 'meta/llama-3.2-90b', name: 'Llama 3.2 90B' },
  { id: 'meta/llama-3.2-11b', name: 'Llama 3.2 11B' },
  { id: 'meta/llama-3.1-405b', name: 'Llama 3.1 405B' },
  { id: 'meta/llama-3.1-70b', name: 'Llama 3.1 70B' },
  { id: 'meta/llama-3.1-8b', name: 'Llama 3.1 8B' },
  // Mistral
  { id: 'mistral/mistral-large', name: 'Mistral Large' },
  { id: 'mistral/mistral-medium', name: 'Mistral Medium' },
  { id: 'mistral/mistral-small', name: 'Mistral Small' },
  { id: 'mistral/codestral', name: 'Codestral' },
  { id: 'mistral/mixtral-8x22b', name: 'Mixtral 8x22B' },
  { id: 'mistral/mixtral-8x7b', name: 'Mixtral 8x7B' },
  // Cohere
  { id: 'cohere/command-r-plus', name: 'Command R+' },
  { id: 'cohere/command-r', name: 'Command R' },
  // DeepSeek
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat' },
  { id: 'deepseek/deepseek-coder', name: 'DeepSeek Coder' },
];

type StoryProps = Omit<ModelComboboxProps, 'onValueChange' | 'models'> & {
  models?: ModelComboboxProps['models'];
};

function ModelComboboxStory({ value, models = sampleModels, ...props }: StoryProps) {
  const [selected, setSelected] = useState(value);

  return (
    <div className="max-w-md space-y-3">
      <ModelCombobox {...props} models={models} value={selected} onValueChange={setSelected} />
      {selected && (
        <p className="text-muted-foreground text-xs">
          Selected: <span className="font-mono">{selected}</span>
        </p>
      )}
    </div>
  );
}

const meta: Meta<typeof ModelComboboxStory> = {
  title: 'Shared/ModelCombobox',
  component: ModelComboboxStory,
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
      description: 'Placeholder text when no model is selected',
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
      description: 'Text displayed when models array is empty',
    },
    loadingText: {
      control: 'text',
      description: 'Text displayed during loading state',
    },
    required: {
      control: 'boolean',
      description: 'Whether the field is required',
    },
    isLoading: {
      control: 'boolean',
      description: 'Whether the component is in a loading state',
    },
    error: {
      control: 'text',
      description: 'Error message to display',
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
    disabled: {
      control: 'boolean',
      description: 'Whether the combobox is disabled',
    },
  },
};

export default meta;

type Story = StoryObj<typeof ModelComboboxStory>;

export const Default: Story = {
  args: {
    models: sampleModels,
  },
};

export const PreferredSorting: Story = {
  args: {
    models: sortingDemoModels,
    helperText:
      'Demonstrates sorting: Recommended models at top (in preferred order), then All Models (alphabetical)',
  },
};

export const WithSelection: Story = {
  args: {
    models: sampleModels,
    value: 'anthropic/claude-sonnet-4',
  },
};

export const Loading: Story = {
  args: {
    models: sampleModels,
    isLoading: true,
  },
};

export const Error: Story = {
  args: {
    models: sampleModels,
    error: 'Failed to load models. Please try again.',
  },
};

export const Disabled: Story = {
  args: {
    models: sampleModels,
    disabled: true,
    value: 'anthropic/claude-sonnet-4',
    helperText: 'This combobox is disabled',
  },
};

export const Empty: Story = {
  args: {
    models: [],
    emptyStateText: 'No models available based on your organization settings',
  },
};

export const OrganizationFiltered: Story = {
  args: {
    models: organizationFilteredModels,
    helperText: 'Only models allowed by your organization are shown',
  },
};

export const UserContext: Story = {
  args: {
    models: manyModels,
    helperText: 'All available models',
  },
};

export const ManyModels: Story = {
  args: {
    models: manyModels,
    helperText: 'Try searching to filter the long list',
  },
};

export const Required: Story = {
  args: {
    models: sampleModels,
    required: true,
    helperText: 'This field is required',
  },
};

export const CustomLabels: Story = {
  args: {
    models: sampleModels,
    label: 'Default AI Model',
    placeholder: 'Choose a model...',
    searchPlaceholder: 'Type to filter...',
    noResultsText: 'No matching models found',
    helperText: 'Select the model that will be used by default',
  },
};

export const VisionSupport: Story = {
  args: {
    models: visionSupportModels,
    helperText: 'Models with vision support show an image icon next to their name',
  },
};

// Compact variant stories - for inline use (e.g., chat footer)
export const Compact: Story = {
  args: {
    models: sampleModels,
    variant: 'compact',
    value: 'anthropic/claude-sonnet-4',
  },
  decorators: [
    Story => (
      <div className="flex items-center gap-4 rounded-lg bg-zinc-900 p-4">
        <span className="text-muted-foreground text-sm">Inline context:</span>
        <Story />
      </div>
    ),
  ],
};

export const CompactStates: Story = {
  args: {
    models: sampleModels,
    variant: 'compact',
  },
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4 rounded-lg bg-zinc-900 p-4">
        <span className="text-muted-foreground w-20 text-sm">Loading:</span>
        <ModelCombobox models={[]} variant="compact" isLoading onValueChange={() => {}} />
      </div>
      <div className="flex items-center gap-4 rounded-lg bg-zinc-900 p-4">
        <span className="text-muted-foreground w-20 text-sm">Error:</span>
        <ModelCombobox
          models={[]}
          variant="compact"
          error="Failed to load"
          onValueChange={() => {}}
        />
      </div>
      <div className="flex items-center gap-4 rounded-lg bg-zinc-900 p-4">
        <span className="text-muted-foreground w-20 text-sm">Empty:</span>
        <ModelCombobox models={[]} variant="compact" onValueChange={() => {}} />
      </div>
      <div className="flex items-center gap-4 rounded-lg bg-zinc-900 p-4">
        <span className="text-muted-foreground w-20 text-sm">Disabled:</span>
        <ModelCombobox
          models={sampleModels}
          variant="compact"
          value="anthropic/claude-sonnet-4"
          disabled
          onValueChange={() => {}}
        />
      </div>
    </div>
  ),
};
