import type { Meta, StoryObj } from '@storybook/nextjs';
import { CreateOrganizationPage } from '@/components/organizations/new/CreateOrganizationPage';

const meta: Meta<typeof CreateOrganizationPage> = {
  title: 'Organizations/Onboarding/CreateOrganizationPage',
  component: CreateOrganizationPage,
  parameters: {
    layout: 'fullscreen',
    nextjs: {
      appDirectory: true,
      navigation: {
        pathname: '/organizations/new',
        query: {},
      },
    },
  },
  decorators: [
    Story => (
      <div className="bg-background min-h-screen p-8">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof CreateOrganizationPage>;

export const Default: Story = {
  args: {
    mockSelectedOrgName: 'Acme Corp',
  },
};
