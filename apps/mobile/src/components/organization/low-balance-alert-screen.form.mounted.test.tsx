// The low balance alert screen's save contract: the switch writes at once, the
// fields write on blur and on submit under one all-valid rule, and a rejected
// write keeps the draft, names itself in localized copy and offers Retry.
import {
  boundary,
  calls,
  capSentence,
  emailsFieldOf,
  EMOJI_REJECTION,
  mountScreen,
  query,
  resetLowBalanceState,
  retryButtonOf,
  saveMutate,
  statusMessages,
  switchOf,
  thresholdFieldOf,
} from '@/components/organization/low-balance-alert-screen.test-helpers';
import { beforeEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';
import { act, type ReactTestRenderer } from '@/test/renderer';

beforeEach(() => {
  resetLowBalanceState();
});

/** The labels of the steps painted under a refusal line, in screen order. */
function stepLabels(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => String(node.type) === 'Pressable')
    .map(node => node.props.accessibilityLabel)
    .filter((label): label is string => typeof label === 'string');
}

const TRIAL_REFUSAL = Object.assign(new Error(ORGANIZATION_TRIAL_EXPIRED_MESSAGE), {
  data: { code: 'FORBIDDEN', message: ORGANIZATION_TRIAL_EXPIRED_MESSAGE },
});

