'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { OnboardingStepView } from './OnboardingStepView';

type InboundEmailStepViewProps = {
  currentStep: number;
  totalSteps: number;
  /** Inbound alias from `KiloClawDashboardStatus.inboundEmailAddress`. */
  address: string | null;
  /** `KiloClawDashboardStatus.inboundEmailEnabled`. */
  enabled: boolean;
  /**
   * True when the platform status query hasn't returned yet (or has returned
   * with `enabled: true` but no address). Distinguishes the loading case from
   * the genuine "feature is disabled for this instance" case so we can show
   * the right copy and prevent the user from skipping the screen entirely.
   */
  loading: boolean;
  onContinue: () => void;
  onCopyClick?: () => void;
};

export function InboundEmailStepView({
  currentStep,
  totalSteps,
  address,
  enabled,
  loading,
  onContinue,
  onCopyClick,
}: InboundEmailStepViewProps) {
  const [copied, setCopied] = useState(false);
  const ready = Boolean(address) && enabled;
  const canContinue = !loading;

  // Track the "reset Copied state after 2s" timer so we can clear it on
  // unmount (or when the user clicks Copy again before the previous timer
  // fires). Without this, navigating away within the 2s window leaves a
  // pending setCopied(false) call against an unmounted component.
  const copyResetTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = null;
      }
    };
  }, []);

  async function handleCopy() {
    if (!address) return;
    if (!navigator.clipboard?.writeText) {
      toast.error('Clipboard copy is not available in this browser');
      return;
    }
    try {
      await navigator.clipboard.writeText(address);
      toast.success('Inbound email address copied');
      onCopyClick?.();
      setCopied(true);
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetTimerRef.current = null;
      }, 2000);
    } catch {
      toast.error('Failed to copy inbound email address');
    }
  }

  return (
    <OnboardingStepView
      currentStep={currentStep}
      totalSteps={totalSteps}
      stepLabel={`Step ${currentStep} of ${totalSteps} · Inbound Email`}
      title="Your bot has an inbox."
      description="Forward anything useful to this address and it can show up as context in future briefings."
      showProvisioningBanner
    >
      <div className="border-border bg-card flex flex-col gap-4 rounded-lg border p-5 sm:p-6">
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
            Inbound Address
          </span>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="bg-muted/50 border-border flex min-w-0 items-center gap-2 rounded-md border px-3 py-2">
              <Mail className="text-muted-foreground h-4 w-4 shrink-0" />
              {ready ? (
                <code className="text-foreground min-w-0 truncate font-mono text-sm">
                  {address}
                </code>
              ) : (
                <span className="text-muted-foreground text-sm">
                  {loading
                    ? 'Setting up your inbox…'
                    : enabled
                      ? 'Setting up your inbox…'
                      : 'Inbound email is not enabled.'}
                </span>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={handleCopy}
              disabled={!ready}
              className="shrink-0"
            >
              {copied ? (
                <Check className="h-4 w-4 text-emerald-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              {copied ? 'Copied' : 'Copy address'}
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <Button
            type="button"
            variant="primary"
            onClick={() => onContinue()}
            disabled={!canContinue}
          >
            {loading ? 'Setting up your instance…' : 'Continue →'}
          </Button>
        </div>
      </div>
    </OnboardingStepView>
  );
}
