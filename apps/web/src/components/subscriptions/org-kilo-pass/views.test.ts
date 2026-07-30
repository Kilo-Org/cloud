import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PageTitleProvider } from '@/contexts/PageTitleContext';
import type { OrgKiloPassTerms } from './types';

const starterTerms: OrgKiloPassTerms = {
  tier: 'tier_19',
  tierName: 'Starter',
  pricePerPassUsd: 19,
  baseCreditsPerPassUsd: 19,
  bonusCreditsPerPassUsd: 4,
  unlockSpendPerPassUsd: 19,
  bonusMode: 'after_base',
};
import { OrgKiloPassActivationView } from './OrgKiloPassActivationView';
import { OrgKiloPassDetailView } from './OrgKiloPassDetailView';
import { OrgKiloPassSetupView } from './OrgKiloPassSetupView';

Object.assign(globalThis, { React });

describe('OrgKiloPassDetailView', () => {
  type DetailProps = Parameters<typeof OrgKiloPassDetailView>[0];

  function render(overrides: Partial<DetailProps> = {}) {
    return renderToStaticMarkup(
      React.createElement(
        PageTitleProvider,
        null,
        React.createElement(OrgKiloPassDetailView, {
          organizationId: 'org-parent',
          organizationName: 'Acme',
          commercialState: 'active',
          terms: starterTerms,
          totalPasses: 6,
          cadence: 'monthly',
          paidThrough: 'Aug 27, 2026',
          currentWindow: 'Jul 28 – Aug 27, 2026',
          currentAllocations: [
            {
              organizationId: 'org-parent',
              organizationName: 'Acme',
              kind: 'parent',
              passCount: 6,
              baseCreditsUsd: 114,
              qualifyingSpendUsd: 0,
              unlockTargetUsd: 114,
              bonusCreditsUsd: 24,
              bonusState: 'locked',
            },
          ],
          nextWindowStarts: 'Aug 27, 2026',
          nextAllocations: [
            {
              organizationId: 'org-parent',
              organizationName: 'Acme',
              kind: 'parent',
              passCount: 6,
            },
            {
              organizationId: 'org-child',
              organizationName: 'Acme Child',
              kind: 'child',
              passCount: 0,
            },
          ],
          ...overrides,
        })
      )
    );
  }

  test('omits operational and redundant assignment metadata', () => {
    const html = render();

    expect(html).not.toContain('Latest monthly Credit run');
    expect(html).not.toContain('Final for this period');
    expect(html).not.toContain('for child organizations');
    expect(html).not.toContain('keeps the remaining passes');
  });

  test('offers cancellation without rendering confirmation content while closed', () => {
    const html = render({ onCancelSubscription: () => undefined });

    expect(html).toContain('Cancel subscription');
    expect(html).not.toContain('Cancel Kilo Pass for Organizations?');
    expect(html).not.toContain('Keep subscription');
  });

  test('shows the tier monthly Credits per pass', () => {
    const html = render();

    expect(html).toContain('$19 monthly Credits per pass');
  });

  test('explains a prorated current Credit allocation with an accessible info trigger', () => {
    const html = render({
      currentAllocations: [
        {
          organizationId: 'org-parent',
          organizationName: 'Acme',
          kind: 'parent',
          passCount: 6,
          hasProratedCredits: true,
          baseCreditsUsd: 57,
          qualifyingSpendUsd: 0,
          unlockTargetUsd: 57,
          bonusCreditsUsd: 12,
          bonusState: 'locked',
        },
      ],
    });

    const amount = html.indexOf('$57 monthly Credits');
    const trigger = html.indexOf('aria-label="About Acme&#x27;s prorated Credit amount"');
    expect(amount).toBeGreaterThan(-1);
    expect(trigger).toBeGreaterThan(amount);
    expect(html).toContain('lucide-info');
  });

  test('does not show the proration info trigger for a full monthly Credit period', () => {
    const html = render();

    expect(html).not.toContain('prorated Credit amount');
  });

  test('shows current-period allocation and usage for child organizations', () => {
    const html = render({
      currentAllocations: [
        {
          organizationId: 'org-parent',
          organizationName: 'Acme',
          kind: 'parent',
          passCount: 4,
          baseCreditsUsd: 76,
          qualifyingSpendUsd: 12,
          unlockTargetUsd: 76,
          bonusCreditsUsd: 16,
          bonusState: 'locked',
        },
        {
          organizationId: 'org-child',
          organizationName: 'Acme Child',
          kind: 'child',
          passCount: 2,
          baseCreditsUsd: 38,
          qualifyingSpendUsd: 8,
          unlockTargetUsd: 38,
          bonusCreditsUsd: 8,
          bonusState: 'locked',
        },
        {
          organizationId: 'org-unassigned-child',
          organizationName: 'Acme Unassigned Child',
          kind: 'child',
          passCount: 0,
          baseCreditsUsd: 0,
          qualifyingSpendUsd: 0,
          unlockTargetUsd: 0,
          bonusCreditsUsd: 0,
          bonusState: 'locked',
        },
      ],
    });

    expect(html).toContain('Acme Child');
    expect(html).toContain('2 passes · $38 monthly Credits');
    expect(html).toContain('$8 of $38 spent');
    expect(html).toContain('Acme Unassigned Child');
    expect(html).toContain('0 passes · $0 monthly Credits');
    expect(html).toContain('No passes assigned for this period');
    expect(html).toContain('Organization');
    expect(html).toContain('Usage');
    expect(html).toContain('Bonus Credits');
  });

  test('uses hierarchy icons only for child current-period rows', () => {
    const html = render({
      currentAllocations: [
        {
          organizationId: 'org-parent',
          organizationName: 'Acme',
          kind: 'parent',
          passCount: 5,
        },
        {
          organizationId: 'org-child',
          organizationName: 'Acme Child',
          kind: 'child',
          passCount: 1,
        },
      ],
    });
    const currentPeriod = html.slice(html.indexOf('Current Kilo Pass assignments'));

    expect(currentPeriod).toContain('lucide-corner-down-right');
    expect(currentPeriod).not.toContain('lucide-building-2');
    expect(currentPeriod).not.toContain('lucide-git-branch');
  });

  test('hides upcoming assignments when the next issuance matches the current period', () => {
    const html = render({ onEditDistribution: () => undefined });

    expect(html).not.toContain('Upcoming Kilo Pass assignments');
    expect(html).toContain('Modify pass assignments');
  });

  test('hides modify pass assignments when the organization has no child organizations', () => {
    const html = render({
      onEditDistribution: () => undefined,
      currentAllocations: [
        {
          organizationId: 'org-parent',
          organizationName: 'Acme',
          kind: 'parent',
          passCount: 6,
        },
      ],
      nextAllocations: [
        {
          organizationId: 'org-parent',
          organizationName: 'Acme',
          kind: 'parent',
          passCount: 6,
        },
      ],
    });

    expect(html).not.toContain('Modify pass assignments');
  });

  test('shows upcoming assignments only when pass counts will change', () => {
    const html = render({
      onResetDistribution: () => undefined,
      nextAllocations: [
        {
          organizationId: 'org-parent',
          organizationName: 'Acme',
          kind: 'parent',
          passCount: 4,
        },
        {
          organizationId: 'org-child',
          organizationName: 'Acme Child',
          kind: 'child',
          passCount: 2,
        },
      ],
    });

    expect(html).toContain('Upcoming Kilo Pass assignments');
    expect(html).toContain('Starts: Aug 27, 2026');
    expect(html).toContain('Reset pass assignments');
  });

  test('uses renewal capacity when a scheduled decrease makes assignments overallocated', () => {
    const html = render({
      totalPasses: 25,
      upcomingTotalPasses: 10,
      currentAllocations: [
        {
          organizationId: 'org-parent',
          organizationName: 'Acme',
          kind: 'parent',
          passCount: 5,
        },
        {
          organizationId: 'org-child',
          organizationName: 'Acme Child',
          kind: 'child',
          passCount: 20,
        },
      ],
      nextAllocations: [
        {
          organizationId: 'org-parent',
          organizationName: 'Acme',
          kind: 'parent',
          passCount: 0,
        },
        {
          organizationId: 'org-child',
          organizationName: 'Acme Child',
          kind: 'child',
          passCount: 20,
        },
      ],
    });

    expect(html).toContain('Upcoming Kilo Pass assignments');
    expect(html).toContain('Acme Child');
    expect(html).toContain('20');
  });

  test('does not preview unsaved modal assignments on the page', () => {
    const html = render({
      isEditing: true,
      editingAllocations: [
        {
          organizationId: 'org-parent',
          organizationName: 'Acme',
          kind: 'parent',
          passCount: 3,
        },
        {
          organizationId: 'org-child',
          organizationName: 'Acme Child',
          kind: 'child',
          passCount: 3,
        },
      ],
    });

    expect(html).not.toContain('Upcoming Kilo Pass assignments');
  });

  test('does not show reset assignments when there are no upcoming changes', () => {
    const html = render({ onResetDistribution: () => undefined });

    expect(html).not.toContain('Reset pass assignments');
  });

  test('shows reset progress while restoring current assignments', () => {
    const html = render({
      pendingAction: 'reset',
      onResetDistribution: () => undefined,
      nextAllocations: [
        {
          organizationId: 'org-parent',
          organizationName: 'Acme',
          kind: 'parent',
          passCount: 4,
        },
        {
          organizationId: 'org-child',
          organizationName: 'Acme Child',
          kind: 'child',
          passCount: 2,
        },
      ],
    });

    expect(html).toContain('Resetting assignments');
    expect(html).toContain('disabled=""');
  });

  test('detects an upcoming parent allocation when all current passes belong to children', () => {
    const html = render({
      currentAllocations: [
        {
          organizationId: 'org-child',
          organizationName: 'Acme Child',
          kind: 'child',
          passCount: 6,
        },
      ],
      nextAllocations: [
        {
          organizationId: 'org-parent',
          organizationName: 'Acme',
          kind: 'parent',
          passCount: 1,
        },
        {
          organizationId: 'org-child',
          organizationName: 'Acme Child',
          kind: 'child',
          passCount: 5,
        },
      ],
    });

    expect(html).toContain('Upcoming Kilo Pass assignments');
  });
});

