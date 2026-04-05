import type { Meta, StoryObj } from '@storybook/nextjs';
import { useRef, useState } from 'react';
import { FreeTrialWarningBanner } from '@/components/organizations/FreeTrialWarningBanner';
import { UpgradeTrialDialog } from '@/components/organizations/UpgradeTrialDialog';
import { TrialStateSlider } from '../src/components/TrialStateSlider';
import { FreeTrialWarningDialog } from '@/components/organizations/FreeTrialWarningDialog';
import { mockOrganization } from '../src/mockData/organizations';

// Interactive story showing the complete trial nudge flow
const meta: Meta = {
  title: 'Organizations/Trial Nudges/Interactive',
  parameters: { layout: 'padded' },
};

export default meta;
type Story = StoryObj<typeof meta>;

// Interactive story showing both banner and lock dialog based on trial state
export const InteractiveTrialExpirationExample: Story = {
  parameters: {
    chromatic: { disableSnapshot: true }, // Skip Chromatic screenshots due to dynamic dates
  },
  render: () => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);

    return (
      <div className="relative">
        <TrialStateSlider defaultDays={15} defaultRole="owner">
          {({ daysRemaining, isOwner, state }) => {
            const isInLockState = state === 'trial_expired_soft' || state === 'trial_expired_hard';

            return (
              <div className="space-y-4">
                {/* Banner appears for all states */}
                <FreeTrialWarningBanner
                  organization={{ ...mockOrganization, plan: 'enterprise' }}
                  daysRemaining={daysRemaining}
                  userRole={isOwner ? 'owner' : 'member'}
                  onUpgradeClick={() => setShowUpgradeDialog(true)}
                />

                {/* Dialog appears in lock states - rendered in container below slider */}
                {isInLockState && (
                  <FreeTrialWarningDialog
                    trialStatus={state}
                    daysExpired={Math.abs(daysRemaining)}
                    organization={mockOrganization}
                    onClose={
                      state === 'trial_expired_soft'
                        ? () => console.log('Close clicked')
                        : undefined
                    }
                    onUpgradeClick={() => setShowUpgradeDialog(true)}
                    container={containerRef.current}
                    modal={false}
                  />
                )}

                {/* Upgrade Dialog */}
                <UpgradeTrialDialog
                  open={showUpgradeDialog}
                  onOpenChange={setShowUpgradeDialog}
                  organizationId="org-123"
                  organizationName="Acme Corp"
                  currentPlan="enterprise"
                  container={containerRef.current}
                />

                <div
                  ref={containerRef}
                  className="relative h-128 w-full transform-[translate3d(0,0,0)]"
                />
              </div>
            );
          }}
        </TrialStateSlider>
      </div>
    );
  },
};
