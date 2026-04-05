'use client';

import { useState } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Loader2,
  Gift,
  CheckCircle,
  AlertCircle,
  ArrowRight,
  Share2,
  Clock,
  Megaphone,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RedemptionResult } from '@/app/api/profile/redeem-promocode/route';

export function RedeemPromoCode() {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [result, setResult] = useState<RedemptionResult | null>(null);
  const [validationError, setValidationError] = useState('');

  const redeemMutation = useMutation({
    mutationFn: async (creditCategory: string) => {
      const response = await fetch('/api/profile/redeem-promocode', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ credit_category: creditCategory }),
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        throw new Error(
          data.error ||
            data.message ||
            "Hmm, that code doesn't seem to be valid. Double-check the spelling and try again."
        );
      }

      return {
        message: data.message || 'Promotional code redeemed successfully!',
        creditAmount: data.creditAmount,
        expiryDate: data.expiryDate,
      };
    },
    onSuccess: data => {
      setResult(data);
      setCode('');
      void queryClient.invalidateQueries({ queryKey: ['profile-balance'] });
    },
  });

  const validateCode = (value: string): string => {
    if (!value.trim()) {
      return 'Promotional code is required';
    }

    const creditCategoryPattern = /^[a-zA-Z0-9_-]+$/;
    if (!creditCategoryPattern.test(value.trim())) {
      return 'Invalid code format. Use only letters, numbers, hyphens, and underscores';
    }

    if (value.trim().length > 50) {
      return 'Code must be less than 50 characters';
    }

    return '';
  };

  const handleCodeChange = (value: string) => {
    setCode(value);
    setValidationError('');
    if (redeemMutation.error) {
      setResult(null);
      redeemMutation.reset();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedCode = code.trim();
    const validationResult = validateCode(trimmedCode);

    if (validationResult) {
      setValidationError(validationResult);
      return;
    }

    setResult(null);
    redeemMutation.mutate(trimmedCode);
  };

  const handleShare = async () => {
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'KiloCode Credits',
          text: `I just redeemed a promotional code and got ${result?.creditAmount} credits on KiloCode!`,
          url: window.location.origin,
        });
      } else {
        const shareText = `I just redeemed a promotional code and got ${result?.creditAmount} credits on KiloCode! Check it out: ${window.location.origin}`;
        await navigator.clipboard.writeText(shareText);
      }
    } catch (_error) {
      // Handle share cancellation or errors silently
    }
  };

  const handleContinue = () => {
    setResult(null);
  };

  const getErrorGuidance = (message: string): string => {
    if (message.toLowerCase().includes('expired')) {
      return 'This promo code has expired. Check our Discord server for current promotions and deals!';
    }
    if (message.toLowerCase().includes('not found') || message.toLowerCase().includes('invalid')) {
      return 'Double-check the code spelling and try again.';
    }
    if (
      message.toLowerCase().includes('already been') ||
      message.toLowerCase().includes('redeemed')
    ) {
      return 'Each code can only be used once.';
    }
    if (message.toLowerCase().includes('limit') || message.toLowerCase().includes('maximum')) {
      return 'Unfortunately, this promo code has already reached its redemption limit and can no longer be used. Check our Discord server for current promotions and deals!';
    }
    if (message.toLowerCase().includes('you must have')) {
      return '';
    }
    return 'Please try again or contact support if the problem persists.';
  };

  if (result) {
    return (
      <Card className="w-full border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/30">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/50">
            <CheckCircle className="h-6 w-6 text-green-600 dark:text-green-400" />
          </div>
          <CardTitle className="text-green-800 dark:text-green-300">
            Your promotional credits have been successfully added to your account
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-center">
          <div className="space-y-4">
            <div className="rounded-lg bg-white p-4 shadow-sm dark:bg-gray-800/50 dark:shadow-none">
              <div className="flex items-center justify-center gap-2 text-2xl font-bold text-green-600 dark:text-green-400">
                <Gift className="h-6 w-6" />${result.creditAmount} Credits
              </div>
            </div>

            {result.expiryDate && (
              <div className="rounded-lg">
                <div className="my-2 flex items-center justify-center gap-2 text-orange-700 dark:text-orange-400">
                  <Megaphone className="h-4 w-4" />
                  <span>Remember!</span>
                </div>
                <div className="text-sm font-medium text-orange-700 dark:text-orange-400">
                  These credits expire on {new Date(result.expiryDate).toLocaleDateString()} at{' '}
                  {new Date(result.expiryDate).toLocaleTimeString()}
                </div>
                <div className="mt-2 text-center">
                  <Button
                    variant="outline"
                    size="sm"
                    asChild
                    className="border-orange-300 text-orange-700 hover:bg-orange-100 dark:border-orange-700 dark:text-orange-400 dark:hover:bg-orange-900/30"
                  >
                    <a
                      href={`https://countdown.val.run/?time=${result.expiryDate}`}
                      target="_blank"
                      className="flex items-center gap-1"
                    >
                      <Clock className="h-3 w-3" />
                      View Countdown Timer
                    </a>
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Button onClick={handleContinue} className="flex items-center gap-2" size="lg">
              Continue
              <ArrowRight className="h-4 w-4" />
            </Button>

            <Button
              variant="outline"
              onClick={handleShare}
              className="flex items-center gap-2"
              size="lg"
            >
              <Share2 className="h-4 w-4" />
              Share
            </Button>
          </div>

          <div className="text-muted-foreground text-xs">
            <p>You are ready to start coding with your new credits!</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Redemption form view
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gift className="h-5 w-5" />
          Redeem Promotional Code
        </CardTitle>
        <CardDescription>Enter a promotional code to add credits to your account</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <div className="flex gap-3">
              <Input
                type="text"
                placeholder="Enter promotional code"
                value={code}
                onChange={e => handleCodeChange(e.target.value)}
                disabled={redeemMutation.isPending}
                aria-label="Promotional code"
                aria-describedby={validationError ? 'code-error' : undefined}
                aria-invalid={!!validationError || undefined}
                className={cn(
                  'flex-1',
                  validationError && 'border-destructive focus-visible:ring-destructive/20'
                )}
              />
              <Button
                type="submit"
                disabled={redeemMutation.isPending || !code.trim()}
                aria-describedby={redeemMutation.isPending ? 'loading-status' : undefined}
                className="min-w-[120px]"
              >
                {redeemMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    <span id="loading-status">Redeeming...</span>
                  </>
                ) : (
                  'Redeem Code'
                )}
              </Button>
            </div>
            {validationError && (
              <p id="code-error" className="text-destructive text-sm" role="alert">
                {validationError}
              </p>
            )}
          </div>
        </form>

        {redeemMutation.error && (
          <Alert variant="destructive" role="alert">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Redemption Failed</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>{redeemMutation.error.message}</p>
              <p className="text-sm">{getErrorGuidance(redeemMutation.error.message)}</p>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
