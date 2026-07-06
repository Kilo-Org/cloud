import type { Meta, StoryObj } from '@storybook/nextjs';
import { EnvironmentSettings } from '@/components/deployments/EnvironmentSettings';
import { DeploymentProvider } from '@/components/deployments/DeploymentContext';
import type { DeploymentQueries, DeploymentMutations } from '@/lib/user-deployments/router-types';

// EnvironmentSettings reads env vars + mutations from DeploymentContext.
// Stories supply a fixture provider so the populated list and AlertDialog delete
// confirmation render without a backend. The full query/mutation surfaces are
// large, so only the fields this component touches are mocked and cast.
const envVars = [
  { key: 'DATABASE_URL', value: 'redacted-database-url', isSecret: true },
  { key: 'NODE_ENV', value: 'production', isSecret: false },
  { key: 'STRIPE_SECRET_KEY', value: 'redacted-stripe-secret', isSecret: true },
];

const queries = {
  listEnvVars: () => ({
    data: envVars,
    isLoading: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
} as unknown as DeploymentQueries;

const noopMutation = { mutate: () => {}, isPending: false };
const mutations = {
  setEnvVar: noopMutation,
  deleteEnvVar: noopMutation,
  renameEnvVar: noopMutation,
} as unknown as DeploymentMutations;

const meta: Meta<typeof EnvironmentSettings> = {
  title: 'Overlays/Dialogs/EnvironmentSettings',
  component: EnvironmentSettings,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    Story => (
      <DeploymentProvider queries={queries} mutations={mutations}>
        <div className="bg-background min-h-screen p-8">
          <div className="m-auto w-full max-w-3xl">
            <Story />
          </div>
        </div>
      </DeploymentProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const List: Story = {
  render: () => <EnvironmentSettings deploymentId="dep-1" />,
};

// Opens the delete confirmation AlertDialog.
export const DeleteConfirm: Story = {
  render: () => <EnvironmentSettings deploymentId="dep-1" />,
  play: async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    document.querySelector<HTMLButtonElement>('button[aria-label="Delete variable"]')?.click();
  },
};
