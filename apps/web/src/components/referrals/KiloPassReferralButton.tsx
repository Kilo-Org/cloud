'use client';

import Link from 'next/link';
import { Gift } from 'lucide-react';
import { usePostHog } from 'posthog-js/react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function KiloPassReferralButton({
  className,
  source,
}: {
  className?: string;
  source: string;
}) {
  const posthog = usePostHog();

  function handleClick() {
    posthog?.capture('kilo_pass_referral_button_clicked', { source });
  }

  return (
    <Button asChild variant="brand" className={cn('h-9 gap-2 pr-2.5', className)}>
      <Link href="/subscriptions/kilo-pass/refer" onClick={handleClick}>
        <Gift className="size-4" aria-hidden="true" />
        <span>Refer &amp; earn</span>
        <span className="bg-primary-foreground text-brand-primary rounded-full px-1.5 py-0.5 text-[10px] leading-none font-bold tracking-wide uppercase ring-1 ring-primary-foreground/30">
          New
        </span>
      </Link>
    </Button>
  );
}
