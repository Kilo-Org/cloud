'use client';

import { useEffect, useRef, useState } from 'react';
import { Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  type ExecPreset,
  type ClawMutations,
  execPresetToConfig,
  channelTokensToConfigPatch,
} from './claw.types';
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
  preset,
  channelTokens,
  instanceRunning,
  mutations,
  onComplete,
}: {
  preset: ExecPreset;
  channelTokens: Record<string, string> | null;
  instanceRunning: boolean;
  mutations: ClawMutations;
  onComplete: () => void;
}) {
  const completedRef = useRef(false);

  // Keep stable references to callbacks so the effect only re-runs
  // when data values change, not when the parent re-renders or mutation
  // state transitions (pending→error) produce new object references.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const patchOpenclawConfigRef = useRef(mutations.patchOpenclawConfig.mutate);
  patchOpenclawConfigRef.current = mutations.patchOpenclawConfig.mutate;
  const patchChannelsRef = useRef(mutations.patchChannels.mutate);
  patchChannelsRef.current = mutations.patchChannels.mutate;
  const patchExecPresetRef = useRef(mutations.patchExecPreset.mutate);
  patchExecPresetRef.current = mutations.patchExecPreset.mutate;
  const channelTokensRef = useRef(channelTokens);
  channelTokensRef.current = channelTokens;

  useEffect(() => {
    if (!instanceRunning || completedRef.current) return;
    completedRef.current = true;

    // Build the full openclaw.json patch: exec preset + channel config.
    const configPatch: Record<string, unknown> = {};

    if (preset !== 'always-ask') {
      const { security, ask } = execPresetToConfig(preset);
      configPatch.tools = { exec: { security, ask } };
    }

    const channelPatch = channelTokensToConfigPatch(channelTokensRef.current);
    if (channelPatch) Object.assign(configPatch, channelPatch);

    // Also persist channel tokens to durable storage so they survive
    // machine restarts. Fire-and-forget — the live config patch above
    // is what matters for the immediate user experience.
    const tokens = channelTokensRef.current;
    if (tokens && Object.keys(tokens).length > 0) {
      patchChannelsRef.current(tokens);
    }

    // Persist exec permissions preset to durable storage so it survives
    // machine restarts/redeploys. Fire-and-forget — same pattern as channels.
    if (preset !== 'always-ask') {
      const { security, ask } = execPresetToConfig(preset);
      patchExecPresetRef.current({ security, ask });
    }

    if (Object.keys(configPatch).length === 0) {
      playChime();
      onCompleteRef.current();
      return;
    }

    patchOpenclawConfigRef.current(
      { patch: configPatch },
      {
        onSuccess: () => {
          playChime();
          onCompleteRef.current();
        },
        onError: (err: { message: string }) => {
          completedRef.current = false;
          toast.error(err.message);
        },
      }
    );
  }, [instanceRunning, preset]);

  return <ProvisioningStepView />;
}

const PROVISIONING_MESSAGES = [
  'Reticulating splines...',
  'Warming up the flux capacitor...',
  'Convincing the hamsters to run faster...',
  'Downloading more RAM...',
  'Generating witty loading messages...',
  'Consulting the magic 8-ball...',
  'Untangling the internet tubes...',
  'Feeding the code monkeys...',
  'Aligning the bits...',
  'Compiling the compilers...',
  'Herding the electrons...',
  'Calibrating the cloud...',
];

/** Pure visual shell — extracted so Storybook can render it without wiring up mutations. */
export function ProvisioningStepView() {
  const [messageIndex, setMessageIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setMessageIndex(i => (i + 1) % PROVISIONING_MESSAGES.length);
        setVisible(true);
      }, 300);
    }, 3500);
    return () => clearInterval(interval);
  }, []);
  return (
    <OnboardingStepView
      currentStep={4}
      totalSteps={4}
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
          This usually takes a minute or two. Feel free to keep this tab open and step away &mdash;
          we&apos;ll play a sound as soon as it&apos;s ready.
        </p>
      </div>

      {/* Cycling fun message */}
      <p
        className="text-muted-foreground h-5 text-sm italic transition-opacity duration-300"
        style={{ opacity: visible ? 1 : 0 }}
      >
        {PROVISIONING_MESSAGES[messageIndex]}
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
