import type { Meta, StoryObj } from '@storybook/nextjs';
import {
  GitHubRepositoryCustomizationsPreview,
  type PreviewInstallation,
  type PreviewReviewMode,
} from '@/components/integrations/GitHubRepositoryCustomizationsPreview';
import type { ModelOption } from '@/components/shared/ModelCombobox';

const models: ModelOption[] = [
  { id: 'kilo-auto/frontier', name: 'Auto Frontier' },
  { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
  { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6' },
  { id: 'openai/gpt-5.2', name: 'GPT-5.2' },
  { id: 'google/gemini-3-pro-preview', name: 'Gemini 3 Pro' },
].map(model => ({ ...model, showGatewayMetadata: false }));

const repositoryNames = [
  'api',
  'billing-service',
  'cli',
  'cloud',
  'design-system',
  'docs',
  'event-pipeline',
  'examples',
  'frontend',
  'github-bot',
  'infrastructure',
  'integrations',
  'internal-tools',
  'mobile',
  'observability',
  'payments',
  'platform',
  'sdk',
  'search',
  'security',
  'shared-components',
  'status-page',
  'terraform-modules',
  'webhooks',
];

const repositoryOverrides: Partial<Record<string, string>> = {
  api: 'anthropic/claude-opus-4.6',
  cli: 'openai/gpt-5.2',
  docs: 'kilo-auto/frontier',
  frontend: 'google/gemini-3-pro-preview',
};

const reviewOverrides: Partial<Record<string, PreviewReviewMode>> = {
  api: 'manual',
  'billing-service': 'on',
  docs: 'off',
  examples: 'off',
};

const installations: PreviewInstallation[] = [
  {
    id: 'acme',
    account: 'acme',
    access: 'all',
    defaultModel: 'kilo-auto/frontier',
    defaultPrReviews: 'on',
    repositories: repositoryNames.map(name => ({
      id: `acme/${name}`,
      name: `acme/${name}`,
      private: !['cli', 'docs', 'examples', 'sdk'].includes(name),
      model: repositoryOverrides[name] ?? null,
      prReviews: reviewOverrides[name] ?? null,
    })),
  },
  {
    id: 'acme-labs',
    account: 'acme-labs',
    access: 'selected',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    defaultPrReviews: 'manual',
    repositories: ['agent-experiments', 'benchmarks', 'playground', 'research'].map(name => ({
      id: `acme-labs/${name}`,
      name: `acme-labs/${name}`,
      private: name !== 'playground',
      model: null,
      prReviews: null,
    })),
  },
];

const meta = {
  title: 'Prototypes/GitHub Repository Customizations',
  component: GitHubRepositoryCustomizationsPreview,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    scope: 'personal',
    organizationName: 'Acme team',
    models,
    installations,
  },
  argTypes: {
    scope: {
      control: 'inline-radio',
      options: ['personal', 'organization'],
    },
  },
} satisfies Meta<typeof GitHubRepositoryCustomizationsPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Personal: Story = {};

export const Organization: Story = {
  args: {
    scope: 'organization',
  },
};