describe('OrgKiloPassSetupView', () => {
  type SetupProps = Parameters<typeof OrgKiloPassSetupView>[0];

  function render(overrides: Partial<SetupProps> = {}) {
    const props: SetupProps = {
      organizationId: 'org-parent',
      organizationName: 'Acme',
      paidSeats: 6,
      cadence: 'monthly',
      renewalDate: 'Aug 27, 2026',
      selectedTier: 'tier_19',
      terms: [starterTerms],
      allocations: [
        {
          organizationId: 'org-parent',
          organizationName: 'Acme',
          kind: 'parent',
          passCount: 5,
        },
        {
          organizationId: 'org-child',
          organizationName: 'Acme Child',
          kind: 'child',
          passCount: 1,
        },
      ],
      quote: {
        recurringTotal: '$114/month',
        firstCharge: '$114',
      },
      onTierChange: () => undefined,
      onChildAllocationChange: () => undefined,
      onContinueToStripe: () => undefined,
      ...overrides,
    };

    return renderToStaticMarkup(
      React.createElement(PageTitleProvider, null, React.createElement(OrgKiloPassSetupView, props))
    );
  }

  function buttonTag(html: string, label: string): string {
    const labelIndex = html.indexOf(label);
    expect(labelIndex).toBeGreaterThan(-1);
    const start = html.lastIndexOf('<button', labelIndex);
    const end = html.indexOf('>', start);
    return html.slice(start, end);
  }

  test('shows no setup status badge next to the title', () => {
    const html = render();

    expect(html).toContain('Set up Kilo Pass for Organizations');
    expect(html).not.toContain('>Setup<');
  });

  test('matches the detail view subscription summary', () => {
    const html = render();

    expect(html).not.toContain('Subscription details');

    const tier = html.indexOf('Tier');
    const paidSeats = html.indexOf('Paid seats covered');
    const billing = html.indexOf('Billing schedule');
    const renewal = html.indexOf('Renews on');
    expect(tier).toBeGreaterThan(-1);
    expect(paidSeats).toBeGreaterThan(tier);
    expect(billing).toBeGreaterThan(paidSeats);
    expect(renewal).toBeGreaterThan(billing);
    expect(html).toContain('$19 monthly Credits per pass');
    expect(html).toContain('Billed with seats');
    expect(html).toContain('Aug 27, 2026');
  });

  test('explains the first charge with an accessible icon-only tooltip trigger', () => {
    const html = render();

    const firstCharge = html.indexOf('First charge');
    const trigger = buttonTag(html, 'About the first charge');
    expect(firstCharge).toBeGreaterThan(-1);
    expect(trigger).toContain('aria-label="About the first charge"');
    expect(trigger).toContain('focus-visible:ring-2');
  });

  test('explains the derived parent passes with an accessible tooltip trigger', () => {
    const html = render();

    const trigger = buttonTag(html, 'About the passes that stay with Acme');
    expect(trigger).toContain('aria-label="About the passes that stay with Acme"');
    expect(trigger).toContain('focus-visible:ring-2');
    expect(html.indexOf('About the passes that stay with Acme')).toBeGreaterThan(
      html.indexOf('aria-label="Acme passes"')
    );
  });

  test('presents child organizations as indented descendants without framed icons', () => {
    const html = render();

    expect(html).toContain('lucide-corner-down-right');
    expect(html).not.toContain('lucide-building-2');
    expect(html).not.toContain('lucide-git-branch');
    expect(html).not.toContain('keeps the remaining passes');
    expect(html).toContain('Child organization');
  });

  test('renders the derived parent pass count as read-only output, not an input', () => {
    const html = render();

    expect(html).not.toMatch(/<input[^>]*aria-label="Acme passes"/);
    expect(html).toMatch(/<output[^>]*aria-label="Acme passes"[^>]*>5</);
    expect(html).toMatch(/<input[^>]*aria-label="Acme Child passes"/);
  });

  test('renders the order summary with the selected tier, quote, and renewal date', () => {
    const html = render();

    expect(html).toContain('Order summary');
    expect(html).toContain('Starter × 6 passes');
    expect(html).toContain('$114/month');
    expect(html).toContain('First charge');
    expect(html).toContain('Renews Aug 27, 2026');
  });

  test('places the order summary after the setup controls so it stacks below them', () => {
    const html = render();
    const allocationEditor = html.indexOf('Choose where your first Credits go');
    const orderSummary = html.indexOf('Order summary');

    expect(allocationEditor).toBeGreaterThan(-1);
    expect(orderSummary).toBeGreaterThan(allocationEditor);
  });

  test('purchases directly without a separate review step', () => {
    const html = render();

    expect(html).toContain('Purchase Kilo Pass');
    expect(html).not.toContain('Review purchase');
  });

  test('drops the old allocation footer metrics', () => {
    const html = render();

    expect(html).not.toContain('Recurring total');
    expect(html).not.toContain('Initial period');
    expect(html).not.toContain('First Credits');
    expect(html).not.toContain('aria-label="About first Credits"');
  });

  test('enables the purchase action when the setup is valid', () => {
    const html = render();

    expect(buttonTag(html, 'Purchase Kilo Pass')).not.toContain('disabled=""');
  });

  test.each([
    ['a validation message', { validationMessage: 'Hierarchy changed.' }],
    [
      'overallocated passes',
      {
        allocations: [
          { organizationId: 'org-parent', organizationName: 'Acme', kind: 'parent', passCount: 0 },
          {
            organizationId: 'org-child',
            organizationName: 'Acme Child',
            kind: 'child',
            passCount: 7,
          },
        ],
      },
    ],
  ] satisfies Array<[string, Partial<SetupProps>]>)(
    'disables the purchase action while the setup has %s',
    (_label, overrides) => {
      const html = render(overrides);

      expect(buttonTag(html, 'Purchase Kilo Pass')).toContain('disabled=""');
    }
  );

  test('shows the submitting state on the purchase action', () => {
    const html = render({ isSubmitting: true });

    expect(html).toContain('Processing payment');
    expect(html).not.toContain('Purchase Kilo Pass');
    expect(buttonTag(html, 'Processing payment')).toContain('disabled=""');
  });
});

