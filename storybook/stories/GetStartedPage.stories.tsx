import type { Meta, StoryObj } from '@storybook/nextjs';
import { GetStartedPage } from '@/components/auth/GetStartedPage';

const meta: Meta<typeof GetStartedPage> = {
  title: 'Auth/GetStartedPage',
  component: GetStartedPage,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    title: 'Get Started with Kilo Code',
    callbackPath: '/organizations/new',
    searchParams: {},
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {
  globals: {
    viewport: { value: 'desktop', isRotated: false },
  },
};

export const Mobile: Story = {
  globals: {
    viewport: { value: 'mobile2', isRotated: false },
  },
};
