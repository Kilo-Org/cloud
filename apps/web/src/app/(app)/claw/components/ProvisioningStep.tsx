'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useClawGatewayReady } from '../hooks/useClawHooks';
import { OnboardingStepView } from './OnboardingStepView';

/** Play a short chime via the Web Audio API. */
function playChime() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch {
    // Audio context creation can fail silently in some browsers
  }
}

export function ProvisioningStep({
  currentStep,
  totalSteps,
  onboardingSavesReady,
  instanceRunning,
  onComplete,
}: {
  currentStep: number;
  totalSteps: number;
  onboardingSavesReady: boolean;
  instanceRunning: boolean;
  onComplete: () => void;
}) {
  // Bot identity, exec preset, and channel token saves start from
  // `ClawOnboardingFlow` as soon as the instance row exists. This component
  // waits for those durable writes plus gateway ready+settled before it chimes
  // and advances.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Poll the gateway /ready endpoint to know when channels are fully set up
  // and the system's CPU load has settled after boot.
  const { data: gatewayReady } = useClawGatewayReady(instanceRunning);
  const isGatewaySettled = gatewayReady?.ready === true && gatewayReady?.settled === true;

  // Grace period: tolerate transient 502s during startup (the gateway may not
  // have bound its port yet). Only treat 502 as terminal after 30 consecutive
  // seconds to avoid false negatives on healthy instances.
  const GATEWAY_502_GRACE_MS = 30_000;
  const first502AtRef = useRef<number | null>(null);
  const [gateway502Expired, setGateway502Expired] = useState(false);

  useEffect(() => {
    if (gatewayReady?.status !== 502) {
      first502AtRef.current = null;
      setGateway502Expired(false);
      return;
    }
    if (first502AtRef.current === null) {
      first502AtRef.current = Date.now();
    }
    const elapsed = Date.now() - first502AtRef.current;
    const remaining = GATEWAY_502_GRACE_MS - elapsed;
    if (remaining <= 0) {
      setGateway502Expired(true);
      return;
    }
    const timer = setTimeout(() => setGateway502Expired(true), remaining);
    return () => clearTimeout(timer);
  }, [gatewayReady]);

  // Advance to the next step when required onboarding saves have succeeded,
  // the gateway reports ready, and boot CPU pressure has subsided.
  useEffect(() => {
    if (onboardingSavesReady && isGatewaySettled) {
      playChime();
      onCompleteRef.current();
    }
  }, [onboardingSavesReady, isGatewaySettled]);

  if (gateway502Expired) {
    return <ProvisioningErrorView currentStep={currentStep} totalSteps={totalSteps} />;
  }

  return <ProvisioningStepView currentStep={currentStep} totalSteps={totalSteps} />;
}

const PROVISIONING_PHRASES = [
  'If it works, it\'s automation; if it breaks, it\'s a "learning opportunity."',
  'I speak fluent bash, mild sarcasm, and aggressive tab-completion energy.',
  'I can grep it, git blame it, and gently roast it—pick your coping mechanism.',
  "I'm the reason your shell history looks like a hacker-movie montage.",
  "I'm like tmux: confusing at first, then suddenly you can't live without me.",
  'I can run local, remote, or purely on vibes—results may vary with DNS.',
  'If you can describe it, I can probably automate it—or at least make it funnier.',
  'Your config is valid, your assumptions are not.',
  "I'll refactor your busywork like it owes me money.",
  'Say "stop" and I\'ll stop—say "ship" and we\'ll both learn a lesson.',
  "I'll do the boring stuff while you dramatically stare at the logs like it's cinema.",
  "I'm not saying your workflow is chaotic... I'm just bringing a linter and a helmet.",
  'Type the command with confidence—nature will provide the stack trace if needed.',
  'I run on caffeine, JSON5, and the audacity of "it worked on my machine."',
  'Gateway online—please keep hands, feet, and appendages inside the shell at all times.',
  "Give me a workspace and I'll give you fewer tabs, fewer toggles, and more oxygen.",
  'It\'s not "failing," it\'s "discovering new ways to configure the same thing wrong."',
  "I can't fix your code taste, but I can fix your build and your backlog.",
  "I'm not magic—I'm just extremely persistent with retries and coping strategies.",
  "I'm basically a Swiss Army knife, but with more opinions and fewer sharp edges.",
  "If you're lost, run doctor; if you're brave, run prod; if you're wise, run tests.",
  'Your terminal just grew claws—type something and let the bot pinch the busywork.',
  'Welcome to the command line: where dreams compile and confidence segfaults.',
  'The UNIX philosophy meets your DMs.',
  'curl for conversations.',
  'Less middlemen, more messages.',
  'Ship fast, log faster.',
  'End-to-end encrypted, drama-to-drama excluded.',
  'The only bot that stays out of your training set.',
  'Because the right answer is usually a script.',
  'No $999 stand required.',
  'No Mac mini required.',
  'Ah, the fruit tree company! 🍎',
  'Greetings, Professor Falken.',
];

