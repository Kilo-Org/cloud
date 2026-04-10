import { describe, expect, test } from '@jest/globals';

import {
  getKiloPassSubscriptionDisplayModel,
  getKiloPassInlineActionModel,
  getKiloPassInlineConfirmationDetails,
} from './KiloPassDetail.logic';

describe('KiloPassDetail.logic', () => {
  test('models pending cancellation display copy', () => {
    const model = getKiloPassSubscriptionDisplayModel({
      status: 'active',
      cancelAtPeriodEnd: true,
      nextBillingLabel: 'May 10, 2026',
      resumesAtLabel: '—',
    });

    expect(model).toEqual({
      status: 'pending_cancellation',
      detailDateLabel: 'Active until',
      detailDateValue: 'May 10, 2026',
      cardDateLabel: 'Active until',
      cardDateValue: 'May 10, 2026',
      cardNotice: 'Cancellation scheduled. Access stays active until May 10, 2026.',
      detailAlert: {
        title: 'Cancellation scheduled',
        description:
          'Your Kilo Pass stays active until May 10, 2026 and will not renew unless you resume the subscription.',
      },
    });
  });

  test('models pending cancellation before paused display copy', () => {
    const model = getKiloPassSubscriptionDisplayModel({
      status: 'paused',
      cancelAtPeriodEnd: true,
      nextBillingLabel: 'May 10, 2026',
      resumesAtLabel: 'Jun 10, 2026',
    });

    expect(model).toEqual({
      status: 'pending_cancellation',
      detailDateLabel: 'Active until',
      detailDateValue: 'May 10, 2026',
      cardDateLabel: 'Active until',
      cardDateValue: 'May 10, 2026',
      cardNotice: 'Cancellation scheduled. Access stays active until May 10, 2026.',
      detailAlert: {
        title: 'Cancellation scheduled',
        description:
          'Your Kilo Pass stays active until May 10, 2026 and will not renew unless you resume the subscription.',
      },
    });
  });

  test('models paused display copy', () => {
    const model = getKiloPassSubscriptionDisplayModel({
      status: 'paused',
      cancelAtPeriodEnd: false,
      nextBillingLabel: 'May 10, 2026',
      resumesAtLabel: 'Jun 10, 2026',
    });

    expect(model).toEqual({
      status: 'paused',
      detailDateLabel: 'Resumes on',
      detailDateValue: 'Jun 10, 2026',
      cardDateLabel: 'Resumes on',
      cardDateValue: 'Jun 10, 2026',
      cardNotice: 'Subscription paused. It will automatically resume on Jun 10, 2026.',
      detailAlert: {
        title: 'Subscription paused',
        description: 'Your Kilo Pass is paused and will automatically resume on Jun 10, 2026.',
      },
    });
  });

  test('models paused copy when resume date is unavailable', () => {
    const model = getKiloPassSubscriptionDisplayModel({
      status: 'paused',
      cancelAtPeriodEnd: false,
      nextBillingLabel: 'May 10, 2026',
      resumesAtLabel: '—',
    });

    expect(model).toEqual({
      status: 'paused',
      detailDateLabel: 'Resume date',
      detailDateValue: 'Not available',
      cardDateLabel: 'Resume date',
      cardDateValue: 'Not available',
      cardNotice: 'Subscription paused. Resume timing is not available yet.',
      detailAlert: {
        title: 'Subscription paused',
        description: 'Your Kilo Pass is paused, but the resume date is not available yet.',
      },
    });
  });

  test('keeps active renewal display when cancellation is not pending', () => {
    const model = getKiloPassSubscriptionDisplayModel({
      status: 'active',
      cancelAtPeriodEnd: false,
      nextBillingLabel: 'May 10, 2026',
      resumesAtLabel: '—',
    });

    expect(model).toEqual({
      status: 'active',
      detailDateLabel: 'Next billing',
      detailDateValue: 'May 10, 2026',
      cardDateLabel: 'Renews at',
      cardDateValue: 'May 10, 2026',
      cardNotice: null,
      detailAlert: null,
    });
  });

  test('maps cancel to the Churnkey opener action', () => {
    const model = getKiloPassInlineActionModel({
      hasScheduledChange: false,
      primaryAction: 'cancel',
      isResumingSubscription: false,
      isOpeningCancelFlow: false,
      isCancelingSubscription: false,
    });

    expect(model.cancel).toEqual({
      nextAction: 'open-cancel-flow',
      disabled: false,
      label: 'Cancel Subscription',
      isLoading: false,
    });
    expect(model.resume).toBeNull();
  });

  test('maps paused resume to the confirmation dialog', () => {
    const model = getKiloPassInlineActionModel({
      hasScheduledChange: false,
      primaryAction: 'resumePaused',
      isResumingSubscription: false,
      isOpeningCancelFlow: false,
      isCancelingSubscription: false,
    });

    expect(model.resumePaused).toEqual({ nextAction: 'confirm-resume-paused', disabled: false });
    expect(model.resume).toBeNull();
    expect(model.cancel).toBeNull();
  });

  test('disables paused resume while resuming', () => {
    const model = getKiloPassInlineActionModel({
      hasScheduledChange: false,
      primaryAction: 'resumePaused',
      isResumingSubscription: true,
      isOpeningCancelFlow: false,
      isCancelingSubscription: false,
    });

    expect(model.resumePaused).toEqual({ nextAction: 'confirm-resume-paused', disabled: true });
  });

  test('paused resume confirmation confirms through the paused resume callback', async () => {
    const resumeCalls: string[] = [];
    const details = getKiloPassInlineConfirmationDetails({
      confirmationAction: 'resumePaused',
      onResume: async () => {
        resumeCalls.push('resume');
      },
      onResumePaused: async () => {
        resumeCalls.push('resumePaused');
      },
    });

    expect(details?.title).toBe('Resume subscription?');
    expect(details?.description).toBe(
      'This ends the pause now so your Kilo Pass subscription resumes before the scheduled resume date.'
    );
    if (!details) {
      throw new Error('Expected paused resume confirmation details');
    }
    await details.action();
    expect(resumeCalls).toEqual(['resumePaused']);
  });

  test('maps resume to the confirmation dialog and confirms through the resume callback', async () => {
    const resumeCalls: string[] = [];
    const model = getKiloPassInlineActionModel({
      hasScheduledChange: false,
      primaryAction: 'resume',
      isResumingSubscription: false,
      isOpeningCancelFlow: false,
      isCancelingSubscription: false,
    });

    expect(model.resume).toEqual({ nextAction: 'confirm-resume', disabled: false });
    expect(model.cancel).toBeNull();

    const details = getKiloPassInlineConfirmationDetails({
      confirmationAction: 'resume',
      onResume: async () => {
        resumeCalls.push('resume');
      },
      onResumePaused: async () => {
        resumeCalls.push('resumePaused');
      },
    });

    expect(details?.title).toBe('Resume subscription?');
    if (!details) {
      throw new Error('Expected resume confirmation details');
    }
    await details.action();
    expect(resumeCalls).toEqual(['resume']);
  });

  test('models Churnkey-opening loading and disabled cancel state', () => {
    const model = getKiloPassInlineActionModel({
      hasScheduledChange: false,
      primaryAction: 'cancel',
      isResumingSubscription: false,
      isOpeningCancelFlow: true,
      isCancelingSubscription: false,
    });

    expect(model.cancel).toEqual({
      nextAction: 'open-cancel-flow',
      disabled: true,
      label: 'Opening cancellation flow',
      isLoading: true,
    });
  });

  test('models direct-cancel fallback loading and disabled cancel state', () => {
    const model = getKiloPassInlineActionModel({
      hasScheduledChange: false,
      primaryAction: 'cancel',
      isResumingSubscription: false,
      isOpeningCancelFlow: false,
      isCancelingSubscription: true,
    });

    expect(model.cancel).toEqual({
      nextAction: 'open-cancel-flow',
      disabled: true,
      label: 'Canceling subscription',
      isLoading: true,
    });
  });

  test('disables plan changes while a scheduled change exists', () => {
    const model = getKiloPassInlineActionModel({
      hasScheduledChange: true,
      primaryAction: 'none',
      isResumingSubscription: false,
      isOpeningCancelFlow: false,
      isCancelingSubscription: false,
    });

    expect(model.changePlanDisabled).toBe(true);
  });
});
