'use client';

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OnboardingStepView } from './OnboardingStepView';
import type { BotIdentity } from './claw.types';
import { DEFAULT_BOT_IDENTITY } from './claw.types';

export function BotIdentityStep({
  instanceRunning,
  onContinue,
}: {
  instanceRunning: boolean;
  onContinue: (identity: BotIdentity) => void;
}) {
  const [identity, setIdentity] = useState<BotIdentity>(DEFAULT_BOT_IDENTITY);

  function updateField<K extends keyof BotIdentity>(key: K, value: BotIdentity[K]) {
    setIdentity(current => ({ ...current, [key]: value }));
  }

  return (
    <OnboardingStepView
      currentStep={2}
      totalSteps={5}
      title="Shape your bot's identity"
      description="Give your assistant a name and personality so it shows up consistently across channels and in its workspace docs."
      showProvisioningBanner={!instanceRunning}
      contentClassName="gap-5"
    >
      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="bot-name">Bot name</Label>
          <Input
            id="bot-name"
            value={identity.botName}
            onChange={event => updateField('botName', event.target.value)}
            maxLength={80}
            placeholder="KiloClaw"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="bot-nature">Nature</Label>
          <Input
            id="bot-nature"
            value={identity.botNature}
            onChange={event => updateField('botNature', event.target.value)}
            maxLength={120}
            placeholder="AI executive assistant"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="bot-emoji">Emoji</Label>
          <Input
            id="bot-emoji"
            value={identity.botEmoji}
            onChange={event => updateField('botEmoji', event.target.value)}
            maxLength={16}
            placeholder="🦾"
          />
        </div>

        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="bot-vibe">Vibe</Label>
          <Input
            id="bot-vibe"
            value={identity.botVibe}
            onChange={event => updateField('botVibe', event.target.value)}
            maxLength={120}
            placeholder="Helpful, calm, and proactive"
          />
        </div>
      </div>

      <div className="border-border bg-muted/30 rounded-lg border p-4 text-sm">
        <p className="text-foreground font-medium">
          {identity.botEmoji || '🤖'} {identity.botName || 'Your bot'}
        </p>
        <p className="text-muted-foreground mt-1">
          {identity.botNature || 'AI assistant'} · {identity.botVibe || 'Ready to help'}
        </p>
      </div>

      <Button
        className="w-full bg-emerald-600 py-6 text-base text-white hover:bg-emerald-700"
        onClick={() => onContinue(identity)}
        disabled={Object.values(identity).some(value => value.trim().length === 0)}
      >
        Continue
        <ChevronRight className="ml-1 h-5 w-5" />
      </Button>
    </OnboardingStepView>
  );
}
