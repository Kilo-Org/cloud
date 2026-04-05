'use client';

import type { FormEvent } from 'react';
import { useCallback, useState } from 'react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog';
import { Input } from '../ui/input';
import {
  MAXIMUM_TOP_UP_AMOUNT,
  MINIMUM_TOP_UP_AMOUNT,
  FIRST_TOPUP_BONUS_AMOUNT,
  PROMO_CREDIT_EXPIRY_HRS,
} from '@/lib/constants';
import { formatDollars } from '@/lib/utils';
import { FirstTopupBonusPromo } from './FirstTopupBonusPromo';
import { AlertTriangle, Coins } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { FirstTopup24for24CountdownTimer } from '@/components/payment/FirstTopup24for24CountdownTimer';

/**
 * NOTE: Crypto payment support (Coinbase Commerce) was removed in January 2026.
 * This component now only supports Stripe payments.
 */
type CreditPurchaseOptionsProps = {
  amounts?: number[];
  organizationId?: string;
  isFirstPurchase?: boolean;
  // Deprecated, use isFirstPurchase instead
  showOrganizationWarning?: boolean;
  redirectUrl?: string;
};

const OrgPurchasWarning = () => {
  return (
    <div className="bg-background flex items-start gap-2 rounded-md border border-gray-700 p-3">
      <AlertTriangle className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
      <div className="text-muted-foreground text-xs">
        Personal credits are for your account only. Need organization credits?{' '}
        <Link className="text-blue-400 hover:underline" href="/organizations">
          Buy here
        </Link>
      </div>
    </div>
  );
};

const DEFAULT_AMOUNTS = [20, 50, 100];
const FIRST_TOPUP_AMOUNTS = [10, 20, 100];

