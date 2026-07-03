import type { Meta, StoryObj } from '@storybook/nextjs';
import { PositionPicker, BugReportMenu } from '@/components/gastown/TerminalBar';

// PositionPicker (Radix Popover) and BugReportMenu (Radix DropdownMenu) are the
// gastown terminal-bar overlays. Each renders its own trigger; the stories open
// the overlay via a play function so the screenshot captures the open state.

const meta: Meta = {
  title: 'Overlays/Popovers/TerminalBarPickers',
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj;

// Radix menu/popover triggers open on pointerdown, not a bare click.
function openByPointer(el: Element | null | undefined) {
  if (!el) return;
  const opts = { bubbles: true, cancelable: true, composed: true, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  (el as HTMLElement).click();
}

function TerminalControlStrip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a]">
      <div className="flex items-center gap-2 rounded-md border border-white/[0.08] bg-[#0a0a0a] px-2 py-1">
        {children}
      </div>
    </div>
  );
}

export const Position: Story = {
  render: () => (
    <TerminalControlStrip>
      <PositionPicker current="bottom" onSelect={() => {}} horizontal />
    </TerminalControlStrip>
  ),
  play: async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    openByPointer(document.querySelector('button[aria-label="Change terminal position"]'));
    await new Promise(resolve => setTimeout(resolve, 150));
  },
};

export const BugReport: Story = {
  render: () => (
    <TerminalControlStrip>
      <BugReportMenu />
    </TerminalControlStrip>
  ),
  play: async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    openByPointer(document.querySelector('button[aria-label="Report a bug"]'));
    await new Promise(resolve => setTimeout(resolve, 150));
  },
};
