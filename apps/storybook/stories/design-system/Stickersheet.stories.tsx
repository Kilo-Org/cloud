import type { Meta, StoryObj } from '@storybook/nextjs';

const meta: Meta = {
  title: 'Design Proposal/Stickersheet',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Full-page stickersheet proposal — draft reference, not canonical. See Drift Audit for where it conflicts with current app tokens and components.',
      },
    },
  },
  tags: ['!autodocs'],
};

export default meta;

type Story = StoryObj<typeof meta>;

function StickersheetFrame() {
  return (
    <iframe
      title="Kilo Cloud stickersheet"
      src="/stickersheet.html"
      style={{
        width: '100%',
        height: '100vh',
        border: 'none',
        display: 'block',
      }}
    />
  );
}

export const Stickersheet: Story = {
  render: () => <StickersheetFrame />,
};
