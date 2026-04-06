'use client';

import { useState } from 'react';
import { CreditCard } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export function StripePortalLink({
  onOpenPortal,
  label = 'Manage Payment Method',
  variant = 'outline',
}: {
  onOpenPortal: () => Promise<string>;
  label?: string;
  variant?: React.ComponentProps<typeof Button>['variant'];
}) {
  const [isPending, setIsPending] = useState(false);

  async function handleClick() {
    if (isPending) return;
    setIsPending(true);
    try {
      const url = await onOpenPortal();
      window.location.href = url;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to open Stripe portal');
      setIsPending(false);
    }
  }

  return (
    <Button variant={variant} onClick={handleClick} disabled={isPending}>
      <CreditCard className="h-4 w-4" />
      {isPending ? 'Opening...' : label}
    </Button>
  );
}
