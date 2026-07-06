import type { Meta, StoryObj } from '@storybook/nextjs';
import { Calendar } from '@/components/ui/calendar';

const meta: Meta = {
  title: 'Components/Forms/Calendar',
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleMonth: Story = {
  render: () => (
    <div className="rounded-xl border border-border bg-card">
      <Calendar
        mode="single"
        selected={new Date(2026, 5, 23)}
        defaultMonth={new Date(2026, 5, 1)}
        disabled={{ before: new Date(2026, 5, 10) }}
      />
    </div>
  ),
};
