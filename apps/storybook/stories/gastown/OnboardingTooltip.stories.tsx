import type { Meta, StoryObj } from '@storybook/nextjs';
import { OnboardingTooltipPopover } from '@/components/gastown/OnboardingTooltips';
import { ONBOARDING_TOOLTIPS } from '@/components/gastown/useOnboardingTooltips';

// The onboarding coachmark (Radix Popover anchored to the target element via a
// virtual anchor). It anchors to an element carrying `data-onboarding-target`,
// so the story renders one and the popover positions against it.

const tooltip = ONBOARDING_TOOLTIPS[0];

const meta: Meta<typeof OnboardingTooltipPopover> = {
  title: 'Overlays/Coachmarks/OnboardingTooltip',
  component: OnboardingTooltipPopover,
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="bg-background min-h-screen p-10">
      <div className="flex gap-3">
        <button
          type="button"
          data-onboarding-target={tooltip.target}
          className="rounded-md border border-white/15 bg-[#1a1a2e] px-4 py-2 text-sm text-white/80"
        >
          {tooltip.title} anchor
        </button>
      </div>
      <OnboardingTooltipPopover tooltip={tooltip} onDismiss={() => {}} onDismissAll={() => {}} />
    </div>
  ),
};
