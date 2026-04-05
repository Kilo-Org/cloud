import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { getPaymentMethodBadgeVariant, getPaymentMethodStatusDescription } from '@/lib/admin-utils';
import type { PaymentMethodStatus } from '@/types/admin';

interface PaymentMethodStatusBadgeProps {
  paymentMethodStatus?: PaymentMethodStatus;
}

export function PaymentMethodStatusBadge({ paymentMethodStatus }: PaymentMethodStatusBadgeProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={getPaymentMethodBadgeVariant(paymentMethodStatus)}>
          {paymentMethodStatus}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{getPaymentMethodStatusDescription(paymentMethodStatus)}</TooltipContent>
    </Tooltip>
  );
}
