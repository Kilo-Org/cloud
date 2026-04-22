'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Send, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useClawPairing, useClawRefreshPairing } from '../hooks/useClawHooks';
import { Button } from '@/components/ui/button';
import type { ClawMutations } from './claw.types';
import { OnboardingStepView } from './OnboardingStepView';

type PairingChannelId = 'telegram' | 'discord';

const CHANNEL_META: Record<PairingChannelId, { label: string; instruction: string }> = {
  telegram: {
    label: 'Telegram',
    instruction:
      'Open Telegram and send any message to your bot. The bot will reply with a pairing request \u2014 we\u2019ll pick it up automatically.',
  },
  discord: {
    label: 'Discord',
    instruction:
      'Open Discord and send a DM to your bot. The bot will reply with a pairing request \u2014 we\u2019ll pick it up automatically.',
  },
};

export function ChannelPairingStep({
  currentStep,
  totalSteps,
  channelId,
  mutations,
  onComplete,
  onSkip,
}: {
  currentStep: number;
  totalSteps: number;
  channelId: PairingChannelId;
  mutations: ClawMutations;
  onComplete: () => void;
  onSkip: () => void;
}) {
  const { data: pairingData } = useClawPairing(true);

  const refreshPairing = useClawRefreshPairing();
  const refreshRef = useRef(refreshPairing);
  refreshRef.current = refreshPairing;

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      while (!cancelled) {
        await refreshRef.current().catch(() => {});
        if (cancelled) break;
        await new Promise(r => setTimeout(r, 1_000));
      }
    }
    void poll();
    return () => {
      cancelled = true;
    };
  }, []);

  const matchingRequest = pairingData?.requests?.find(
    (r: { channel: string; code: string; id: string }) => r.channel === channelId
  );

  // Preserve the request being approved so the approval card stays visible
  // while the mutation's onSuccess invalidates the pairing query. Without
  // this, matchingRequest goes null from the refetch before onComplete fires,
  // causing a brief flash of the "waiting" state.
  const [pendingApproval, setPendingApproval] = useState<{
    code: string;
    channel: string;
    id: string;
  } | null>(null);

  const displayedRequest = matchingRequest ?? pendingApproval;
  const isApproving = mutations.approvePairingRequest.isPending || pendingApproval !== null;

  function handleApprove(channel: string, code: string) {
    if (matchingRequest) setPendingApproval(matchingRequest);
    mutations.approvePairingRequest.mutate(
      { channel, code },
      {
        onSuccess: result => {
          if (result.success) {
            toast.success('Pairing approved');
            onComplete();
          } else {
            setPendingApproval(null);
            toast.error(result.message || 'Approval failed');
          }
        },
        onError: err => {
          setPendingApproval(null);
          toast.error(`Failed to approve: ${err.message}`);
        },
      }
    );
  }

  return (
    <ChannelPairingStepView
      currentStep={currentStep}
      totalSteps={totalSteps}
      channelId={channelId}
      matchingRequest={displayedRequest ?? null}
      isApproving={isApproving}
      onApprove={handleApprove}
      onSkip={onSkip}
    />
  );
}

type ChannelPairingStepViewProps = {
  currentStep: number;
  totalSteps: number;
  channelId: PairingChannelId;
  matchingRequest: { code: string; channel: string; id: string } | null;
  isApproving?: boolean;
  onApprove?: (channel: string, code: string) => void;
  onSkip?: () => void;
};

export function ChannelPairingStepView({
  currentStep,
  totalSteps,
  channelId,
  matchingRequest,
  isApproving = false,
  onApprove,
  onSkip,
}: ChannelPairingStepViewProps) {
  const meta = CHANNEL_META[channelId];

  if (matchingRequest) {
    return (
      <OnboardingStepView
        currentStep={currentStep}
        totalSteps={totalSteps}
        title={`Pair your ${meta.label} bot`}
        description={meta.instruction}
        contentClassName="gap-6"
      >
        <div className="border-border bg-muted/30 flex flex-col rounded-lg border">
          <div className="flex items-center gap-2 px-5 pt-5 pb-4">
            <Send className="text-muted-foreground h-4 w-4" />
            <span className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
              Pairing request received
            </span>
          </div>

          <div className="border-border mx-5 flex items-center justify-between border-b pb-4">
            <span className="text-muted-foreground text-sm">{meta.label} user ID</span>
            <span className="text-foreground font-mono text-sm">{matchingRequest.id}</span>
          </div>

          <div className="flex flex-col items-center gap-2 px-5 py-6">
            <span className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
              Pairing code
            </span>
            <span className="text-foreground font-mono text-3xl font-bold tracking-[0.25em]">
              {matchingRequest.code}
            </span>
          </div>
        </div>

        <p className="text-muted-foreground/70 text-center text-sm">
          A user on {meta.label} is requesting access to your bot. Only approve if you initiated
          this.
        </p>

        <Button
          className="w-full cursor-pointer bg-emerald-500 py-5 text-base font-semibold text-white hover:bg-emerald-600"
          onClick={() => onApprove?.(matchingRequest.channel, matchingRequest.code)}
          disabled={isApproving}
        >
          {isApproving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCircle2 className="h-4 w-4" />
          )}
          Authorize this request
        </Button>

        <button
          type="button"
          className="text-muted-foreground/50 hover:text-muted-foreground mx-auto flex cursor-pointer items-center gap-1.5 text-sm transition-colors"
          onClick={onSkip}
        >
          <XCircle className="h-3.5 w-3.5" />
          Decline
        </button>
      </OnboardingStepView>
    );
  }

  return (
    <OnboardingStepView
      currentStep={currentStep}
      totalSteps={totalSteps}
      title={`Pair your ${meta.label} bot`}
      description={meta.instruction}
      contentClassName="gap-8"
    >
      <div className="flex flex-col items-center gap-8">
        <div className="pairing-spinner relative h-24 w-24 my-6">
          <svg className="h-full w-full" viewBox="0 0 96 96">
            <circle
              cx="48"
              cy="48"
              r="42"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              className="text-muted/40"
            />
            <circle
              cx="48"
              cy="48"
              r="42"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray="132 264"
              className="pairing-spinner-arc text-blue-500"
            />
          </svg>
          <style>{`
            .pairing-spinner svg {
              animation: pairing-rotate 1.4s linear infinite;
            }
            @keyframes pairing-rotate {
              to { transform: rotate(360deg); }
            }
          `}</style>
        </div>

        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-foreground text-lg font-semibold">
            Waiting for you to message the bot...
          </h2>
          <p className="text-muted-foreground text-sm">This page will update automatically.</p>
        </div>
        <button
          type="button"
          className="text-muted-foreground/50 cursor-pointer hover:text-muted-foreground text-sm transition-colors my-6"
          onClick={onSkip}
        >
          Skip — I&apos;ll pair later from Settings
        </button>
      </div>
    </OnboardingStepView>
  );
}
