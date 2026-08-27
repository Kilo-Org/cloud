import { describe, expect, test } from '@jest/globals';
import {
  CALENDAR_MONTH_UTC_V1,
  MAX_ORGANIZATION_ALERT_RECIPIENTS,
  type MonthlySpendingAlertConfiguration,
} from '@/lib/organizations/alerts/organization-alerts';
import {
  addMonthlySpendingRecipient,
  buildMonthlySpendingSubmission,
  monthlySpendingAdmissionNotice,
  monthlySpendingDisclosureRequired,
  monthlySpendingFormState,
  type MonthlySpendingFormState,
} from './monthly-spending-form';

function configuration(
  overrides: Partial<MonthlySpendingAlertConfiguration> = {}
): MonthlySpendingAlertConfiguration {
  return {
    thresholdMicrodollars: 500_000_000,
    period: CALENDAR_MONTH_UTC_V1,
    scope: { type: 'organization' },
    recipients: ['finance@example.com'],
    ...overrides,
  };
}

function formState(overrides: Partial<MonthlySpendingFormState> = {}): MonthlySpendingFormState {
  return { ...monthlySpendingFormState(configuration()), ...overrides };
}

describe('monthlySpendingFormState', () => {
  test('shows a saved threshold as two-decimal text and keeps its recipients', () => {
    expect(
      monthlySpendingFormState(configuration({ thresholdMicrodollars: 1_234_500_000 }))
    ).toEqual({
      thresholdUsd: '1234.50',
      scopeType: 'organization',
      groupId: null,
      recipients: ['finance@example.com'],
      pendingRecipient: '',
      disclosureConfirmed: false,
    });
  });

  test('reads a group scope into the group picker', () => {
    const groupId = '00000000-0000-4000-8000-000000000000';
    const state = monthlySpendingFormState(configuration({ scope: { type: 'group', groupId } }));
    expect(state.scopeType).toBe('group');
    expect(state.groupId).toBe(groupId);
  });

  test('opens the amount empty for an alert that has no threshold yet', () => {
    expect(monthlySpendingFormState(configuration({ thresholdMicrodollars: 0 })).thresholdUsd).toBe(
      ''
    );
  });
});

describe('addMonthlySpendingRecipient', () => {
  test('normalizes the added address', () => {
    expect(
      addMonthlySpendingRecipient(
        formState({ recipients: [], pendingRecipient: '  Ops@Example.COM ' })
      )
    ).toEqual({ ok: true, recipients: ['ops@example.com'] });
  });

  test('rejects an invalid address', () => {
    const result = addMonthlySpendingRecipient(formState({ pendingRecipient: 'not-an-email' }));
    expect(result.ok).toBe(false);
  });

  test('rejects an address that is already configured, after normalization', () => {
    const result = addMonthlySpendingRecipient(
      formState({ recipients: ['ops@example.com'], pendingRecipient: 'OPS@example.com' })
    );
    expect(result).toEqual({ ok: false, error: 'This address is already a recipient.' });
  });

  test('rejects an address beyond the ten-recipient limit', () => {
    const recipients = Array.from(
      { length: MAX_ORGANIZATION_ALERT_RECIPIENTS },
      (_value, index) => `person${index}@example.com`
    );
    const result = addMonthlySpendingRecipient(
      formState({ recipients, pendingRecipient: 'one-too-many@example.com' })
    );
    expect(result.ok).toBe(false);
  });
});

describe('monthlySpendingAdmissionNotice', () => {
  test('stays silent below the alert-period admission cap', () => {
    expect(monthlySpendingAdmissionNotice(MAX_ORGANIZATION_ALERT_RECIPIENTS - 1)).toBeNull();
  });

  test('explains that a newly added address waits for the next month at the cap', () => {
    expect(monthlySpendingAdmissionNotice(MAX_ORGANIZATION_ALERT_RECIPIENTS)).toMatch(
      /cannot receive this alert until the next month/
    );
  });
});