describe('low balance alert screen form', () => {
  it('renders the pushed screen header instead of a sheet header', async () => {
    const { renderer, unmount } = await mountScreen();
    expect(renderer.root.findAll(node => String(node.type) === 'ScreenHeader')).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.type) === 'SheetHeader')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'Switch')).toHaveLength(1);
    unmount();
  });

  it('shows the required amount and stores nothing when the alert is switched on empty', async () => {
    query.data = { settings: {} };
    const { renderer, unmount } = await mountScreen();
    await act(() => {
      (switchOf(renderer).props.onValueChange as (value: boolean) => void)(true);
    });

    expect(saveMutate).not.toHaveBeenCalled();
    const threshold = thresholdFieldOf(renderer);
    // The placeholder must not read as a value the form already holds.
    expect(String(threshold.props.placeholder)).not.toMatch(/^[\d.,\s]+$/);
    expect(threshold.props.defaultValue).toBeUndefined();
    expect(threshold.props.error).toBe(i18n.t('organization.lowBalanceAlert.thresholdError'));
    // The prefilled signer address is valid, so only the amount names itself.
    expect(emailsFieldOf(renderer).props.error).toBeUndefined();
    unmount();
  });

  it('stores the whole draft when the alert is switched on with valid values', async () => {
    query.data = { settings: {} };
    const { renderer, unmount } = await mountScreen();
    await act(() => {
      (switchOf(renderer).props.onValueChange as (value: boolean) => void)(true);
    });
    expect(saveMutate).not.toHaveBeenCalled();

    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)('25');
    });
    await act(() => {
      (thresholdFieldOf(renderer).props.onBlur as () => void)();
    });

    expect(calls.list).toHaveLength(1);
    expect(calls.list[0]?.input).toEqual({
      enabled: true,
      minimum_balance: 25,
      minimum_balance_alert_email: ['owner@example.com'],
    });
    unmount();
  });

  it('writes the switch off at once and hides the fields', async () => {
    const { renderer, unmount } = await mountScreen();
    expect(thresholdFieldOf(renderer)).toBeDefined();

    await act(() => {
      (switchOf(renderer).props.onValueChange as (value: boolean) => void)(false);
    });

    expect(calls.list).toHaveLength(1);
    expect(calls.list[0]?.input).toEqual({ enabled: false });
    expect(
      renderer.root.findAll(
        node =>
          String(node.type) === 'FormField' &&
          node.props.label === i18n.t('organization.lowBalanceAlert.thresholdLabel')
      )
    ).toHaveLength(0);
    unmount();
  });

  it('commits the recipients on the keyboard submit', async () => {
    const { renderer, unmount } = await mountScreen();
    await act(() => {
      (emailsFieldOf(renderer).props.onChangeText as (value: string) => void)(
        'two@example.com, three@example.com'
      );
    });
    expect(saveMutate).not.toHaveBeenCalled();

    await act(() => {
      (emailsFieldOf(renderer).props.onSubmitEditing as () => void)();
    });

    expect(calls.list[0]?.input).toEqual({
      enabled: true,
      minimum_balance: 25,
      minimum_balance_alert_email: ['two@example.com', 'three@example.com'],
    });
    unmount();
  });

  it('names both invalid fields and stores nothing when the draft cannot be committed', async () => {
    const { renderer, unmount } = await mountScreen();
    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)('0');
    });
    await act(() => {
      (emailsFieldOf(renderer).props.onChangeText as (value: string) => void)('');
    });
    await act(() => {
      (emailsFieldOf(renderer).props.onBlur as () => void)();
    });

    expect(saveMutate).not.toHaveBeenCalled();
    expect(thresholdFieldOf(renderer).props.error).toBe(
      i18n.t('organization.lowBalanceAlert.thresholdError')
    );
    expect(emailsFieldOf(renderer).props.error).toBe(
      i18n.t('organization.lowBalanceAlert.emailsRequired')
    );
    unmount();
  });

  it('names an amount above the ceiling on the keystroke, then commits once corrected', async () => {
    const { renderer, unmount } = await mountScreen();
    const paste = '1'.repeat(300);
    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)(paste);
    });

    expect(thresholdFieldOf(renderer).props.error).toBe(capSentence());
    expect(
      (thresholdFieldOf(renderer).props.validate as (value: string) => string | null)(paste)
    ).toBe(capSentence());

    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)('250');
    });
    await act(() => {
      (thresholdFieldOf(renderer).props.onSubmitEditing as () => void)();
    });

    expect(thresholdFieldOf(renderer).props.error).toBeUndefined();
    expect(calls.list[0]?.input.minimum_balance).toBe(250);
    unmount();
  });

  it('names a stored amount above the ceiling before any interaction', async () => {
    query.data = {
      settings: {
        minimum_balance: 2_000_000_000,
        minimum_balance_alert_email: ['one@example.com'],
      },
    };
    const { renderer, unmount } = await mountScreen();
    expect(thresholdFieldOf(renderer).props.error).toBe(capSentence());
    // Nothing to commit at the mount: the seeded draft is the stored one, and
    // it is not written back until the person asks.
    expect(saveMutate).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps the draft and offers Retry after a rejected write', async () => {
    const { renderer, unmount } = await mountScreen();
    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)('250');
    });
    await act(() => {
      (thresholdFieldOf(renderer).props.onBlur as () => void)();
    });
    const first = calls.list[0];
    await act(() => {
      first?.options.onError?.(new Error('Failed to fetch'));
    });

    expect(statusMessages(renderer)).toContain(i18n.t('organization.lowBalanceAlert.saveError'));
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Failed to fetch');
    // A failure that is not the plan refusal offers no step.
    expect(stepLabels(renderer)).toEqual([]);

    const retry = retryButtonOf(renderer);
    expect(retry).toBeDefined();
    if (!retry) {
      throw new Error('the retry control did not render');
    }
    await act(() => {
      (retry.props.onPress as () => void)();
    });

    expect(calls.list).toHaveLength(2);
    expect(calls.list[1]?.input).toEqual(first?.input);
    unmount();
  });

  it('clears the rejection and its Retry when the retried write lands', async () => {
    const { renderer, unmount } = await mountScreen();
    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)('250');
    });
    await act(() => {
      (thresholdFieldOf(renderer).props.onBlur as () => void)();
    });
    await act(() => {
      calls.list[0]?.options.onError?.(new Error('Failed to fetch'));
    });
    expect(statusMessages(renderer)).toContain(i18n.t('organization.lowBalanceAlert.saveError'));

    const retry = retryButtonOf(renderer);
    if (!retry) {
      throw new Error('the retry control did not render');
    }
    await act(() => {
      (retry.props.onPress as () => void)();
    });
    await act(() => {
      calls.list[1]?.options.onSuccess?.();
    });

    // One outcome: the confirmation replaces the rejection instead of painting
    // beside its stale failure line and Retry.
    expect(statusMessages(renderer)).toContain(i18n.t('organizationGuardrails.statusSaved'));
    expect(statusMessages(renderer)).not.toContain(
      i18n.t('organization.lowBalanceAlert.saveError')
    );
    expect(retryButtonOf(renderer)).toBeUndefined();
    unmount();
  });

  it('puts a schema rejection on the recipient field instead of the server message', async () => {
    const { renderer, unmount } = await mountScreen();
    await act(() => {
      (emailsFieldOf(renderer).props.onChangeText as (value: string) => void)('owner@example.com');
    });
    await act(() => {
      (emailsFieldOf(renderer).props.onBlur as () => void)();
    });
    const first = calls.list[0];
    await act(() => {
      first?.options.onError?.(
        Object.assign(new Error(EMOJI_REJECTION), { data: { code: 'BAD_REQUEST' } })
      );
    });

    expect(statusMessages(renderer)).toContain(
      i18n.t('organization.lowBalanceAlert.saveEmailsError')
    );
    expect(statusMessages(renderer)).not.toContain(
      i18n.t('organization.lowBalanceAlert.saveError')
    );
    expect(JSON.stringify(renderer.toJSON())).not.toContain('invalid_format');
    // The rejection keeps the draft and its Retry usable.
    expect(retryButtonOf(renderer)).toBeDefined();
    unmount();
  });

  it('does not confirm a draft that moved on while a write was in flight', async () => {
    const { renderer, unmount } = await mountScreen();
    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)('30');
    });
    await act(() => {
      (thresholdFieldOf(renderer).props.onBlur as () => void)();
    });
    expect(calls.list).toHaveLength(1);

    // A newer draft asks to be written while the first request is still open:
    // it waits, and the first response must not confirm it.
    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)('40');
    });
    await act(() => {
      (thresholdFieldOf(renderer).props.onSubmitEditing as () => void)();
    });
    expect(calls.list).toHaveLength(1);

    await act(() => {
      calls.list[0]?.options.onSuccess?.();
    });
    expect(statusMessages(renderer)).not.toContain(i18n.t('organizationGuardrails.statusSaved'));
    expect(calls.list).toHaveLength(2);
    expect(calls.list[1]?.input.minimum_balance).toBe(40);

    await act(() => {
      calls.list[1]?.options.onSuccess?.();
    });
    expect(statusMessages(renderer)).toContain(i18n.t('organizationGuardrails.statusSaved'));
    unmount();
  });

  it('gives a billing role the plan refusal that offers the billing step', async () => {
    const { renderer, unmount } = await mountScreen();
    await act(() => {
      (thresholdFieldOf(renderer).props.onChangeText as (value: string) => void)('250');
    });
    await act(() => {
      (thresholdFieldOf(renderer).props.onBlur as () => void)();
    });
    await act(() => {
      calls.list[0]?.options.onError?.(TRIAL_REFUSAL);
    });

    expect(statusMessages(renderer)).toContain(i18n.t('common.organizationTrialEndedBilling'));
    expect(statusMessages(renderer)).not.toContain(i18n.t('common.organizationTrialEnded'));
    expect(stepLabels(renderer)).toEqual([i18n.t('organization.hub.manageBilling')]);
    unmount();
  });

  it('keeps a member out of the form, so no member reads the plan refusal here', async () => {
    boundary.role = 'member';
    const { renderer, unmount } = await mountScreen();

    expect(renderer.root.findAll(node => String(node.type) === 'PermissionDenied')).toHaveLength(1);
    expect(statusMessages(renderer)).toEqual([]);
    unmount();
  });
});
