'use client';

import { useState } from 'react';
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
  onContinue: () => void;
  onCopyClick?: () => void;
};

export function InboundEmailStepView({
  currentStep,
  totalSteps,
  address,
  enabled,
  onContinue,
  onCopyClick,
}: InboundEmailStepViewProps) {
  const [copied, setCopied] = useState(false);
  const ready = Boolean(address) && enabled;

  function handleCopy() {
    if (!address) return;
    void navigator.clipboard
      .writeText(address)
      .then(() => toast.success('Inbound email address copied'))
      .catch(() => toast.error('Failed to copy inbound email address'));
    onCopyClick?.();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
                  {enabled ? 'Setting up your inbox…' : 'Inbound email is not enabled.'}
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
          <Button type="button" variant="primary" onClick={() => onContinue()}>
            Continue →
          </Button>
        </div>
      </div>
    </OnboardingStepView>
  );
}
