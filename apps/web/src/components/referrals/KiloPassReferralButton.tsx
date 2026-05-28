import Link from 'next/link';
import { Gift } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function KiloPassReferralButton({ className }: { className?: string }) {
  return (
    <Button asChild variant="outline" className={cn('h-9 gap-2 pr-2.5', className)}>
      <Link href="/subscriptions/kilo-pass/refer">
        <Gift className="size-4" aria-hidden="true" />
        <span>Refer &amp; earn</span>
        <span className="bg-brand-primary text-primary-foreground rounded-full px-1.5 py-0.5 text-[10px] leading-none font-bold tracking-wide uppercase ring-1 ring-brand-primary/30">
          New
        </span>
      </Link>
    </Button>
  );
}
