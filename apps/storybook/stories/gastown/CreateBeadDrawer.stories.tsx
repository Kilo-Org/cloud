import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import { CreateBeadDrawer } from '@/components/gastown/CreateBeadDrawer';
import { Button } from '@/components/Button';
import { withGastownTRPC } from '../../src/decorators/withGastownTRPC';

// CreateBeadDrawer renders inside a Sheet drawer. It calls
// useGastownTRPC for enrichment/create, which only fire on interaction, so the
// open shell renders under the gastown tRPC provider without network.

const meta: Meta<typeof CreateBeadDrawer> = {
  title: 'Overlays/Drawers/CreateBeadDrawer',
  component: CreateBeadDrawer,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [withGastownTRPC],
};

export default meta;
type Story = StoryObj<typeof meta>;

function CreateBeadDrawerDemo() {
  const [isOpen, setIsOpen] = useState(true);
  return (
    <div className="bg-background min-h-screen p-6">
      <Button onClick={() => setIsOpen(true)}>Open create bead</Button>
      <CreateBeadDrawer
        rigId="rig-1"
        townId="town-1"
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
      />
    </div>
  );
}

export const Default: Story = {
  render: () => <CreateBeadDrawerDemo />,
};
