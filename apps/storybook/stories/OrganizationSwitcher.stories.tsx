import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import {
  OrganizationSwitcherView,
  type OrganizationSwitcherOrganization,
} from '@/app/(app)/components/OrganizationSwitcher';

type OrganizationSwitcherStoryProps = {
  organizationId?: string | null;
  isPending?: boolean;
};

const organizations: OrganizationSwitcherOrganization[] = [
  {
    organizationId: 'org-kilo',
    organizationName: 'Kilo Code',
    role: 'owner',
  },
  {
    organizationId: 'org-design',
    organizationName: 'Design Systems',
    role: 'member',
  },
  {
    organizationId: 'org-cloud',
    organizationName: 'Cloud Platform',
    role: 'member',
  },
];

function OrganizationSwitcherStory({
  organizationId: initialOrganizationId = null,
  isPending = false,
}: OrganizationSwitcherStoryProps) {
  const [organizationId, setOrganizationId] = useState(initialOrganizationId);

  return (
    <div className="bg-background p-6">
      <div className="bg-sidebar text-sidebar-foreground w-64 rounded-lg p-4">
        <OrganizationSwitcherView
          organizationId={organizationId}
          organizations={organizations}
          isPending={isPending}
          onOrganizationSwitch={setOrganizationId}
        />
      </div>
    </div>
  );
}

const meta = {
  title: 'Components/Layout/OrganizationSwitcher',
  component: OrganizationSwitcherStory,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof OrganizationSwitcherStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PersonalSelected: Story = {
  args: {
    organizationId: null,
  },
};

export const OrganizationSelected: Story = {
  args: {
    organizationId: 'org-kilo',
  },
};

export const Loading: Story = {
  args: {
    isPending: true,
  },
};
