import type { Meta, StoryObj } from '@storybook/nextjs';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

const meta: Meta = {
  title: 'Components/Layout/Accordion',
  parameters: {
    layout: 'centered',
  },
  decorators: [
    Story => (
      <div className="w-[420px] rounded-xl border border-border bg-card p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Accordion type="single" defaultValue="billing" collapsible>
      <AccordionItem value="billing">
        <AccordionTrigger>Billing safeguards</AccordionTrigger>
        <AccordionContent>
          Seats, credits, and usage limits stay visible before changes are applied.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="automation">
        <AccordionTrigger>Automation controls</AccordionTrigger>
        <AccordionContent>
          Agents can run safely with explicit review gates and narrow permissions.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="audit">
        <AccordionTrigger disabled>Disabled audit item</AccordionTrigger>
        <AccordionContent>This section cannot be opened.</AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
};