/** Error view shown when the gateway returns a 502 during provisioning. */
export function ProvisioningErrorView({
  currentStep,
  totalSteps,
}: {
  currentStep: number;
  totalSteps: number;
}) {
  return (
    <OnboardingStepView
      currentStep={currentStep}
      totalSteps={totalSteps}
      stepLabel="Provisioning failed"
      contentClassName="items-center gap-8"
    >
      {/* Error icon */}
      <div className="flex h-24 w-24 items-center justify-center rounded-full bg-red-500/10">
        <AlertTriangle className="h-12 w-12 text-red-500" />
      </div>

      {/* Heading + explanation */}
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-foreground text-2xl font-bold">Provisioning failed</h2>
        <p className="text-muted-foreground max-w-md text-sm leading-relaxed">
          Something went wrong while setting up your instance. Please try again by restarting the
          setup process. If the problem persists, contact{' '}
          <a href="mailto:hi@kilo.ai" className="text-blue-500 underline">
            hi@kilo.ai
          </a>
          .
        </p>
      </div>

      {/* Retry action */}
      <Button variant="default" onClick={() => window.location.reload()}>
        Try again
      </Button>
    </OnboardingStepView>
  );
}

/** Pure visual shell — extracted so Storybook can render it without wiring up mutations. */
export function ProvisioningStepView({
  currentStep,
  totalSteps,
}: {
  currentStep: number;
  totalSteps: number;
}) {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setPhraseIndex(i => {
          let next = Math.floor(Math.random() * PROVISIONING_PHRASES.length);
          // Avoid repeating the same phrase twice in a row
          if (next === i && PROVISIONING_PHRASES.length > 1) {
            next = (next + 1) % PROVISIONING_PHRASES.length;
          }
          return next;
        });
        setVisible(true);
      }, 300);
    }, 4000);
    return () => clearInterval(interval);
  }, []);
  return (
    <OnboardingStepView
      currentStep={currentStep}
      totalSteps={totalSteps}
      stepLabel="Almost there..."
      contentClassName="items-center gap-8"
    >
      {/* Spinner */}
      <div className="provisioning-spinner relative h-24 w-24">
        <svg className="h-full w-full" viewBox="0 0 96 96">
          {/* Gray track */}
          <circle
            cx="48"
            cy="48"
            r="42"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            className="text-muted/40"
          />
          {/* Blue arc */}
          <circle
            cx="48"
            cy="48"
            r="42"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray="132 264"
            className="provisioning-spinner-arc text-blue-500"
          />
        </svg>
        {/* Pulsing center dot */}
        <span className="absolute inset-0 m-auto h-2.5 w-2.5 animate-pulse rounded-full bg-blue-500" />
        <style>{`
          .provisioning-spinner svg {
            animation: provisioning-rotate 1.4s linear infinite;
          }
          @keyframes provisioning-rotate {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>

      {/* Heading + subtitle */}
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-foreground text-2xl font-bold">Setting up your instance</h2>
        <p className="text-muted-foreground max-w-md text-sm leading-relaxed">
          This usually takes five minutes. Feel free to keep this tab open and step away &mdash;
          we&apos;ll play a sound as soon as it&apos;s ready.
        </p>
      </div>

      {/* Cycling fun message */}
      <p
        className="text-muted-foreground h-5 text-sm italic transition-opacity duration-300"
        style={{ opacity: visible ? 1 : 0 }}
      >
        {PROVISIONING_PHRASES[phraseIndex]}
      </p>

      {/* Sound banner */}
      <div className="border-border flex w-full items-center gap-3 rounded-lg border p-4">
        <Volume2 className="text-muted-foreground h-5 w-5 shrink-0" />
        <span className="text-muted-foreground flex-1 text-sm">
          You&apos;ll hear a chime when your instance is ready.
        </span>
        <Button variant="ghost" size="sm" onClick={playChime}>
          Play test sound
        </Button>
      </div>
    </OnboardingStepView>
  );
}
