import Link from 'next/link';
import { Gift } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function KiloPassReferralButton({ className }: { className?: string }) {
  return (
    <Button asChild variant="outline" className={cn('h-9 gap-2', className)}>
      <Link href="/subscriptions/kilo-pass/refer">
        <Gift className="size-4" aria-hidden="true" />
        <span>Refer &amp; earn</span>
      </Link>
    </Button>
  );
}
