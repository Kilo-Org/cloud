export type KiloPassInlineConfirmationAction = 'resume';

export type KiloPassInlineActionModel = {
  changePlanDisabled: boolean;
  resume: {
    nextAction: 'confirm-resume';
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
  hasResumeAction: boolean;
  hasCancelAction: boolean;
  isResumingSubscription: boolean;
  isOpeningCancelFlow: boolean;
  isCancelingSubscription: boolean;
}): KiloPassInlineActionModel {
  const cancelIsLoading = params.isOpeningCancelFlow || params.isCancelingSubscription;

  return {
    changePlanDisabled: params.hasScheduledChange,
    resume: params.hasResumeAction
      ? {
          nextAction: 'confirm-resume',
          disabled: params.isResumingSubscription,
        }
      : null,
    cancel:
      !params.hasResumeAction && params.hasCancelAction
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
}): KiloPassInlineConfirmationDetails | null {
  if (params.confirmationAction !== 'resume') return null;

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
