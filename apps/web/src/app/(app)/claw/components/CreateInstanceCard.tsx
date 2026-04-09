'use client';

import { useFeatureFlagVariantKey, usePostHog } from 'posthog-js/react';
import { useQuery } from '@tanstack/react-query';
import { Brain, ChevronRight, MessageSquare, Sun, Wrench, Zap } from 'lucide-react';
import { toast } from 'sonner';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useClawContext } from './ClawContext';
import { useTRPC } from '@/lib/trpc/utils';
import { KILO_AUTO_BALANCED_MODEL } from '@/lib/kilo-auto';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

type CreateInstanceCardViewProps = {
  canStartTrial?: boolean;
  isPending?: boolean;
  onCreate?: () => void;
};

const featureCards = [
  {
    title: 'Morning briefings',
    description: 'Calendar, email, news, and weather — every morning',
    icon: Sun,
  },
  {
    title: 'Chat on Kilo, Telegram or Discord',
    description: 'Ask questions, get answers, anytime',
    icon: MessageSquare,
  },
  {
    title: 'Automate tasks',
    description: 'Draft emails, research topics, manage to-dos',
    icon: Wrench,
  },
  {
    title: 'Learns your style',
    description: 'Gets smarter the more you use it',
    icon: Brain,
  },
];

export function CreateInstanceCardView({
  canStartTrial = false,
  isPending = false,
  onCreate,
}: CreateInstanceCardViewProps) {
  return (
    <Card className="mt-6 overflow-hidden">
      <CardContent className="flex flex-col gap-6 p-6 sm:p-8">
        <div className="mx-auto flex max-w-xl flex-col items-center text-center">
          <h2 className="text-foreground text-2xl font-bold">Your AI assistant, always on</h2>
          <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
            KiloClaw is a personal AI that lives on your phone. It sends you a morning briefing,
            answers questions, automates busywork, and learns how you like things done.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {featureCards.map(feature => {
            const Icon = feature.icon;
            return (
              <div key={feature.title} className="rounded-lg border p-4">
                <Icon className="mb-4 h-5 w-5 text-blue-500" strokeWidth={2.25} />
                <h3 className="text-sm font-bold">{feature.title}</h3>
                <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                  {feature.description}
                </p>
              </div>
            );
          })}
        </div>

        <div className="flex flex-col items-center">
          <div className="inline-flex items-center rounded-full border border-emerald-700 bg-emerald-500/10 px-3 py-1.5 text-sm font-semibold text-emerald-400">
            {canStartTrial
              ? 'Try 6 hours for free — no credit card needed'
              : 'Try 6 hours for free'}
          </div>
        </div>

        <div className="space-y-3">
          <Button
            onClick={onCreate}
            disabled={isPending}
            className="w-full bg-emerald-600 py-6 text-base text-white hover:bg-emerald-700"
          >
            {isPending ? (
              'Setting up...'
            ) : (
              <span className="inline-flex items-center gap-1">
                Get Started
                <ChevronRight className="h-5 w-5" />
              </span>
            )}
          </Button>
          <p className="text-muted-foreground text-center text-xs">
            Takes about 10 minutes to set up
          </p>
        </div>

        <div className="flex flex-col items-center">
          <div className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm">
            <Zap className="h-4 w-4 text-blue-400" />
            <span className="text-muted-foreground">Powered by</span>
            <span className="font-semibold">{KILO_AUTO_BALANCED_MODEL.name}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function CreateInstanceCard({
  mutations,
  onProvisionStart,
  onProvisionFailed,
}: {
  mutations: ClawMutations;
  onProvisionStart?: () => void;
  onProvisionFailed?: () => void;
}) {
  // Evaluate the landing-page experiment flag so PostHog attaches
  // $feature/button-vs-card to events fired in this component.
  useFeatureFlagVariantKey('button-vs-card');
  const posthog = usePostHog();
  const trpc = useTRPC();
  const { organizationId } = useClawContext();
  const isOrgContext = !!organizationId;
  // Billing status is personal-only; org uses org subscription checks
  const { data: billingStatus } = useQuery({
    ...trpc.kiloclaw.getBillingStatus.queryOptions(),
    enabled: !isOrgContext,
  });
  const selectedModel = KILO_AUTO_BALANCED_MODEL.id;
  const canStartTrial = Boolean(billingStatus?.trialEligible);

  function handleCreate() {
    posthog?.capture('claw_create_instance_clicked', {
      selected_model: selectedModel,
    });

    // Enter the onboarding wizard before the mutation fires so the UI
    // shows the wizard immediately instead of racing with status polling.
    onProvisionStart?.();

    mutations.provision.mutate(
      {
        kilocodeDefaultModel: `kilocode/${selectedModel}`,
      },
      {
        onError: err => {
          onProvisionFailed?.();
          toast.error(`Failed to create: ${err.message}`);
        },
      }
    );
  }

  return (
    <CreateInstanceCardView
      canStartTrial={canStartTrial}
      isPending={mutations.provision.isPending}
      onCreate={handleCreate}
    />
  );
}
