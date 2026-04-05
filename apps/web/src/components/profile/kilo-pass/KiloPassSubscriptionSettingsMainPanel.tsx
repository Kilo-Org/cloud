import { ExternalLink, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

type ActionLabel = {
  label: string;
};

type MainPanelProps = {
  hasScheduledChange: boolean;
  onCancelPendingChange: () => void;
  isCancelingPendingChange: boolean;
  onUpdateSubscription: () => void;
  isUpdateSubscriptionDisabled: boolean;
  onManagePaymentMethod: () => void;
  isOpeningCustomerPortal: boolean;
  resumeAction: ActionLabel | null | undefined;
  cancelAction: ActionLabel | null | undefined;
  onResumeSubscription: () => void;
  onOpenCancelSubscription: () => void;
  isResumingSubscription: boolean;
  isCancelingSubscription: boolean;
};

export function MainPanel(props: MainPanelProps) {
  const {
    hasScheduledChange,
    onCancelPendingChange,
    isCancelingPendingChange,
    onUpdateSubscription,
    isUpdateSubscriptionDisabled,
    onManagePaymentMethod,
    isOpeningCustomerPortal,
    resumeAction,
    cancelAction,
    onResumeSubscription,
    onOpenCancelSubscription,
    isResumingSubscription,
    isCancelingSubscription,
  } = props;

  return (
    <div className="grid gap-3">
      {hasScheduledChange ? (
        <Button
          variant="outline"
          className="w-full justify-between"
          onClick={onCancelPendingChange}
          disabled={isCancelingPendingChange}
        >
          <span>
            {isCancelingPendingChange ? 'Canceling pending change' : 'Cancel pending change'}
          </span>
        </Button>
      ) : (
        <Button
          variant="outline"
          className="w-full justify-between"
          onClick={onUpdateSubscription}
          disabled={isUpdateSubscriptionDisabled}
        >
          <span>Update subscription</span>
        </Button>
      )}

      <Button
        variant="outline"
        className="w-full justify-between"
        onClick={onManagePaymentMethod}
        disabled={isOpeningCustomerPortal}
      >
        <span>Manage payment method</span>
        {isOpeningCustomerPortal ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ExternalLink className="h-4 w-4" />
        )}
      </Button>

      {resumeAction ? (
        <Button
          variant="default"
          className="w-full justify-center"
          onClick={onResumeSubscription}
          disabled={isResumingSubscription}
        >
          {resumeAction.label}
        </Button>
      ) : cancelAction ? (
        <Button
          variant="destructive"
          className="w-full justify-center"
          onClick={onOpenCancelSubscription}
          disabled={isCancelingSubscription}
        >
          {cancelAction.label}
        </Button>
      ) : null}
    </div>
  );
}
