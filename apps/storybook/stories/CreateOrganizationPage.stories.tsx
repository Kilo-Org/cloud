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
      <div className="bg-background min-h-screen">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof CreateOrganizationPage>;

export const Empty: Story = {
  globals: {
    viewport: { value: 'desktop', isRotated: false },
  },
};

export const Prefilled: Story = {
  args: {
    initialOrganizationName: 'Acme Engineering',
  },
  globals: {
    viewport: { value: 'desktop', isRotated: false },
  },
};

export const Mobile: Story = {
  globals: {
    viewport: { value: 'mobile2', isRotated: false },
  },
};