describe('OrgKiloPassActivationView', () => {
  function render(state: Parameters<typeof OrgKiloPassActivationView>[0]['state']) {
    return renderToStaticMarkup(
      React.createElement(OrgKiloPassActivationView, {
        state,
        title: `${state} title`,
        description: `${state} description`,
        actionLabel: 'Continue',
        onAction: () => undefined,
      })
    );
  }

  test('marks pending, activating, and failed states as busy for assistive technology', () => {
    expect(render('awaiting_payment')).toContain('aria-busy="true"');
    expect(render('activating')).toContain('aria-busy="true"');
    expect(render('failed')).toContain('aria-busy="true"');
  });

  test('does not mark action-required or terminal states as busy', () => {
    expect(render('requires_action')).toContain('aria-busy="false"');
    expect(render('blocked')).toContain('aria-busy="false"');
    expect(render('succeeded')).toContain('aria-busy="false"');
    expect(render('ended')).toContain('aria-busy="false"');
  });

  test('only shows the leave-safely hint while activation can still resolve on its own', () => {
    expect(render('failed')).toContain('You can leave this page safely');
    expect(render('blocked')).not.toContain('You can leave this page safely');
    expect(render('succeeded')).not.toContain('You can leave this page safely');
  });

  test('renders the action button for every state that provides one', () => {
    for (const state of ['requires_action', 'blocked', 'succeeded', 'ended'] as const) {
      expect(render(state)).toContain('Continue');
    }
  });
});
