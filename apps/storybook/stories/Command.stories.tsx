import type { Meta, StoryObj } from '@storybook/nextjs';
import { Bot, CreditCard, Settings } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';

const meta: Meta<typeof Command> = {
  title: 'Components/Overlays/Command',
  component: Command,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Palette: Story = {
  render: () => (
    <Command className="w-[420px] rounded-xl border border-border">
      <CommandInput placeholder="Search commands..." />
      <CommandList>
        <CommandEmpty>No commands found.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem>
            <Bot aria-hidden="true" />
            Start cloud session
            <CommandShortcut>⌘K</CommandShortcut>
          </CommandItem>
          <CommandItem>
            <CreditCard aria-hidden="true" />
            Review usage
            <CommandShortcut>⌘U</CommandShortcut>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Settings">
          <CommandItem>
            <Settings aria-hidden="true" />
            Open organization settings
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  ),
};
