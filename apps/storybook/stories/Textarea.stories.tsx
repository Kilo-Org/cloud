import type { Meta, StoryObj } from '@storybook/nextjs';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

const meta: Meta<typeof Textarea> = {
  title: 'Components/Forms/Textarea',
  component: Textarea,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="w-64 space-y-2">
      <Label>Description</Label>
      <Textarea placeholder="Enter a description" />
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="w-64 space-y-2">
      <Label>Disabled Textarea</Label>
      <Textarea placeholder="This textarea is disabled" disabled />
    </div>
  ),
};

export const FocusVisible: Story = {
  render: () => (
    <div className="w-80 space-y-2">
      <Label htmlFor="textarea-focus">Review notes</Label>
      <Textarea
        id="textarea-focus"
        defaultValue="Summarize token drift before handoff."
        className="border-ring ring-ring/50 ring-[3px]"
      />
    </div>
  ),
};

export const Invalid: Story = {
  render: () => (
    <div className="w-80 space-y-2">
      <Label htmlFor="textarea-invalid">Run notes</Label>
      <Textarea
        id="textarea-invalid"
        defaultValue="Needs more context."
        aria-invalid
        aria-describedby="textarea-invalid-error"
      />
      <p id="textarea-invalid-error" className="type-label text-status-destructive">
        Add enough context for reviewer handoff.
      </p>
    </div>
  ),
};
