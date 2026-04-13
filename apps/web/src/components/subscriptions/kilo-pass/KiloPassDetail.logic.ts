export type KiloPassSubscriptionDisplayModel = {
  status: string;
  detailDateLabel: 'Next billing' | 'Active until' | 'Resumes on' | 'Resume date';
  detailDateValue: string;
  cardDateLabel: 'Renews at' | 'Active until' | 'Resumes on' | 'Resume date';
  cardDateValue: string;
  cardNotice: string | null;
  detailAlert: {
    title: 'Cancellation scheduled' | 'Subscription paused';
    description: string;
  } | null;
};

function getDatePhrase(params: { prefix: string; dateLabel: string }): string {
  return params.dateLabel && params.dateLabel !== '—'
    ? ` ${params.prefix} ${params.dateLabel}`
    : '';
}

export function getKiloPassSubscriptionDisplayModel(params: {
  status: string;
  cancelAtPeriodEnd: boolean;
  nextBillingLabel: string;
  resumesAtLabel: string;
}): KiloPassSubscriptionDisplayModel {
  if (params.cancelAtPeriodEnd) {
    const activeUntilPhrase = getDatePhrase({
      prefix: 'until',
      dateLabel: params.nextBillingLabel,
    });

    return {
      status: 'pending_cancellation',
      detailDateLabel: 'Active until',
      detailDateValue: params.nextBillingLabel,
      cardDateLabel: 'Active until',
      cardDateValue: params.nextBillingLabel,
      cardNotice: `Cancellation scheduled. Access stays active${activeUntilPhrase}.`,
      detailAlert: {
        title: 'Cancellation scheduled',
        description: `Your Kilo Pass stays active${activeUntilPhrase} and will not renew unless you resume the subscription.`,
      },
    };
  }

  if (params.status === 'paused') {
    const resumesOnPhrase = getDatePhrase({ prefix: 'on', dateLabel: params.resumesAtLabel });
    const hasResumeDate = resumesOnPhrase !== '';
    return {
      status: params.status,
      detailDateLabel: hasResumeDate ? 'Resumes on' : 'Resume date',
      detailDateValue: hasResumeDate ? params.resumesAtLabel : 'Not available',
      cardDateLabel: hasResumeDate ? 'Resumes on' : 'Resume date',
      cardDateValue: hasResumeDate ? params.resumesAtLabel : 'Not available',
      cardNotice: hasResumeDate
        ? `Subscription paused. It will automatically resume${resumesOnPhrase}.`
        : 'Subscription paused. Resume timing is not available yet.',
      detailAlert: {
        title: 'Subscription paused',
        description: hasResumeDate
          ? `Your Kilo Pass is paused and will automatically resume${resumesOnPhrase}.`
          : 'Your Kilo Pass is paused, but the resume date is not available yet.',
      },
    };
  }

  return {
    status: params.status,
    detailDateLabel: 'Next billing',
    detailDateValue: params.nextBillingLabel,
    cardDateLabel: 'Renews at',
    cardDateValue: params.nextBillingLabel,
    cardNotice: null,
    detailAlert: null,
  };
}

export type KiloPassInlineConfirmationAction = 'resume' | 'resumePaused';

export type KiloPassInlinePrimaryAction = 'resume' | 'resumePaused' | 'cancel' | 'none';

export type KiloPassInlineActionModel = {
  changePlanDisabled: boolean;
  resume: {
    nextAction: 'confirm-resume';
    disabled: boolean;
  } | null;
  resumePaused: {
    nextAction: 'confirm-resume-paused';
    disabled: boolean;
  } | null;
  cancel: {
    nextAction: 'open-cancel-flow';
    disabled: boolean;
    label: string;
    isLoading: boolean;
  } | null;
};

export function getKiloPassInlineActionModel(params: {
  hasScheduledChange: boolean;
  primaryAction: KiloPassInlinePrimaryAction;
  isResumingSubscription: boolean;
  isOpeningCancelFlow: boolean;
  isCancelingSubscription: boolean;
}): KiloPassInlineActionModel {
  const cancelIsLoading = params.isOpeningCancelFlow || params.isCancelingSubscription;

  return {
    changePlanDisabled: params.hasScheduledChange,
    resume:
      params.primaryAction === 'resume'
        ? {
            nextAction: 'confirm-resume',
            disabled: params.isResumingSubscription,
          }
        : null,
    resumePaused:
      params.primaryAction === 'resumePaused'
        ? {
            nextAction: 'confirm-resume-paused',
            disabled: params.isResumingSubscription,
          }
        : null,
    cancel:
      params.primaryAction === 'cancel'
        ? {
            nextAction: 'open-cancel-flow',
            disabled: cancelIsLoading,
            label: params.isOpeningCancelFlow
              ? 'Opening cancellation flow'
              : params.isCancelingSubscription
                ? 'Canceling subscription'
                : 'Cancel Subscription',
            isLoading: cancelIsLoading,
          }
        : null,
  };
}

export type KiloPassInlineConfirmationDetails = {
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  confirmVariant: 'default';
  action: () => Promise<void>;
};

export function getKiloPassInlineConfirmationDetails(params: {
  confirmationAction: KiloPassInlineConfirmationAction | null;
  onResume: () => Promise<void>;
  onResumePaused: () => Promise<void>;
}): KiloPassInlineConfirmationDetails | null {
  if (params.confirmationAction === 'resume') {
    return {
      title: 'Resume subscription?',
      description:
        'This removes the pending cancellation so your Kilo Pass subscription keeps renewing automatically.',
      confirmLabel: 'Resume Subscription',
      pendingLabel: 'Resuming subscription',
      confirmVariant: 'default',
      action: params.onResume,
    };
  }

  if (params.confirmationAction === 'resumePaused') {
    return {
      title: 'Resume subscription?',
      description:
        'This ends the pause now so your Kilo Pass subscription resumes before the scheduled resume date.',
      confirmLabel: 'Resume Subscription',
      pendingLabel: 'Resuming subscription',
      confirmVariant: 'default',
      action: params.onResumePaused,
    };
  }

  return null;
}