export default function CreditPurchaseOptions({
  amounts = DEFAULT_AMOUNTS,
  isFirstPurchase,
  organizationId,
  redirectUrl,
  showOrganizationWarning = false,
}: CreditPurchaseOptionsProps) {
  // Use hasNoTopups if provided, otherwise fall back to isFirstPurchase for backward compatibility
  const showFirstPurchasePromo = isFirstPurchase;
  const purchaseAmounts = showFirstPurchasePromo ? FIRST_TOPUP_AMOUNTS : amounts;
  const [submitting, setSubmitting] = useState(false);
  const [customAmount, setCustomAmount] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [customAmountError, setCustomAmountError] = useState('');
  const [showValidationError, setShowValidationError] = useState(false);
  const [isHighlighted, setIsHighlighted] = useState(false);
  const [animatingButton, setAnimatingButton] = useState<string | null>(null);
  const [rippleOrigin, setRippleOrigin] = useState({ x: 50, y: 50 });

  const validateCustomAmount = (value: string) => {
    if (!value.trim()) {
      return 'Please enter an amount';
    }

    const amount = parseFloat(value);
    if (isNaN(amount)) {
      return 'Please enter a valid number';
    }

    if (amount < MINIMUM_TOP_UP_AMOUNT) {
      return `Minimum amount is ${formatDollars(MINIMUM_TOP_UP_AMOUNT)}`;
    }

    if (amount > MAXIMUM_TOP_UP_AMOUNT) {
      return `Maximum amount is ${formatDollars(MAXIMUM_TOP_UP_AMOUNT)}`;
    }

    // Check for decimal places beyond cents
    if (Math.round(amount * 100) !== amount * 100) {
      return 'Please enter a valid dollar amount (maximum 2 decimal places)';
    }

    return '';
  };

  const buildTopupUrl = useCallback(
    (amount: number | string) => {
      const params = new URLSearchParams({
        amount: amount.toString(),
      });

      if (organizationId) {
        params.set('organization-id', organizationId);
      }
      if (redirectUrl) {
        params.set('redirect', redirectUrl);
      }

      return `/payments/topup?${params.toString()}`;
    },
    [organizationId, redirectUrl]
  );

  const handleCustomAmountSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const error = validateCustomAmount(customAmount);
    if (error) {
      setCustomAmountError(error);
      setShowValidationError(true);
      return;
    }

    setSubmitting(true);
    setIsDialogOpen(false);

    const form = event.currentTarget as HTMLFormElement;
    form.submit();
  };

  const handleCustomAmountChange = (value: string) => {
    setCustomAmount(value);

    // Clear validation error when user starts typing
    if (showValidationError) {
      setShowValidationError(false);
      setCustomAmountError('');
    }
  };

  const handleButtonMouseEnter = (e: React.MouseEvent<HTMLButtonElement>, buttonId: string) => {
    if (!animatingButton && !submitting) {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;

      setRippleOrigin({ x, y });
      setAnimatingButton(buttonId);
      setTimeout(() => setAnimatingButton(null), 600);
    }
  };

  const cardTitle = showOrganizationWarning ? 'Buy Personal Credits' : 'Buy Credits';

  return (
    <>
      <Card className="w-full rounded-xl shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2">
            <Coins className="h-5 w-5" />
            {cardTitle}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {showFirstPurchasePromo && (
            <div
              onMouseEnter={() => setIsHighlighted(true)}
              onMouseLeave={() => setIsHighlighted(false)}
              className="mb-4 cursor-pointer"
            >
              <FirstTopupBonusPromo />
            </div>
          )}

          {showOrganizationWarning && (
            <div className="mb-4">
              <OrgPurchasWarning />
            </div>
          )}

          <div className="flex flex-col space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {purchaseAmounts.map(amount => {
                const totalAmount = showFirstPurchasePromo
                  ? amount + FIRST_TOPUP_BONUS_AMOUNT()
                  : amount;
                const buttonText = showFirstPurchasePromo
                  ? `Buy $${amount}, get $${totalAmount}`
                  : `$${amount}`;

                return (
                  <form
                    action={`/payments/topup?amount=${amount}${organizationId ? `&organization-id=${encodeURIComponent(organizationId)}` : ''}`}
                    method="post"
                    key={amount}
                    onSubmit={() => setSubmitting(true)}
                  >
                    <Button
                      disabled={submitting}
                      variant="outline"
                      onMouseEnter={e => handleButtonMouseEnter(e, `amount-${amount}`)}
                      className={`relative w-full overflow-hidden text-sm transition-all hover:border-blue-400 hover:bg-gray-900 hover:text-blue-300 hover:shadow-md ${
                        isHighlighted && showFirstPurchasePromo
                          ? 'border-blue-400 text-blue-300 shadow-md'
                          : ''
                      } ${animatingButton === `amount-${amount}` ? 'animate-liquid-ripple' : ''}`}
                    >
                      {animatingButton === `amount-${amount}` && (
                        <div
                          className="pointer-events-none absolute inset-0"
                          style={{
                            background: `radial-gradient(circle at ${rippleOrigin.x}% ${rippleOrigin.y}%, rgba(59, 130, 246, 0.15) 0%, rgba(59, 130, 246, 0.05) 50%, transparent 70%)`,
                            animation: 'liquidRipple 0.6s ease-out forwards',
                          }}
                        />
                      )}
                      {buttonText}
                    </Button>
                  </form>
                );
              })}

              <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                <DialogTrigger asChild>
                  <Button
                    variant="outline"
                    onMouseEnter={e => handleButtonMouseEnter(e, 'custom')}
                    className={`relative w-full overflow-hidden transition-all hover:border-blue-400 hover:bg-gray-900 hover:text-blue-300 hover:shadow-md ${
                      isHighlighted && showFirstPurchasePromo
                        ? 'border-blue-400 text-blue-300 shadow-md'
                        : ''
                    } ${animatingButton === 'custom' ? 'animate-liquid-ripple' : ''}`}
                    disabled={submitting}
                  >
                    {animatingButton === 'custom' && (
                      <div
                        className="pointer-events-none absolute inset-0"
                        style={{
                          background: `radial-gradient(circle at ${rippleOrigin.x}% ${rippleOrigin.y}%, rgba(59, 130, 246, 0.15) 0%, rgba(59, 130, 246, 0.05) 50%, transparent 70%)`,
                          animation: 'liquidRipple 0.6s ease-out forwards',
                        }}
                      />
                    )}
                    Custom
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[425px]">
                  <DialogHeader>
                    <DialogTitle>Custom Credit Amount</DialogTitle>
                    <DialogDescription>
                      Enter the amount of credits you want to purchase.
                      {showFirstPurchasePromo && (
                        <>
                          <span className="mt-2 block font-semibold text-blue-400">
                            🎉 You'll receive an extra ${FIRST_TOPUP_BONUS_AMOUNT()} on your first
                            purchase!
                          </span>
                          <div>
                            <FirstTopup24for24CountdownTimer />
                          </div>
                          <p className="mt-1 text-xs text-green-300">
                            Free promotional credits expire in{' '}
                            {Math.ceil(PROMO_CREDIT_EXPIRY_HRS / 24)} days.
                          </p>
                        </>
                      )}
                    </DialogDescription>
                  </DialogHeader>
                  <form
                    onSubmit={handleCustomAmountSubmit}
                    action={buildTopupUrl(customAmount)}
                    method="post"
                  >
                    <div className="grid gap-4 py-4">
                      <div>
                        <div className="grid grid-cols-4 items-center gap-4">
                          <label htmlFor="amount" className="text-right whitespace-nowrap">
                            Amount ($)
                          </label>
                          <div className="col-span-3">
                            <Input
                              id="amount"
                              type="number"
                              value={customAmount}
                              onChange={e => handleCustomAmountChange(e.target.value)}
                              placeholder="Enter amount"
                              className="col-span-3"
                            />
                            {showValidationError && customAmountError && (
                              <p className="mt-1 text-sm text-red-400">{customAmountError}</p>
                            )}
                          </div>
                        </div>
                        <p className="text-muted-foreground mt-2 min-h-[20px] text-sm">
                          {customAmount &&
                          !showValidationError &&
                          showFirstPurchasePromo &&
                          !isNaN(parseFloat(customAmount)) &&
                          parseFloat(customAmount) >= MINIMUM_TOP_UP_AMOUNT ? (
                            <span className="font-medium text-green-400">
                              You'll receive $
                              {Math.floor(parseFloat(customAmount)) + FIRST_TOPUP_BONUS_AMOUNT()} in
                              total credits
                            </span>
                          ) : (
                            `Minimum amount is ${formatDollars(MINIMUM_TOP_UP_AMOUNT)}`
                          )}
                        </p>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button
                        type="submit"
                        variant="primary"
                        disabled={submitting || !customAmount.trim()}
                      >
                        Purchase Credits
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </CardContent>
      </Card>
      <style jsx>{
        /* css */ `
          @keyframes liquidRipple {
            0% {
              transform: scale(0);
              opacity: 1;
            }
            50% {
              transform: scale(1.2);
              opacity: 0.8;
            }
            100% {
              transform: scale(2);
              opacity: 0;
            }
          }

          .animate-liquid-ripple {
            position: relative;
          }
        `
      }</style>
    </>
  );
}