describe('monthlySpendingDisclosureRequired', () => {
  const saved = configuration();

  test('always requires confirmation for a new alert', () => {
    expect(
      monthlySpendingDisclosureRequired({
        mode: 'create',
        saved: configuration({ recipients: [] }),
        state: formState({ recipients: [] }),
      })
    ).toBe(true);
  });

  test('requires confirmation when an edit adds an address', () => {
    expect(
      monthlySpendingDisclosureRequired({
        mode: 'edit',
        saved,
        state: formState({ recipients: ['finance@example.com', 'new@example.com'] }),
      })
    ).toBe(true);
  });

  test('does not require confirmation when an edit only removes addresses', () => {
    expect(
      monthlySpendingDisclosureRequired({
        mode: 'edit',
        saved: configuration({ recipients: ['finance@example.com', 'ops@example.com'] }),
        state: formState({ recipients: ['ops@example.com'] }),
      })
    ).toBe(false);
  });
});

describe('buildMonthlySpendingSubmission', () => {
  const saved = configuration();

  test('converts the typed amount to microdollars and carries the saved period', () => {
    const result = buildMonthlySpendingSubmission({
      mode: 'edit',
      saved,
      requireRecipient: true,
      state: formState({ thresholdUsd: '$1,000.05', recipients: ['finance@example.com'] }),
    });

    expect(result).toEqual({
      ok: true,
      recipientDisclosureConfirmed: false,
      definition: {
        type: 'monthly_spending',
        configuration: {
          thresholdMicrodollars: 1_000_050_000,
          period: CALENDAR_MONTH_UTC_V1,
          scope: { type: 'organization' },
          recipients: ['finance@example.com'],
        },
      },
    });
  });

  test('carries a group scope through to the submitted definition', () => {
    const groupId = '00000000-0000-4000-8000-000000000000';
    const result = buildMonthlySpendingSubmission({
      mode: 'edit',
      saved,
      requireRecipient: true,
      state: formState({
        scopeType: 'group',
        groupId,
        thresholdUsd: '500.00',
        recipients: ['finance@example.com'],
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      definition: { configuration: { scope: { type: 'group', groupId } } },
    });
  });

  test('falls back to organization scope when a group scope has no group chosen', () => {
    const result = buildMonthlySpendingSubmission({
      mode: 'edit',
      saved,
      requireRecipient: true,
      state: formState({ scopeType: 'group', groupId: null }),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.scope).toBeDefined();
  });

  test('reports an unusable amount against the amount field', () => {
    const result = buildMonthlySpendingSubmission({
      mode: 'edit',
      saved,
      requireRecipient: true,
      state: formState({ thresholdUsd: '0' }),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.thresholdUsd).toBeDefined();
  });

  test('refuses to silently drop an address that was typed but not added', () => {
    const result = buildMonthlySpendingSubmission({
      mode: 'edit',
      saved,
      requireRecipient: true,
      state: formState({ pendingRecipient: 'forgotten@example.com' }),
    });

    expect(result.ok === false && result.errors.pendingRecipient).toBeDefined();
  });

  test('requires a recipient for an enabled alert but not for a disabled one', () => {
    const state = formState({ recipients: [] });

    expect(
      buildMonthlySpendingSubmission({ mode: 'edit', saved, requireRecipient: true, state }).ok
    ).toBe(false);
    expect(
      buildMonthlySpendingSubmission({ mode: 'edit', saved, requireRecipient: false, state }).ok
    ).toBe(true);
  });

  test('requires disclosure confirmation for a new alert and passes it to the router', () => {
    const state = formState({ recipients: ['finance@example.com'] });
    const create = { mode: 'create' as const, saved: configuration({ recipients: [] }) };

    expect(buildMonthlySpendingSubmission({ ...create, requireRecipient: true, state }).ok).toBe(
      false
    );
    expect(
      buildMonthlySpendingSubmission({
        ...create,
        requireRecipient: true,
        state: { ...state, disclosureConfirmed: true },
      })
    ).toMatchObject({ ok: true, recipientDisclosureConfirmed: true });
  });
});
