'use client';

import Link from 'next/link';
import { Calendar, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { OnboardingStepView } from './OnboardingStepView';

type CalendarConnectStepViewProps = {
  currentStep: number;
  totalSteps: number;
  connectUrl: string;
  isConnected: boolean;
  connectedAccountEmail?: string | null;
  /**
   * Whether the kiloclaw instance row is provisioned. The
   * /api/integrations/google/connect route requires an active instance and
   * bounces the user out of onboarding when it can't find one, so the Connect
   * button stays disabled until the instance row exists.
   */
  instanceReady: boolean;
  onSkip: () => void;
  onContinue: () => void;
  onConnectClick?: () => void;
};

const FEATURES: Array<{ included: boolean; title: string; detail: string }> = [
  {
    included: true,
    title: 'Read your calendar events',
    detail: 'Titles, attendees, locations, descriptions for the next 14 days.',
  },
  {
    included: true,
    title: 'Read calendars you own and subscribe to',
    detail: 'Including team calendars shared with you.',
  },
  {
    included: false,
    title: 'Create, modify, or delete events',
    detail: "We don't request write access.",
  },
];

export function CalendarConnectStepView({
  currentStep,
  totalSteps,
  connectUrl,
  isConnected,
  connectedAccountEmail,
  instanceReady,
  onSkip,
  onContinue,
  onConnectClick,
}: CalendarConnectStepViewProps) {
  return (
    <OnboardingStepView
      currentStep={currentStep}
      totalSteps={totalSteps}
      stepLabel={`Step ${currentStep} of ${totalSteps} · Calendar`}
      title="Connect a calendar."
      description="This is what day one of your briefing is built from. Read access only, no writes."
      showProvisioningBanner
    >
      <div className="border-border bg-card flex flex-col gap-5 rounded-lg border p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="border-border flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border">
              <Calendar className="h-5 w-5" />
            </div>
            <div className="flex flex-col gap-0.5">
              <h3 className="text-foreground text-base font-semibold">Google Calendar</h3>
              <p className="text-muted-foreground text-xs">
                {isConnected && connectedAccountEmail
                  ? `Connected as ${connectedAccountEmail}`
                  : 'via OAuth · read-only'}
              </p>
            </div>
          </div>
          <span
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase',
              isConnected
                ? 'border-emerald-500/40 text-emerald-500'
                : 'border-amber-500/40 text-amber-500'
            )}
          >
            {isConnected ? 'Connected' : 'Recommended'}
          </span>
        </div>

        <div className="flex flex-col gap-3">
          {FEATURES.map(feature => (
            <div key={feature.title} className="flex items-start gap-3">
              <div
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
                  feature.included
                    ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-500'
                    : 'border-border text-muted-foreground/60'
                )}
              >
                {feature.included ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
              </div>
              <div className="flex flex-col gap-0.5">
                <p
                  className={cn(
                    'text-sm font-medium',
                    feature.included ? 'text-foreground' : 'text-muted-foreground/70'
                  )}
                >
                  {feature.title}
                </p>
                <p className="text-muted-foreground text-xs">{feature.detail}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={() => onSkip()}
            className="text-muted-foreground hover:text-foreground text-sm font-medium transition-colors"
          >
            Skip for now
          </button>
          {isConnected ? (
            <Button variant="primary" onClick={() => onContinue()}>
              Continue
            </Button>
          ) : instanceReady ? (
            <Button asChild variant="primary">
              <Link href={connectUrl} onClick={() => onConnectClick?.()}>
                Connect Google Calendar
              </Link>
            </Button>
          ) : (
            <Button variant="primary" disabled>
              Setting up your instance…
            </Button>
          )}
        </div>
      </div>
    </OnboardingStepView>
  );
}
