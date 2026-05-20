'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { OnboardingStepView } from './OnboardingStepView';
import { BriefingChatPreview } from './BriefingChatPreview';
import type { BotIdentity } from './claw.types';

type InboundEmailStepViewProps = {
  currentStep: number;
  totalSteps: number;
  bot: BotIdentity;
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

const PREVIEW_ITEMS = [
  'From investor-newsletter — 2 fundraising signals to skim',
  'From product@your-vendor — release notes summary',
  'From you (forwarded) — flagged thread context',
];

const TIPS: Array<{ title: string; detail: string }> = [
  {
    title: 'Forward emails to this address',
    detail: 'Newsletters, threads, briefings — anything you want surfaced.',
  },
  {
    title: 'Subject becomes the topic',
    detail: 'Whatever you write in the subject line is what the bot calls it.',
  },
  {
    title: 'Shows up the next morning',
    detail: 'Forwarded items become context in your next briefing.',
  },
];

export function InboundEmailStepView({
  currentStep,
  totalSteps,
  bot,
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
      contentClassName="gap-6"
    >
      <div className="grid gap-6 md:grid-cols-[1fr_2fr] md:gap-8">
        <BriefingChatPreview
          bot={bot}
          greeting="What you forwarded yesterday:"
          items={PREVIEW_ITEMS}
          closer="I'll surface anything time-sensitive in your morning briefing."
        />

        <div className="flex flex-col gap-6">
          <div className="bg-muted/40 border-border flex items-stretch overflow-hidden rounded-md border">
            <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2">
              <Mail className="text-muted-foreground h-4 w-4 shrink-0" />
              {ready ? (
                <code className="text-foreground min-w-0 truncate font-mono text-sm">
                  {address}
                </code>
              ) : (
                <span className="text-muted-foreground truncate text-sm">
                  {loading
                    ? 'Setting up your inbox…'
                    : enabled
                      ? 'Setting up your inbox…'
                      : 'Inbound email is not enabled.'}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={handleCopy}
              disabled={!ready}
              aria-label={copied ? 'Address copied' : 'Copy inbound address'}
              className="border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:ring-ring flex shrink-0 cursor-pointer items-center gap-1.5 self-stretch border-l px-3 text-sm font-medium transition-colors focus-visible:ring-1 focus-visible:outline-none focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50"
            >
              {copied ? (
                <Check className="h-4 w-4 text-emerald-400" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <section className="flex flex-col gap-3">
            <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
              How it works
            </h3>
            <ol className="flex flex-col gap-3">
              {TIPS.map((tip, index) => (
                <li key={tip.title} className="flex items-start gap-3">
                  <div className="bg-muted/40 border-border text-muted-foreground mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border font-mono text-xs font-semibold">
                    {index + 1}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <p className="text-foreground text-sm font-semibold">{tip.title}</p>
                    <p className="text-muted-foreground text-sm leading-snug">{tip.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 pt-2">
        <Button
          type="button"
          variant="default"
          size="lg"
          className="bg-brand-primary hover:bg-brand-primary/90"
          onClick={() => onContinue()}
          disabled={!canContinue}
        >
          {loading ? 'Setting up your instance…' : 'Continue'}
        </Button>
      </div>
    </OnboardingStepView>
  );
}
