import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { Button } from '@/components/Button';
import { usePostHog } from 'posthog-js/react';
import { useState } from 'react';
import { UpgradeTrialDialog } from '../UpgradeTrialDialog';

type Props = React.PropsWithChildren<{
  organizationId: string;
  variant?: React.ComponentProps<typeof Button>['variant'];
  className?: string;
}>;

export function CreateSubscriptionButton(props: Props) {
  const { organizationId, variant = 'primary', className } = props;
  const { data, isLoading, error } = useOrganizationWithMembers(organizationId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const hog = usePostHog();

  if (isLoading) {
    return (
      <Button disabled variant={variant} className={className}>
        {props.children || 'Loading...'}
      </Button>
    );
  }
  if (error || !data) {
    return null;
  }

  const buttonText = 'Create a subscription';

  const onClick = () => {
    hog?.capture('create_subscription_clicked', { organizationId });
    setDialogOpen(true);
  };

  return (
    <>
      <Button onClick={onClick} variant={variant} className={className}>
        {props.children ? props.children : buttonText}
      </Button>
      <UpgradeTrialDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        organizationId={organizationId}
        organizationName={data.name}
        currentPlan={data.plan}
      />
    </>
  );
}
