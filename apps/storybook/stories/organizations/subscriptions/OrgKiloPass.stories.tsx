import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs';
import { expect, fireEvent, userEvent, within } from 'storybook/test';
import {
  OrgKiloPassActivationView,
  OrgKiloPassCheckoutReviewView,
  OrgKiloPassDetailView,
  OrgKiloPassGroupStateView,
  OrgKiloPassSetupView,
  OrgKiloPassSubscriptionCenterView,
  type OrgKiloPassAllocation,
  type OrgKiloPassTier,
} from '@/components/subscriptions/OrgKiloPassViews';
import {
  currentAllocations,
  customTerms,
  nextAllocations,
  OrganizationAppPreview,
  organizationId,
  organizationName,
  overallocatedAllocations,
  standardTerms,
  storyContext,
  StoryPage,
  supplementedAllocations,
  upfrontAllocations,
  updateChildAllocation,
} from './OrgKiloPassStoryFixtures';

const meta = {
  title: 'Kilo Pass for Orgs/Customer Journey',
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    nextjs: {
      appDirectory: true,
      navigation: {
        pathname: `/organizations/${organizationId}/subscriptions`,
        query: {},
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function SetupStory({
  initial = nextAllocations,
  validationMessage,
  cadence = 'annual',
}: {
  initial?: OrgKiloPassAllocation[];
  validationMessage?: string;
  cadence?: 'monthly' | 'annual';
}) {
  const [selectedTier, setSelectedTier] = useState<OrgKiloPassTier>('tier_49');
  const [allocations, setAllocations] = useState(initial);
  const quote =
    cadence === 'annual'
      ? {
          recurringTotal: '$70,560/year',
          firstCharge: '$4,417.32',
          firstServiceInterval: 'Jul 10 – Aug 1, 2026',
          firstIssuance: '$3,682.19',
        }
      : {
          recurringTotal: '$5,880/month',
          firstCharge: '$1,470.00',
          firstServiceInterval: 'Jul 10 – Aug 1, 2026',
          firstIssuance: '$1,470.00',
        };

  return (
    <OrganizationAppPreview pageTitle="Kilo Pass for Organizations">
      <StoryPage>
        <OrgKiloPassSetupView
          organizationId={organizationId}
          organizationName={organizationName}
          paidSeats={120}
          cadence={cadence}
          renewalDate="Aug 1, 2026"
          selectedTier={selectedTier}
          allocations={allocations}
          quote={quote}
          validationMessage={validationMessage}
          onTierChange={setSelectedTier}
          onChildAllocationChange={(id, passCount) =>
            setAllocations(current => updateChildAllocation(current, id, passCount))
          }
          onReviewPurchase={() => undefined}
        />
      </StoryPage>
    </OrganizationAppPreview>
  );
}

function DistributionEditorStory({
  initial,
  condition,
  stalePlanMessage,
}: {
  initial: OrgKiloPassAllocation[];
  condition?: Parameters<typeof OrgKiloPassDetailView>[0]['condition'];
  stalePlanMessage?: string;
}) {
  const [allocations, setAllocations] = useState(initial);

  return (
    <OrganizationAppPreview pageTitle="Kilo Pass for Organizations">
      <StoryPage>
        <OrgKiloPassDetailView
          organizationId={organizationId}
          organizationName={organizationName}
          commercialState="active"
          condition={condition}
          terms={standardTerms}
          totalPasses={condition?.kind === 'overallocated' ? 100 : 120}
          cadence="annual"
          paidThrough="Jul 1, 2027"
          currentWindow="Jul 1 – Jul 31, 2026"
          currentAllocations={currentAllocations}
          nextWindowStarts="Aug 1, 2026"
          nextAllocations={allocations}
          isEditing
          stalePlanMessage={stalePlanMessage}
          onChildAllocationChange={(id, passCount) =>
            setAllocations(current => updateChildAllocation(current, id, passCount))
          }
          onSaveDistribution={() => undefined}
        />
      </StoryPage>
    </OrganizationAppPreview>
  );
}

export const AvailableInSubscriptionCenter: Story = {
  parameters: storyContext({
    seeing: 'Kilo Pass for Organizations is available as an add-on for all 120 paid seats.',
    how: 'Northstar Labs has an active seat subscription but has not added Kilo Pass yet.',
    next: 'Select Add Kilo Pass to choose a tier and decide where the passes go.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Subscriptions">
      <OrgKiloPassSubscriptionCenterView
        organizationId={organizationId}
        organizationName={organizationName}
        seatsUsed={76}
        paidSeats={120}
        seatPrice="$8,640/year"
        renewalDate="Aug 1, 2026"
      />
    </OrganizationAppPreview>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText('Available add-on')).toBeVisible();
    await expect(canvas.getByText('Kilo Pass for Organizations')).toBeVisible();
    await expect(canvas.getByText('From')).toBeVisible();
    await expect(canvas.getByText('$19')).toBeVisible();
    await expect(canvas.getByText('per paid seat/month, billed with seats')).toBeVisible();
    await expect(canvas.getByText('Get monthly Credits for all 120 paid seats')).toBeVisible();
    await expect(
      canvas.getByText('Unlock bonus Credits as your organization uses Kilo')
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: /add kilo pass/i })).toBeVisible();
  },
};

export const ActiveInSubscriptionCenter: Story = {
  parameters: storyContext({
    seeing: 'Northstar Labs has an active Pro add-on covering all 120 paid seats.',
    how: 'Payment was confirmed and Kilo Pass for Organizations is active through Jul 1, 2027.',
    next: 'Open Kilo Pass to view Credits or manage future pass assignments.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Subscriptions" organizationRole="billing_manager">
      <OrgKiloPassSubscriptionCenterView
        organizationId={organizationId}
        organizationName={organizationName}
        seatsUsed={76}
        paidSeats={120}
        seatPrice="$8,640/year"
        renewalDate="Aug 1, 2026"
        agreement={{
          status: 'active',
          tierName: 'Pro',
          price: '$70,560/year',
          paidThrough: 'Jul 1, 2027',
        }}
      />
    </OrganizationAppPreview>
  ),
};

export const CancellationScheduledInSubscriptionCenter: Story = {
  parameters: storyContext({
    seeing: 'The Pro add-on is scheduled to end on Jul 1, 2027.',
    how: 'A billing manager canceled the subscription at the end of its current billing period.',
    next: 'Monthly Credits continue until the end date; existing Credits remain available.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Subscriptions" organizationRole="billing_manager">
      <OrgKiloPassSubscriptionCenterView
        organizationId={organizationId}
        organizationName={organizationName}
        seatsUsed={76}
        paidSeats={120}
        seatPrice="$8,640/year"
        renewalDate="Aug 1, 2026"
        agreement={{
          status: 'cancel_at_period_end',
          tierName: 'Pro',
          price: '$70,560/year',
          paidThrough: 'Jul 1, 2027',
        }}
      />
    </OrganizationAppPreview>
  ),
};

export const BlockedProcessingInSubscriptionCenter: Story = {
  parameters: storyContext({
    seeing: "Next month's Credits are paused because too many passes are assigned.",
    how: 'The paid-seat total fell below the number of passes assigned to child organizations.',
    next: 'Reduce child organization pass assignments so monthly Credits can resume.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Subscriptions">
      <OrgKiloPassSubscriptionCenterView
        organizationId={organizationId}
        organizationName={organizationName}
        seatsUsed={76}
        paidSeats={120}
        seatPrice="$8,640/year"
        renewalDate="Aug 1, 2026"
        agreement={{
          status: 'active',
          tierName: 'Pro',
          price: '$70,560/year',
          paidThrough: 'Jul 1, 2027',
          condition: {
            kind: 'blocked',
            title: 'Update pass assignments to receive Credits',
            description:
              'You assigned more passes to child organizations than will be available next month.',
            actionLabel: 'Review pass assignments',
          },
        }}
      />
    </OrganizationAppPreview>
  ),
};

export const FailedProcessingInSubscriptionCenter: Story = {
  parameters: storyContext({
    seeing: 'Monthly Credits are delayed after Kilo could not add them.',
    how: 'A temporary system error stopped the monthly Credit update before any Credits were added.',
    next: 'Kilo retries automatically; no customer action is needed.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Subscriptions">
      <OrgKiloPassSubscriptionCenterView
        organizationId={organizationId}
        organizationName={organizationName}
        seatsUsed={76}
        paidSeats={120}
        seatPrice="$8,640/year"
        renewalDate="Aug 1, 2026"
        agreement={{
          status: 'active',
          tierName: 'Pro',
          price: '$70,560/year',
          paidThrough: 'Jul 1, 2027',
          condition: {
            kind: 'failed',
            title: 'Monthly Credits are delayed',
            description: 'No Credits were added. Kilo is trying again.',
          },
        }}
      />
    </OrganizationAppPreview>
  ),
};

export const AwaitingPaymentInSubscriptionCenter: Story = {
  parameters: storyContext({
    seeing: 'The Pro add-on is waiting for payment.',
    how: 'Checkout finished, but the invoice has not been paid or confirmed yet.',
    next: 'Complete payment to start Kilo Pass and receive the first Credits.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Subscriptions">
      <OrgKiloPassSubscriptionCenterView
        organizationId={organizationId}
        organizationName={organizationName}
        seatsUsed={76}
        paidSeats={120}
        seatPrice="$8,640/year"
        renewalDate="Aug 1, 2026"
        agreement={{
          status: 'pending_payment',
          tierName: 'Pro',
          price: '$70,560/year',
          paidThrough: 'Waiting for payment',
        }}
      />
    </OrganizationAppPreview>
  ),
};

export const EndedAgreementInSubscriptionCenter: Story = {
  parameters: storyContext({
    seeing: 'The Pro add-on ended on Jul 1, 2026.',
    how: 'The subscription reached its scheduled end date.',
    next: 'No new monthly Credits will be added; add Kilo Pass again to restart service.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Subscriptions">
      <OrgKiloPassSubscriptionCenterView
        organizationId={organizationId}
        organizationName={organizationName}
        seatsUsed={76}
        paidSeats={120}
        seatPrice="$8,640/year"
        renewalDate="Aug 1, 2026"
        agreement={{
          status: 'ended',
          tierName: 'Pro',
          price: '$70,560/year',
          paidThrough: 'Jul 1, 2026',
        }}
      />
    </OrganizationAppPreview>
  ),
};

export const SubscriptionGroupLoading: Story = {
  parameters: storyContext({
    seeing: 'The Kilo Pass section is loading.',
    how: 'Storybook is showing the period while subscription details are being retrieved.',
    next: 'The section is replaced with subscription details when loading finishes.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Subscriptions">
      <OrgKiloPassGroupStateView state="loading" />
    </OrganizationAppPreview>
  ),
};

export const SubscriptionGroupError: Story = {
  parameters: storyContext({
    seeing: 'Kilo Pass subscription details could not be loaded.',
    how: 'The request for subscription details failed.',
    next: 'Retry loading the page.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Subscriptions">
      <OrgKiloPassGroupStateView state="error" />
    </OrganizationAppPreview>
  ),
};

export const ChildOrganizationIsIneligible: Story = {
  parameters: storyContext({
    seeing: 'A child organization can see Kilo Pass but cannot manage it.',
    how: 'Northstar Labs owns the seat subscription and controls pass assignments for its children.',
    next: 'Switch to Northstar Labs to manage Kilo Pass for Organizations.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Subscriptions" organizationRole="billing_manager">
      <OrgKiloPassSubscriptionCenterView
        organizationId={organizationId}
        organizationName="Product & Engineering"
        seatsUsed={24}
        paidSeats={30}
        seatPrice="$2,160/year"
        renewalDate="Aug 1, 2026"
        eligibilityMessage="Open Northstar Labs to manage Kilo Pass for Organizations and pass assignments for child organizations."
      />
    </OrganizationAppPreview>
  ),
};

export const InitialSetupAndDistribution: Story = {
  parameters: storyContext({
    seeing: 'Northstar Labs is setting up an annual Pro add-on for 120 paid seats.',
    how: 'The organization selected Kilo Pass from its available subscription add-ons.',
    next: 'Choose a tier, assign passes, and review the purchase.',
  }),
  render: () => <SetupStory />,
};

export const MonthlySetup: Story = {
  parameters: storyContext({
    seeing: 'Northstar Labs is setting up a monthly Pro add-on for 120 paid seats.',
    how: 'The seat subscription uses monthly billing and Kilo Pass follows the same schedule.',
    next: 'Choose a tier, assign passes, and review the purchase.',
  }),
  render: () => <SetupStory cadence="monthly" />,
};

export const SetupUpdatesTierAndParentRemainder: Story = {
  parameters: storyContext({
    seeing: 'Changing tier and child assignments updates the setup before purchase.',
    how: 'Passes not assigned to child organizations automatically stay with Northstar Labs.',
    next: 'Review the recalculated total and remaining passes before purchase.',
  }),
  render: () => <SetupStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole('button', { name: /expert/i }));
    await expect(canvas.getByRole('button', { name: /expert/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    const productAllocation = canvas.getByRole('spinbutton', {
      name: 'Product & Engineering passes',
    });
    fireEvent.change(productAllocation, { target: { value: '45' } });

    await expect(canvas.getByLabelText(`${organizationName} passes`)).toHaveValue('55');
  },
};

export const SetupWithoutChildOrganizations: Story = {
  parameters: storyContext({
    seeing: 'All 120 passes stay with Northstar Labs.',
    how: 'This organization has no child organizations eligible to receive passes.',
    next: 'Review the selected tier and purchase details.',
  }),
  render: () => (
    <SetupStory
      initial={[
        {
          organizationId,
          organizationName,
          kind: 'parent',
          passCount: 120,
        },
      ]}
    />
  ),
};

export const SetupValidationError: Story = {
  parameters: storyContext({
    seeing: 'Child organizations have been assigned more than the 120 available passes.',
    how: 'Pass assignments were entered that exceed the paid-seat total.',
    next: 'Remove excess passes before reviewing the purchase.',
  }),
  render: () => (
    <SetupStory
      initial={overallocatedAllocations.map((allocation, index) => ({
        ...allocation,
        passCount: index === 1 ? 100 : allocation.passCount,
      }))}
    />
  ),
};

export const SetupReconcilesOverallocationBeforeReview: Story = {
  parameters: storyContext({
    seeing: 'Purchase review stays disabled until pass assignments fit the available total.',
    how: 'The setup currently assigns more passes to child organizations than paid seats allow.',
    next: 'Reduce a child assignment to enable purchase review.',
  }),
  render: () => (
    <SetupStory
      initial={overallocatedAllocations.map((allocation, index) => ({
        ...allocation,
        passCount: index === 1 ? 100 : allocation.passCount,
      }))}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const reviewPurchase = canvas.getByRole('button', { name: 'Review purchase' });

    await expect(reviewPurchase).toBeDisabled();
    const productAllocation = canvas.getByRole('spinbutton', {
      name: 'Product & Engineering passes',
    });
    fireEvent.change(productAllocation, { target: { value: '80' } });
    await expect(reviewPurchase).toBeEnabled();
  },
};

export const SetupHierarchyChanged: Story = {
  parameters: storyContext({
    seeing: 'A saved pass assignment points to an organization that is no longer a child.',
    how: 'The organization hierarchy changed while setup was in progress.',
    next: 'Remove the old assignment, then review the purchase again.',
  }),
  render: () => (
    <SetupStory validationMessage="Customer Operations is no longer a child organization. Remove its pass assignment, then review your purchase again." />
  ),
};

export const PurchaseReviewWithAnnualBridge: Story = {
  parameters: storyContext({
    seeing: 'Northstar Labs is reviewing an annual Pro purchase and its first partial charge.',
    how: 'Kilo Pass is being added between annual seat billing dates, so the first charge covers only Jul 10 through Aug 1.',
    next: 'Confirm the purchase to continue to payment.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Kilo Pass for Organizations">
      <StoryPage>
        <OrgKiloPassCheckoutReviewView
          organizationId={organizationId}
          organizationName={organizationName}
          terms={standardTerms}
          paidSeats={120}
          cadence="annual"
          allocations={nextAllocations}
          quote={{
            firstCharge: '$4,417.32',
            recurringTotal: '$70,560/year',
            renewsOn: 'Aug 1, 2026',
          }}
          bridgeExplanation="Your annual subscription is already in progress. Your first charge and Credits cover Jul 10 through Aug 1. Monthly Credit periods start Aug 1."
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const PurchaseReviewWithMonthlyCadence: Story = {
  parameters: storyContext({
    seeing: 'Northstar Labs is reviewing a monthly Pro purchase.',
    how: 'Kilo Pass follows the monthly seat billing schedule beginning Aug 1.',
    next: 'Confirm the purchase to continue to payment.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Kilo Pass for Organizations">
      <StoryPage>
        <OrgKiloPassCheckoutReviewView
          organizationId={organizationId}
          organizationName={organizationName}
          terms={standardTerms}
          paidSeats={120}
          cadence="monthly"
          allocations={nextAllocations}
          quote={{
            firstCharge: '$5,880.00',
            recurringTotal: '$5,880/month',
            renewsOn: 'Aug 1, 2026',
          }}
          bridgeExplanation="Your monthly subscription is already in progress. Your first charge and Credits cover Jul 10 through Aug 1. Monthly Credit periods start Aug 1."
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const PurchaseReviewLoading: Story = {
  parameters: storyContext({
    seeing: 'The purchase is being submitted.',
    how: 'A billing manager confirmed the order and Kilo is creating checkout.',
    next: 'Wait for checkout to finish; the submit action remains disabled meanwhile.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Kilo Pass for Organizations">
      <StoryPage>
        <OrgKiloPassCheckoutReviewView
          organizationId={organizationId}
          organizationName={organizationName}
          terms={standardTerms}
          paidSeats={120}
          cadence="annual"
          allocations={nextAllocations}
          quote={{
            firstCharge: '$4,417.32',
            recurringTotal: '$70,560/year',
            renewsOn: 'Aug 1, 2026',
          }}
          bridgeExplanation="Your first monthly Credit period ends on your next billing date."
          isSubmitting
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const AwaitingPaidInvoice: Story = {
  parameters: storyContext({
    seeing: 'Checkout is complete and Kilo is waiting for payment confirmation.',
    how: 'An invoice was created but payment has not been confirmed.',
    next: 'Kilo Pass starts after payment is received.',
  }),
  render: () => (
    <OrgKiloPassActivationView
      state="awaiting_payment"
      title="Waiting for payment confirmation"
      description="Checkout is complete. Kilo Pass for Organizations starts after we receive your payment."
    />
  ),
};

export const CreatingFirstIssuance: Story = {
  parameters: storyContext({
    seeing: 'Payment is confirmed and the first Credits are being added.',
    how: 'Kilo is using the pass assignments chosen during checkout.',
    next: 'Wait for activation to finish.',
  }),
  render: () => (
    <OrgKiloPassActivationView
      state="activating"
      title="Adding your first Credits"
      description="Payment confirmed. We are adding Credits based on your pass assignments."
    />
  ),
};

export const PaymentRequiresAction: Story = {
  parameters: storyContext({
    seeing: 'Kilo could not complete the payment.',
    how: 'The payment provider requires the billing manager to confirm the payment method.',
    next: 'Return to billing and complete the requested payment step.',
  }),
  render: () => (
    <OrgKiloPassActivationView
      state="requires_action"
      title="Payment needs attention"
      description="We could not complete your payment. Return to billing to confirm your payment method."
      actionLabel="Return to billing"
    />
  ),
};

export const FirstIssuanceBlocked: Story = {
  parameters: storyContext({
    seeing: 'Payment succeeded, but the first Credits cannot be added yet.',
    how: 'Paid seats or child organizations changed during checkout, making the saved assignments invalid.',
    next: 'Update pass assignments before Kilo tries again.',
  }),
  render: () => (
    <OrgKiloPassActivationView
      state="blocked"
      title="Pass assignments need updating"
      description="A selected child organization or number of paid seats changed during checkout. Update pass assignments before Credits are added."
      actionLabel="Update pass assignments"
    />
  ),
};

export const ActivationSucceeded: Story = {
  parameters: storyContext({
    seeing: 'Kilo Pass for Organizations is active and the first Credits were added.',
    how: 'Payment was confirmed and every saved pass assignment was valid.',
    next: 'Open Kilo Pass to view Credits and future assignments.',
  }),
  render: () => (
    <OrgKiloPassActivationView
      state="succeeded"
      title="Kilo Pass for Organizations is active"
      description="Your first Credits were added to Northstar Labs and the child organizations you selected."
      actionLabel="View Kilo Pass"
    />
  ),
};

export const ActiveAgreement: Story = {
  parameters: storyContext({
    seeing: 'An active annual Pro subscription with current Credits and future pass assignments.',
    how: 'Northstar Labs completed payment and assigned passes across itself and two child organizations.',
    next: 'Review current Credit progress or edit assignments for next month.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Kilo Pass for Organizations">
      <StoryPage>
        <OrgKiloPassDetailView
          organizationId={organizationId}
          organizationName={organizationName}
          commercialState="active"
          terms={standardTerms}
          totalPasses={120}
          cadence="annual"
          paidThrough="Jul 1, 2027"
          currentWindow="Jul 1 – Jul 31, 2026"
          currentAllocations={currentAllocations}
          nextWindowStarts="Aug 1, 2026"
          nextAllocations={nextAllocations}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const PendingPaymentAgreement: Story = {
  parameters: storyContext({
    seeing: 'The subscription exists but its first payment is still pending.',
    how: 'Checkout created the annual Pro subscription and invoice, but payment is not confirmed.',
    next: 'Pay the invoice to start the first monthly Credit period.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Kilo Pass for Organizations">
      <StoryPage>
        <OrgKiloPassDetailView
          organizationId={organizationId}
          organizationName={organizationName}
          commercialState="pending_payment"
          terms={standardTerms}
          totalPasses={120}
          cadence="annual"
          paidThrough="Waiting for invoice payment"
          currentWindow="First monthly Credit period starts after payment"
          currentAllocations={[]}
          nextWindowStarts="After payment is confirmed"
          nextAllocations={nextAllocations}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const EndedAgreement: Story = {
  parameters: storyContext({
    seeing: 'The annual Pro subscription has ended.',
    how: 'It reached its Jul 1, 2026 end date after the final monthly Credit period.',
    next: 'No new Credits are scheduled; start a new subscription to resume them.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Kilo Pass for Organizations">
      <StoryPage>
        <OrgKiloPassDetailView
          organizationId={organizationId}
          organizationName={organizationName}
          commercialState="ended"
          terms={standardTerms}
          totalPasses={120}
          cadence="annual"
          paidThrough="Ended Jul 1, 2026"
          currentWindow="Jun 1 – Jun 30, 2026"
          currentAllocations={currentAllocations}
          nextWindowStarts="No future monthly Credits scheduled"
          nextAllocations={nextAllocations}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const ParentOnlyDistribution: Story = {
  parameters: storyContext({
    seeing: 'Northstar Labs keeps all 120 passes and monthly Credits.',
    how: 'No passes are assigned to child organizations for the current or next month.',
    next: 'Edit future assignments if child organizations should receive passes.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Kilo Pass for Organizations">
      <StoryPage>
        <OrgKiloPassDetailView
          organizationId={organizationId}
          organizationName={organizationName}
          commercialState="active"
          terms={standardTerms}
          totalPasses={120}
          cadence="monthly"
          paidThrough="Aug 1, 2026"
          currentWindow="Jul 1 – Jul 31, 2026"
          currentAllocations={[
            {
              ...currentAllocations[0],
              passCount: 120,
              baseCreditsUsd: 5880,
              bonusCreditsUsd: 1440,
            },
          ]}
          nextWindowStarts="Aug 1, 2026"
          nextAllocations={[{ organizationId, organizationName, kind: 'parent', passCount: 120 }]}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const CustomUpfrontTerms: Story = {
  parameters: storyContext({
    seeing: 'A custom Expert subscription is active with manually added Credits.',
    how: 'Northstar Labs has older custom terms that remain manual until its next renewal.',
    next: 'Automatic monthly Credits begin when the subscription renews.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Kilo Pass for Organizations">
      <StoryPage>
        <OrgKiloPassDetailView
          organizationId={organizationId}
          organizationName={organizationName}
          commercialState="active"
          condition={{
            kind: 'manual',
            title: 'Manual handling for your previous subscription',
            description:
              'Credits for your current subscription are added manually. Automatic monthly Credits start when your subscription renews.',
          }}
          terms={customTerms}
          totalPasses={120}
          cadence="annual"
          paidThrough="Dec 31, 2026"
          currentWindow="Jul 1 – Jul 31, 2026"
          currentAllocations={upfrontAllocations}
          nextWindowStarts="Aug 1, 2026"
          nextAllocations={nextAllocations}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const ParentSupplementAfterSeatIncrease: Story = {
  parameters: storyContext({
    seeing: 'Five new passes and their Credits were added to Northstar Labs this month.',
    how: 'The paid-seat count increased from 120 to 125 after the monthly Credits were first added.',
    next: 'Update next month’s child assignments if the new passes should move elsewhere.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Kilo Pass for Organizations">
      <StoryPage>
        <OrgKiloPassDetailView
          organizationId={organizationId}
          organizationName={organizationName}
          commercialState="active"
          terms={standardTerms}
          totalPasses={125}
          cadence="annual"
          paidThrough="Jul 1, 2027"
          currentWindow="Jul 1 – Jul 31, 2026"
          currentAllocations={supplementedAllocations}
          nextWindowStarts="Aug 1, 2026"
          nextAllocations={nextAllocations}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const ExpiredAndMissedBonusOutcomes: Story = {
  parameters: storyContext({
    seeing: 'Child organizations ended the month with different bonus Credit results.',
    how: 'Each organization used a different amount of its monthly Credits before the period ended.',
    next: 'Review usage and adjust future pass assignments if needed.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Kilo Pass for Organizations">
      <StoryPage>
        <OrgKiloPassDetailView
          organizationId={organizationId}
          organizationName={organizationName}
          commercialState="active"
          terms={standardTerms}
          totalPasses={120}
          cadence="annual"
          paidThrough="Jul 1, 2027"
          currentWindow="Jun 1 – Jun 30, 2026"
          currentAllocations={currentAllocations.map((allocation, index) => ({
            ...allocation,
            bonusState: index === 0 ? 'expired' : index === 1 ? 'missed' : 'unlocked',
          }))}
          nextWindowStarts="Jul 1, 2026"
          nextAllocations={nextAllocations}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const EditNextDistribution: Story = {
  parameters: storyContext({
    seeing: 'A billing manager is editing pass assignments for next month.',
    how: 'The active subscription already has Credits for this month, so changes apply only from Aug 1.',
    next: 'Save the new assignments.',
  }),
  render: () => <DistributionEditorStory initial={nextAllocations} />,
};

export const SeatDecreaseNeedsReconciliation: Story = {
  parameters: storyContext({
    seeing: 'Child organizations have 110 assigned passes, but only 100 will be available.',
    how: 'The paid-seat count decreased after next month’s assignments were saved.',
    next: 'Remove 10 child organization passes before Aug 1.',
  }),
  render: () => (
    <DistributionEditorStory
      initial={overallocatedAllocations}
      condition={{
        kind: 'overallocated',
        title: 'Pass assignments need updating',
        description:
          'You assigned 10 more passes to child organizations than your new 100-seat total allows. Update pass assignments before Aug 1 so monthly Credits are added on schedule.',
        actionLabel: 'Review pass assignments',
      }}
    />
  ),
};

export const StaleDistributionEdit: Story = {
  parameters: storyContext({
    seeing: 'The pass assignments on screen are no longer current.',
    how: 'Another billing manager or process changed the assignments while this page was open.',
    next: 'Refresh the latest assignments before making and saving changes.',
  }),
  render: () => (
    <DistributionEditorStory
      initial={nextAllocations}
      stalePlanMessage="Refresh the latest pass assignments for child organizations before saving. Your current Credits and monthly Credit period will not change."
    />
  ),
};

export const CancellationScheduled: Story = {
  parameters: storyContext({
    seeing: 'The annual Pro subscription is scheduled to end on Jul 1, 2027.',
    how: 'A billing manager scheduled cancellation at the end of the paid billing period.',
    next: 'Monthly Credits continue through the end date; existing Credits remain available.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Kilo Pass for Organizations">
      <StoryPage>
        <OrgKiloPassDetailView
          organizationId={organizationId}
          organizationName={organizationName}
          commercialState="cancel_at_period_end"
          terms={standardTerms}
          totalPasses={120}
          cadence="annual"
          paidThrough="Jul 1, 2027"
          cancellationEffectiveAt="Jul 1, 2027"
          currentWindow="Jul 1 – Jul 31, 2026"
          currentAllocations={currentAllocations}
          nextWindowStarts="Aug 1, 2026"
          nextAllocations={nextAllocations}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const TierChangeScheduled: Story = {
  parameters: storyContext({
    seeing: 'The active Pro tier is scheduled to change to Expert on Jul 1, 2027.',
    how: 'A billing manager selected a different tier for the next renewal.',
    next: 'Pro terms remain active until the change date.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Kilo Pass for Organizations">
      <StoryPage>
        <OrgKiloPassDetailView
          organizationId={organizationId}
          organizationName={organizationName}
          commercialState="active"
          terms={standardTerms}
          totalPasses={120}
          cadence="annual"
          paidThrough="Jul 1, 2027"
          pendingTransition={{ tierName: 'Expert', effectiveAt: 'Jul 1, 2027' }}
          currentWindow="Jul 1 – Jul 31, 2026"
          currentAllocations={currentAllocations}
          nextWindowStarts="Aug 1, 2026"
          nextAllocations={nextAllocations}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const PaymentUnderReview: Story = {
  parameters: storyContext({
    seeing: 'New monthly Credits are paused while a payment is reviewed.',
    how: 'A previously confirmed payment was reversed.',
    next: 'Check billing; Credits already added remain available during the review.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Kilo Pass for Organizations">
      <StoryPage>
        <OrgKiloPassDetailView
          organizationId={organizationId}
          organizationName={organizationName}
          commercialState="active"
          condition={{
            kind: 'payment_review',
            title: 'Monthly Credits are paused',
            description:
              'A payment was reversed. Credits already added remain available. New monthly Credits are paused while we review the payment.',
            actionLabel: 'View billing',
          }}
          terms={standardTerms}
          totalPasses={120}
          cadence="annual"
          paidThrough="Jul 1, 2027"
          currentWindow="Jul 1 – Jul 31, 2026"
          currentAllocations={currentAllocations}
          nextWindowStarts="Aug 1, 2026"
          nextAllocations={nextAllocations}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const FailedProcessing: Story = {
  parameters: storyContext({
    seeing: 'Monthly Credits are delayed after a system error.',
    how: 'The update stopped before any Credits were added.',
    next: 'Kilo retries automatically; no customer action is needed.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Kilo Pass for Organizations">
      <StoryPage>
        <OrgKiloPassDetailView
          organizationId={organizationId}
          organizationName={organizationName}
          commercialState="active"
          condition={{
            kind: 'failed',
            title: 'Monthly Credits are delayed',
            description: 'No Credits were added. Kilo is trying again.',
          }}
          terms={standardTerms}
          totalPasses={120}
          cadence="annual"
          paidThrough="Jul 1, 2027"
          currentWindow="Jul 1 – Jul 31, 2026"
          currentAllocations={currentAllocations}
          nextWindowStarts="Aug 1, 2026"
          nextAllocations={nextAllocations}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const BlockedIssuance: Story = {
  parameters: storyContext({
    seeing: 'No monthly Credits were added because assignments exceed the 100 available passes.',
    how: 'A seat decrease left child organizations with more assigned passes than the new total.',
    next: 'Reduce child organization assignments, then Kilo will try again.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Kilo Pass for Organizations">
      <StoryPage>
        <OrgKiloPassDetailView
          organizationId={organizationId}
          organizationName={organizationName}
          commercialState="active"
          condition={{
            kind: 'blocked',
            title: 'Update pass assignments to receive monthly Credits',
            description:
              'No Credits were added. Reduce passes assigned to child organizations, then Kilo will try again.',
            actionLabel: 'Review pass assignments',
          }}
          terms={standardTerms}
          totalPasses={100}
          cadence="annual"
          paidThrough="Jul 1, 2027"
          currentWindow="Jul 1 – Jul 31, 2026"
          currentAllocations={currentAllocations}
          nextWindowStarts="Aug 1, 2026"
          nextAllocations={overallocatedAllocations}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const MobileSetup: Story = {
  parameters: storyContext({
    seeing: 'The annual Pro setup flow at a mobile viewport.',
    how: 'This is the same 120-seat setup shown on a narrow screen to verify responsive behavior.',
    next: 'Choose a tier, assign passes, and review the purchase.',
  }),
  render: () => <SetupStory />,
  globals: { viewport: { value: 'mobile2', isRotated: false } },
};

export const MobileActiveAgreement: Story = {
  ...ActiveAgreement,
  parameters: storyContext({
    seeing: 'The active annual Pro subscription at a mobile viewport.',
    how: 'This is the same active subscription shown on a narrow screen to verify responsive behavior.',
    next: 'Review current Credits or edit future pass assignments.',
  }),
  globals: { viewport: { value: 'mobile2', isRotated: false } },
};
