import type { Meta, StoryObj } from '@storybook/nextjs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LockableContainerProvider } from '@/contexts/LockableContainerContext';
import { LockableContainer } from '@/components/organizations/LockableContainer';
import { Label } from '@/components/ui/label';

const meta: Meta = {
  title: 'Components/Wrappers/LockableMode',
  parameters: {
    layout: 'centered',
    chromatic: { disableSnapshot: true },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const LockableMode: Story = {
  render: () => (
    <LockableContainerProvider value={{ isLocked: true, tooltipWhenLocked: 'Upgrade to enable' }}>
      <div className="flex flex-col gap-6 p-8">
        <div className="space-y-2">
          <h3 className="text-lg font-semibold">Lockable Mode (Organization Locked)</h3>
          <p className="text-muted-foreground text-sm">
            All wrapped elements are automatically disabled and show "Upgrade to enable" tooltip
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Button (wrapped)</Label>
            <LockableContainer>
              <Button>Click Me</Button>
            </LockableContainer>
          </div>

          <div className="space-y-2">
            <Label>Input (wrapped)</Label>
            <LockableContainer>
              <Input placeholder="Enter text..." />
            </LockableContainer>
          </div>

          <div className="space-y-2">
            <Label>Textarea (wrapped)</Label>
            <LockableContainer>
              <Textarea placeholder="Enter description..." />
            </LockableContainer>
          </div>

          <div className="space-y-2">
            <Label>Checkbox (wrapped)</Label>
            <div className="flex items-center space-x-2">
              <LockableContainer>
                <Checkbox id="lockable-checkbox" />
              </LockableContainer>
              <Label htmlFor="lockable-checkbox">Accept terms</Label>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Select (wrapped)</Label>
            <LockableContainer>
              <Select>
                <SelectTrigger>
                  <SelectValue placeholder="Select an option" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="option1">Option 1</SelectItem>
                  <SelectItem value="option2">Option 2</SelectItem>
                  <SelectItem value="option3">Option 3</SelectItem>
                </SelectContent>
              </Select>
            </LockableContainer>
          </div>

          <div className="space-y-2">
            <Label>Card (wrapped)</Label>
            <LockableContainer>
              <div className="rounded-lg border p-4">
                <p>This entire card is wrapped and locked</p>
                <Button className="mt-2">Action inside card</Button>
              </div>
            </LockableContainer>
          </div>
        </div>
      </div>
    </LockableContainerProvider>
  ),
};

export const UnlockedMode: Story = {
  render: () => (
    <LockableContainerProvider value={{ isLocked: false }}>
      <div className="flex flex-col gap-6 p-8">
        <div className="space-y-2">
          <h3 className="text-lg font-semibold">Unlocked Mode (Normal State)</h3>
          <p className="text-muted-foreground text-sm">
            When not locked, all elements work normally
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Button (wrapped)</Label>
            <LockableContainer>
              <Button>Click Me</Button>
            </LockableContainer>
          </div>

          <div className="space-y-2">
            <Label>Input (wrapped)</Label>
            <LockableContainer>
              <Input placeholder="Enter text..." />
            </LockableContainer>
          </div>
        </div>
      </div>
    </LockableContainerProvider>
  ),
};
