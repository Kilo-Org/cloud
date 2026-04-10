import { describe, expect, test } from '@jest/globals';

import {
  getKiloPassInlineActionModel,
  getKiloPassInlineConfirmationDetails,
} from './KiloPassDetail.logic';

describe('KiloPassDetail.logic', () => {
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
