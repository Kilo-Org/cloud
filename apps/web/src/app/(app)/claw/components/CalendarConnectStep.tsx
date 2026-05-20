'use client';

import Link from 'next/link';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GoogleLogo } from '@/components/auth/GoogleLogo';
import { OnboardingStepView } from './OnboardingStepView';
import { BriefingChatPreview } from './BriefingChatPreview';
import type { BotIdentity } from './claw.types';

type CalendarConnectStepViewProps = {
  currentStep: number;
  totalSteps: number;
  bot: BotIdentity;
  connectUrl: string;
  isConnected: boolean;
  connectedAccountEmail?: string | null;
  /**
   * Whether it's safe to start the OAuth round trip. Two prerequisites:
   * (1) the kiloclaw instance row exists — `/api/integrations/google/connect`
   * needs an active instance and bounces to Settings otherwise.
   * (2) the wizard's pre-OAuth saves (bot identity, exec preset) have
   * persisted — the OAuth round trip is a full-page reload, and unload
   * mid-flight can race or cancel those mutations. The post-OAuth resume
   * also relies on `botName` being persisted for hydration.
   */
  readyToConnect: boolean;
  onSkip: () => void;
  onContinue: () => void;
  onConnectClick?: () => void;
};

const FEATURES: Array<{ title: string; detail: string }> = [
  {
    title: 'Calendar events',
    detail: 'Titles, attendees, locations, descriptions for the next 14 days.',
  },
  {
    title: 'Calendars you own and follow',
    detail: 'Including team calendars shared with you.',
  },
];

const PREVIEW_ITEMS = [
  '3 meetings on your calendar today',
  'Standup at 10:00 with the platform team',
  'Lunch with Reese, 12:30',
  '1:1 with Devon at 3:00',
];

export function CalendarConnectStepView({
  currentStep,
  totalSteps,
  bot,
  connectUrl,
  isConnected,
  connectedAccountEmail,
  readyToConnect,
  onSkip,
  onContinue,
  onConnectClick,
}: CalendarConnectStepViewProps) {
  const greetingName =
    isConnected && connectedAccountEmail ? connectedAccountEmail.split('@')[0] : null;
  const greeting = greetingName ? `Good morning, ${greetingName}.` : 'Good morning.';

  return (
    <OnboardingStepView
      currentStep={currentStep}
      totalSteps={totalSteps}
      stepLabel={`Step ${currentStep} of ${totalSteps} · Calendar`}
      title="Connect a calendar."
      description="This is what day one of your briefing is built from. Read access only, no writes."
      showProvisioningBanner
      contentClassName="gap-6"
    >
      <div className="grid gap-6 md:grid-cols-[1fr_2fr] md:gap-8">
        <BriefingChatPreview
          bot={bot}
          greeting={greeting}
          items={PREVIEW_ITEMS}
          closer="Light afternoon. Coffee at 2 if you can."
        />

        <div className="flex flex-col gap-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="bg-muted/40 border-border flex h-10 w-10 shrink-0 items-center justify-center rounded-md border">
                <GoogleLogo />
              </div>
              <div className="flex flex-col">
                <span className="text-foreground text-base font-semibold">Google Calendar</span>
                <span className="text-muted-foreground text-xs">
                  {isConnected && connectedAccountEmail
                    ? `Connected as ${connectedAccountEmail}`
                    : 'OAuth · Read-only'}
                </span>
              </div>
            </div>
            {isConnected && (
              <span className="bg-emerald-500/10 text-emerald-400 ring-emerald-500/20 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ring-1">
                <Check className="size-4" />
                Connected
              </span>
            )}
          </div>

          <section className="flex flex-col gap-3">
            <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
              What we'll read
            </h3>
            <div className="flex flex-col gap-3">
              {FEATURES.map(feature => (
                <div key={feature.title} className="flex items-start gap-3">
                  <div className="bg-emerald-500/10 text-emerald-400 ring-emerald-500/20 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1">
                    <Check className="h-3.5 w-3.5" />
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <p className="text-foreground text-sm font-semibold">{feature.title}</p>
                    <p className="text-muted-foreground text-sm leading-snug">{feature.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 pt-2">
        <Button variant="ghost" size="lg" onClick={() => onSkip()}>
          Skip for now
        </Button>
        {isConnected ? (
          <Button
            variant="default"
            size="lg"
            className="bg-brand-primary hover:bg-brand-primary/90"
            onClick={() => onContinue()}
          >
            Continue
          </Button>
        ) : readyToConnect ? (
          <Button
            asChild
            variant="default"
            size="lg"
            className="bg-brand-primary hover:bg-brand-primary/90"
          >
            <Link href={connectUrl} onClick={() => onConnectClick?.()}>
              Connect Google Calendar
            </Link>
          </Button>
        ) : (
          <Button
            variant="default"
            size="lg"
            className="bg-brand-primary hover:bg-brand-primary/90"
            disabled
          >
            Setting up your instance…
          </Button>
        )}
      </div>
    </OnboardingStepView>
  );
}
