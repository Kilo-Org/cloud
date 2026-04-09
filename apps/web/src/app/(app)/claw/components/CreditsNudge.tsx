'use client';

import { useRef, useState } from 'react';
import { CreditCard, Gift, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { setClawReturnUrl } from './CreditsNudge.actions';

const AMOUNT_OPTIONS = [10, 20, 50] as const;

export function CreditsNudge({
  selectedModel,
  returnPath = '/claw/new',
  onSwitchToFree,
}: {
  selectedModel: string;
  returnPath?: string;
  onSwitchToFree: () => void;
}) {
  const [selectedAmount, setSelectedAmount] = useState<number>(10);
  // Plain boolean that stays true once set — the form submit navigates
  // away, so we never need to reset it. Using useTransition would flicker
  // because submitting resets when the server action finishes, before the
  // browser has actually navigated.
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  async function handlePurchase() {
    setSubmitting(true);
    await setClawReturnUrl(selectedModel, returnPath);
    formRef.current?.submit();
  }

  return (
    <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-4">
      <div className="mb-1 flex items-center gap-2">
        <TriangleAlert className="h-5 w-5 shrink-0 text-yellow-400" />
        <span className="text-sm font-bold">You need credits to use this model</span>
      </div>
      <p className="text-muted-foreground mb-4 text-sm">
        Add a small balance and your bot will be ready to go.
      </p>

      {/* Amount selector */}
      <div className="mb-3 grid grid-cols-3 gap-2">
        {AMOUNT_OPTIONS.map(amount => (
          <button
            key={amount}
            type="button"
            disabled={submitting}
            onClick={() => setSelectedAmount(amount)}
            className={cn(
              'rounded-lg border py-2.5 text-sm font-medium transition-colors',
              amount === selectedAmount
                ? 'border-blue-500 bg-blue-500/10 text-blue-300'
                : 'border-border bg-background hover:bg-accent'
            )}
          >
            ${amount}
          </button>
        ))}
      </div>

      {/* Hidden form for POST to /payments/topup */}
      <form
        ref={formRef}
        action={`/payments/topup?amount=${selectedAmount}&cancel-path=${encodeURIComponent(returnPath)}`}
        method="post"
        className="hidden"
      />

      {/* Purchase CTA */}
      <Button
        type="button"
        onClick={handlePurchase}
        disabled={submitting}
        className="w-full bg-emerald-600 py-5 text-white hover:bg-emerald-700"
      >
        <CreditCard className="h-4 w-4" />
        {submitting ? 'Redirecting...' : `Add $${selectedAmount} & get started`}
      </Button>

      {/* Divider */}
      <div className="my-3 flex items-center gap-3">
        <hr className="grow opacity-30" />
        <span className="text-muted-foreground text-xs">or</span>
        <hr className="grow opacity-30" />
      </div>

      {/* Free model fallback */}
      <Button
        type="button"
        variant="outline"
        onClick={onSwitchToFree}
        disabled={submitting}
        className="w-full py-5"
      >
        <Gift className="h-4 w-4" />
        Use the Kilo Auto: Free model instead
      </Button>
    </div>
  );
}
