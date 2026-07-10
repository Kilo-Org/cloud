import type { Meta, StoryObj } from '@storybook/nextjs';
import {
  OrgKiloPassAdminView,
  OrgKiloPassBillingView,
  OrgKiloPassHierarchyGuardView,
  OrgKiloPassMemberCreditView,
  OrgKiloPassSeatChangeView,
  OrgKiloPassStatusReferenceView,
} from '@/components/subscriptions/OrgKiloPassViews';
import {
  customTerms,
  OrganizationAppPreview,
  organizationId,
  standardTerms,
  storyContext,
  StoryPage,
} from './OrgKiloPassStoryFixtures';

const meta = {
  title: 'Kilo Pass for Orgs/Operations and Access',
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    nextjs: {
      appDirectory: true,
      navigation: {
        pathname: `/organizations/${organizationId}/subscriptions/kilo-pass`,
        query: {},
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const SeatIncrease: Story = {
  parameters: storyContext({
    seeing: 'The seat count is increasing from 120 to 125, adding five Kilo Passes.',
    how: 'A billing manager added five paid seats during the current monthly Credit period.',
    next: 'Confirm the increase; child organization assignment changes become available Aug 1.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Change seat count">
      <StoryPage>
        <OrgKiloPassSeatChangeView
          kind="increase"
          currentSeats={120}
          newSeats={125}
          details={[
            { label: 'Passes added this month', value: '5 passes for Northstar Labs this month' },
            { label: 'Credits added now', value: '$122.50' },
            { label: 'Usage needed for bonus', value: '$122.50 in usage after confirmation' },
            { label: 'Child organization changes', value: 'Available Aug 1, 2026' },
          ]}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const SeatDecreaseWithoutConflict: Story = {
  parameters: storyContext({
    seeing: 'The seat count is decreasing from 120 to 115 without an assignment conflict.',
    how: 'Child organizations use only 50 passes, so their assignments fit the new total.',
    next: 'Confirm the decrease; the new pass total applies next month.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Change seat count">
      <StoryPage>
        <OrgKiloPassSeatChangeView
          kind="decrease"
          currentSeats={120}
          newSeats={115}
          details={[
            { label: 'This monthly Credit period', value: 'No Credit changes' },
            { label: 'Northstar Labs next month', value: '65 passes' },
            { label: 'Child organizations next month', value: '50 passes, unchanged' },
            { label: 'Changes on', value: 'Aug 1, 2026' },
          ]}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const SeatDecreaseWithReconciliation: Story = {
  parameters: storyContext({
    seeing: 'The seat count is decreasing to 100 while child organizations still have 110 passes.',
    how: 'The saved child assignments exceed the new paid-seat total by 10.',
    next: 'Remove 10 child organization passes before Aug 1.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Change seat count">
      <StoryPage>
        <OrgKiloPassSeatChangeView
          kind="decrease"
          currentSeats={120}
          newSeats={100}
          requiresReconciliation
          details={[
            { label: 'Assigned to child organizations', value: '110 passes' },
            { label: 'Passes to remove', value: '10 passes' },
            { label: 'Update by', value: 'Aug 1, 2026' },
          ]}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const BillingCadenceChange: Story = {
  parameters: storyContext({
    seeing: 'Seat and Kilo Pass billing are changing from monthly to annual.',
    how: 'A billing manager scheduled a new billing schedule for Aug 1 without changing seat count.',
    next: 'Confirm the change; monthly Credits continue on the same schedule.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Change billing schedule">
      <StoryPage>
        <OrgKiloPassSeatChangeView
          kind="cadence"
          currentSeats={120}
          newSeats={120}
          details={[
            { label: 'Seats', value: '$720/month → $8,640/year' },
            { label: 'Kilo Pass for Organizations', value: '$5,880/month → $70,560/year' },
            { label: 'Changes on', value: 'Aug 1, 2026' },
            { label: 'Monthly Credits', value: 'Continue monthly' },
          ]}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const CancellationImpact: Story = {
  parameters: storyContext({
    seeing: 'The seat subscription and Kilo Pass are being canceled for Jul 1, 2027.',
    how: 'A billing manager chose to end the shared subscription after the paid billing period.',
    next: 'Confirm cancellation; monthly Credits continue until the end date.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Cancel subscription">
      <StoryPage>
        <OrgKiloPassSeatChangeView
          kind="cancel"
          currentSeats={120}
          newSeats={120}
          details={[
            { label: 'Subscription ends', value: 'Jul 1, 2027' },
            { label: 'Monthly Credits', value: 'Continue until Jul 1, 2027' },
            { label: 'Credits already added', value: 'Remain available' },
            { label: 'Bonus Credits', value: 'Available through Jul 31, 2026' },
          ]}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const MixedSeatAndKiloPassInvoices: Story = {
  parameters: storyContext({
    seeing:
      'Billing history contains combined seat charges, a first Kilo Pass charge, and a refund.',
    how: 'Kilo Pass was added to an existing seat subscription and a prior payment was refunded.',
    next: 'Open an invoice when full billing details are needed.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Invoices" organizationRole="billing_manager">
      <StoryPage>
        <OrgKiloPassBillingView
          invoices={[
            {
              id: 'INV-2026-0801',
              date: 'Aug 1, 2026',
              description: 'Enterprise seats and Kilo Pass for Organizations',
              amount: '$79,200.00',
              status: 'Paid',
            },
            {
              id: 'INV-2026-0710',
              date: 'Jul 10, 2026',
              description: 'Kilo Pass for Organizations first charge',
              amount: '$4,417.32',
              status: 'Open',
            },
            {
              id: 'INV-2026-0601',
              date: 'Jun 1, 2026',
              description: 'Kilo Pass for Organizations refund',
              amount: '-$4,417.32',
              status: 'Refunded',
            },
          ]}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const EmptyBillingHistory: Story = {
  parameters: storyContext({
    seeing: 'The organization has no Kilo Pass invoices yet.',
    how: 'Billing has not started or no invoice has been created for this subscription.',
    next: 'Charges appear here after billing begins.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Invoices" organizationRole="billing_manager">
      <StoryPage>
        <OrgKiloPassBillingView invoices={[]} />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const MemberSeesGenericCredits: Story = {
  parameters: storyContext({
    seeing: 'An organization member sees the shared Credit balance and recent activity.',
    how: 'The member can use Credits but does not have access to Kilo Pass subscription details.',
    next: 'Use Credits for model activity or review recent transactions.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Organization" organizationRole="member">
      <StoryPage>
        <OrgKiloPassMemberCreditView
          organizationName="Product & Engineering"
          balance="$18,493.72"
          transactions={[
            {
              date: 'Jul 10, 2026',
              description: 'Organization Credits added',
              amount: '+$1,470.00',
            },
            { date: 'Jul 12, 2026', description: 'Model usage', amount: '-$82.41' },
            { date: 'Jul 15, 2026', description: 'Bonus Credits added', amount: '+$360.00' },
          ]}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const MemberSeesEmptyCreditActivity: Story = {
  parameters: storyContext({
    seeing: 'An organization member sees a zero balance and no Credit activity.',
    how: 'No Credits have been added to or used by this organization yet.',
    next: 'Activity appears after Credits are added or used.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Organization" organizationRole="member">
      <StoryPage>
        <OrgKiloPassMemberCreditView
          organizationName="Product & Engineering"
          balance="$0.00"
          transactions={[]}
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const ChildDetachBlocked: Story = {
  parameters: storyContext({
    seeing: 'Product & Engineering cannot be removed from the organization group yet.',
    how: 'It still has 30 passes assigned for next month.',
    next: 'Remove its pass assignment, then remove the child organization.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Child organizations">
      <StoryPage>
        <OrgKiloPassHierarchyGuardView
          organizationName="Product & Engineering"
          allocatedPasses={30}
          action="detach"
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const ChildReparentBlocked: Story = {
  parameters: storyContext({
    seeing: 'Product & Engineering cannot move to another parent organization yet.',
    how: 'It still has 30 passes assigned by Northstar Labs for next month.',
    next: 'Remove its pass assignment, then move the child organization.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Child organizations">
      <StoryPage>
        <OrgKiloPassHierarchyGuardView
          organizationName="Product & Engineering"
          allocatedPasses={30}
          action="reparent"
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const ChildArchiveBlocked: Story = {
  parameters: storyContext({
    seeing: 'Customer Operations cannot be archived yet.',
    how: 'It still has 20 passes assigned for next month.',
    next: 'Remove its pass assignment, then archive the child organization.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Child organizations">
      <StoryPage>
        <OrgKiloPassHierarchyGuardView
          organizationName="Customer Operations"
          allocatedPasses={20}
          action="archive"
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const ChildDeleteBlocked: Story = {
  parameters: storyContext({
    seeing: 'Customer Operations cannot be deleted yet.',
    how: 'It still has 20 passes assigned for next month.',
    next: 'Remove its pass assignment, then delete the child organization.',
  }),
  render: () => (
    <OrganizationAppPreview pageTitle="Child organizations">
      <StoryPage>
        <OrgKiloPassHierarchyGuardView
          organizationName="Customer Operations"
          allocatedPasses={20}
          action="delete"
        />
      </StoryPage>
    </OrganizationAppPreview>
  ),
};

export const AdminAutomatedAgreement: Story = {
  parameters: storyContext({
    seeing: 'An active agreement using automatic monthly Credit processing.',
    how: 'Standard terms are active and the latest Jul 1 processing run succeeded.',
    next: 'Monitor the next scheduled monthly run.',
  }),
  render: () => (
    <StoryPage>
      <OrgKiloPassAdminView
        terms={standardTerms}
        state="active"
        processingMode="automated"
        latestRun={{ window: 'Jul 1 – Jul 31, 2026', status: 'succeeded' }}
      />
    </StoryPage>
  ),
};

export const AdminPendingPaymentAgreement: Story = {
  parameters: storyContext({
    seeing: 'An agreement waiting for its first confirmed payment.',
    how: 'Automatic processing is configured, but no paid service period has started.',
    next: 'Resolve payment before the first Credit run can begin.',
  }),
  render: () => (
    <StoryPage>
      <OrgKiloPassAdminView
        terms={standardTerms}
        state="pending_payment"
        processingMode="automated"
        latestRun={{ window: 'First paid service interval', status: 'pending' }}
      />
    </StoryPage>
  ),
};

export const AdminCancellationScheduledAgreement: Story = {
  parameters: storyContext({
    seeing: 'An active agreement scheduled to end after its current billing period.',
    how: 'Cancellation was scheduled after a successful Jul 1 monthly run.',
    next: 'Allow remaining paid-period runs, then confirm the agreement ends.',
  }),
  render: () => (
    <StoryPage>
      <OrgKiloPassAdminView
        terms={standardTerms}
        state="cancel_at_period_end"
        processingMode="automated"
        latestRun={{ window: 'Jul 1 – Jul 31, 2026', status: 'succeeded' }}
      />
    </StoryPage>
  ),
};

export const AdminEndedAgreement: Story = {
  parameters: storyContext({
    seeing: 'An ended agreement with a successful final processing run.',
    how: 'The agreement ended after the Jun 1 through Jun 30 service period.',
    next: 'Keep the record for audit; create a new agreement if service resumes.',
  }),
  render: () => (
    <StoryPage>
      <OrgKiloPassAdminView
        terms={standardTerms}
        state="ended"
        processingMode="automated"
        latestRun={{ window: 'Jun 1 – Jun 30, 2026', status: 'succeeded' }}
      />
    </StoryPage>
  ),
};

export const AdminBlockedRun: Story = {
  parameters: storyContext({
    seeing: 'The Aug 1 Credit run is blocked before any Credits are added.',
    how: 'Direct-child pass assignments exceed purchased capacity, and customer contacts were notified.',
    next: 'Correct the assignments, then retry the blocked run.',
  }),
  render: () => (
    <StoryPage>
      <OrgKiloPassAdminView
        terms={standardTerms}
        state="active"
        processingMode="automated"
        condition={{
          kind: 'blocked',
          title: 'Aug 1 issuance blocked',
          description:
            'Direct-child allocations exceed purchased capacity. Customer notification sent once to 3 current owners and billing managers.',
        }}
        latestRun={{ window: 'Aug 1 – Aug 31, 2026', status: 'blocked' }}
      />
    </StoryPage>
  ),
};

export const AdminPendingProcessingRun: Story = {
  parameters: storyContext({
    seeing: 'The Aug 1 monthly processing run is queued but has not started.',
    how: 'The run was created for the next service period and remains pending.',
    next: 'Wait for processing or investigate if it remains pending too long.',
  }),
  render: () => (
    <StoryPage>
      <OrgKiloPassAdminView
        terms={standardTerms}
        state="active"
        processingMode="automated"
        latestRun={{ window: 'Aug 1 – Aug 31, 2026', status: 'pending' }}
      />
    </StoryPage>
  ),
};

export const AdminRunningProcessingRun: Story = {
  parameters: storyContext({
    seeing: 'The Aug 1 monthly processing run is in progress.',
    how: 'A worker started adding Credits for the service period.',
    next: 'Wait for completion, then verify the final run status.',
  }),
  render: () => (
    <StoryPage>
      <OrgKiloPassAdminView
        terms={standardTerms}
        state="active"
        processingMode="automated"
        latestRun={{ window: 'Aug 1 – Aug 31, 2026', status: 'running' }}
      />
    </StoryPage>
  ),
};

export const AdminFailedProcessingRun: Story = {
  parameters: storyContext({
    seeing: 'The Aug 1 monthly processing run failed without adding Credits.',
    how: 'The run rolled back after an error, preserving the original service period for retry.',
    next: 'Fix the failure cause, then retry the run.',
  }),
  render: () => (
    <StoryPage>
      <OrgKiloPassAdminView
        terms={standardTerms}
        state="active"
        processingMode="automated"
        condition={{
          kind: 'failed',
          title: 'Aug 1 issuance failed',
          description:
            'The run rolled back before any Credits were granted. Retry preserves the original window.',
        }}
        latestRun={{ window: 'Aug 1 – Aug 31, 2026', status: 'failed' }}
      />
    </StoryPage>
  ),
};

export const AdminPaymentReview: Story = {
  parameters: storyContext({
    seeing: 'Future Credit processing is paused while a payment is reviewed.',
    how: 'A confirmed payment was reversed; Credits already added were left in place.',
    next: 'Resolve the payment review before resuming processing.',
  }),
  render: () => (
    <StoryPage>
      <OrgKiloPassAdminView
        terms={standardTerms}
        state="active"
        processingMode="automated"
        condition={{
          kind: 'payment_review',
          title: 'Payment under review',
          description:
            'A reversed payment paused future entitlement. Granted Credits are not automatically clawed back.',
        }}
        latestRun={{ window: 'Aug 1 – Aug 31, 2026', status: 'pending' }}
      />
    </StoryPage>
  ),
};

export const AdminCustomManualAgreement: Story = {
  parameters: storyContext({
    seeing: 'An active custom agreement still using manual Credit processing.',
    how: 'Older contract terms require operators to add Credits manually through Dec 31, 2026.',
    next: 'Continue manual processing or move the agreement to automation at renewal.',
  }),
  render: () => (
    <StoryPage>
      <OrgKiloPassAdminView
        terms={customTerms}
        state="active"
        processingMode="manual_legacy"
        condition={{
          kind: 'manual',
          title: 'Manual legacy processing',
          description:
            'Current-term grants remain operator-managed through Dec 31, 2026. Automation requires an explicit renewal transition.',
        }}
        latestRun={{ window: 'Current contractual term', status: 'pending' }}
      />
    </StoryPage>
  ),
};

export const StatusReference: Story = {
  parameters: storyContext({
    seeing: 'A reference for agreement, processing, and Credit result statuses.',
    how: 'The table documents every state used by Kilo Pass for Organizations operations.',
    next: 'Use it when diagnosing an agreement or monthly processing run.',
  }),
  render: () => (
    <StoryPage>
      <OrgKiloPassStatusReferenceView />
    </StoryPage>
  ),
};
