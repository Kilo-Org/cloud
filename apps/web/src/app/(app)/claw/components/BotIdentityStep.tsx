'use client';

import { useState } from 'react';
import { ChevronRight, Shuffle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { OnboardingStepView } from './OnboardingStepView';
import type { BotIdentity } from './claw.types';
import { cn } from '@/lib/utils';

const NAME_SUGGESTIONS = ['Aria', 'Echo', 'Nova', 'Rex', 'Sage', 'Iris', 'Orion', 'Pixel'];

const EMOJI_OPTIONS = ['🤖', '👾', '🧠', '⚡', '🔮', '🔥', '🐉', '✨', '🌙'];

function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

type NaturePreset = {
  id: string;
  emoji: string;
  label: string;
  vibe: string;
};

const NATURE_PRESETS: NaturePreset[] = [
  {
    id: 'ai-assistant',
    emoji: '🤖',
    label: 'AI assistant',
    vibe: 'Helpful, capable, professional',
  },
  {
    id: 'digital-creature',
    emoji: '🐙',
    label: 'Digital creature',
    vibe: 'Quirky, alive, a bit unpredictable',
  },
  {
    id: 'virtual-companion',
    emoji: '🌙',
    label: 'Virtual companion',
    vibe: 'Warm, present, genuinely cares',
  },
  {
    id: 'something-weirder',
    emoji: '🌀',
    label: 'Something weirder...',
    vibe: 'Define it yourself',
  },
];

export function BotIdentityStep({
  instanceRunning,
  onContinue,
}: {
  instanceRunning: boolean;
  onContinue: (identity: BotIdentity) => void;
}) {
  const [botName, setBotName] = useState('');
  const [selectedEmoji, setSelectedEmoji] = useState('🤖');
  const [customEmoji, setCustomEmoji] = useState('');
  const [selectedNatureId, setSelectedNatureId] = useState('ai-assistant');

  const activeEmoji = customEmoji || selectedEmoji;
  const nature = NATURE_PRESETS.find(n => n.id === selectedNatureId) ?? NATURE_PRESETS[0];

  function handleShuffle() {
    setBotName(pickRandom(NAME_SUGGESTIONS));
    setSelectedEmoji(pickRandom(EMOJI_OPTIONS));
    setCustomEmoji('');
  }

  function handleContinue() {
    onContinue({
      botName: botName.trim() || 'KiloClaw',
      botEmoji: activeEmoji,
      botNature: nature.label,
      botVibe: nature.vibe,
    });
  }

  return (
    <OnboardingStepView
      currentStep={2}
      totalSteps={5}
      title="Give your bot an identity"
      description="Make it yours. You can always change this later."
      showProvisioningBanner={!instanceRunning}
      contentClassName="gap-6"
    >
      <div className="border-border bg-muted/30 flex items-center gap-3 rounded-lg border p-4">
        <span className="text-2xl">{activeEmoji}</span>
        <div className="min-w-0 flex-1">
          <p className="text-foreground font-medium">{botName || 'Your bot'}</p>
          <p className="text-muted-foreground text-sm">{nature.label}</p>
        </div>
        <button
          type="button"
          onClick={handleShuffle}
          aria-label="Shuffle name and emoji"
          className="border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors"
        >
          <Shuffle className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3">
        <Input
          value={botName}
          onChange={e => setBotName(e.target.value)}
          maxLength={80}
          placeholder="Name your bot"
        />
        <div className="flex flex-wrap gap-2">
          {NAME_SUGGESTIONS.map(name => (
            <button
              key={name}
              type="button"
              className={cn(
                'rounded-full border px-3 py-1 text-sm transition-colors',
                botName === name
                  ? 'border-brand-primary bg-brand-primary/10 text-brand-primary'
                  : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
              )}
              onClick={() => setBotName(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap gap-3">
          {EMOJI_OPTIONS.map(emoji => (
            <button
              key={emoji}
              type="button"
              className={cn(
                'flex h-14 w-14 items-center justify-center rounded-lg border text-2xl transition-colors',
                selectedEmoji === emoji && !customEmoji
                  ? 'border-brand-primary bg-brand-primary/10'
                  : 'border-border hover:border-foreground/30 hover:bg-muted/50'
              )}
              onClick={() => {
                setSelectedEmoji(emoji);
                setCustomEmoji('');
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
        <Input
          value={customEmoji}
          onChange={e => {
            setCustomEmoji(e.target.value);
          }}
          maxLength={16}
          placeholder="or type your own..."
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {NATURE_PRESETS.map(preset => (
          <button
            key={preset.id}
            type="button"
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors',
              selectedNatureId === preset.id
                ? 'border-brand-primary bg-brand-primary/10 text-brand-primary'
                : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
            )}
            onClick={() => setSelectedNatureId(preset.id)}
          >
            <span>{preset.emoji}</span>
            {preset.label}
          </button>
        ))}
      </div>

      <Button
        className="bg-brand-primary hover:bg-brand-primary/90 w-full py-6 text-base text-black"
        onClick={handleContinue}
      >
        Continue
        <ChevronRight className="ml-1 h-5 w-5" />
      </Button>
    </OnboardingStepView>
  );
}
