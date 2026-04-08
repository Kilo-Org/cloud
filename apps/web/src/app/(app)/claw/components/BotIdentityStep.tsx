'use client';

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { OnboardingStepView } from './OnboardingStepView';
import type { BotIdentity } from './claw.types';
import { cn } from '@/lib/utils';

const NAME_SUGGESTIONS = ['Aria', 'Echo', 'Nova', 'Rex', 'Sage', 'Iris', 'Orion', 'Pixel'];

const EMOJI_OPTIONS = [
  '🤖',
  '🐱',
  '🐙',
  '🦁',
  '⚡',
  '🌙',
  '🍥',
  '🔥',
  '🦄',
  '🧠',
  '🐉',
  '✨',
  '🌊',
  '🎪',
  '🦋',
  '💎',
];

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
      {/* Name */}
      <div className="space-y-3">
        <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          What should we call it?
        </h3>
        <Input
          value={botName}
          onChange={e => setBotName(e.target.value)}
          maxLength={80}
          placeholder="e.g. Aria, Sage, Nova..."
        />
        <div className="flex flex-wrap gap-2">
          {NAME_SUGGESTIONS.map(name => (
            <button
              key={name}
              type="button"
              className={cn(
                'rounded-full border px-3 py-1 text-sm transition-colors',
                botName === name
                  ? 'border-blue-500 bg-blue-500/10 text-blue-400'
                  : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
              )}
              onClick={() => setBotName(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      {/* Emoji picker */}
      <div className="space-y-3">
        <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          Pick a signature emoji
        </h3>
        <div className="grid grid-cols-8 gap-2">
          {EMOJI_OPTIONS.map(emoji => (
            <button
              key={emoji}
              type="button"
              className={cn(
                'flex h-12 items-center justify-center rounded-lg border text-xl transition-colors',
                selectedEmoji === emoji && !customEmoji
                  ? 'border-blue-500 bg-blue-500/10'
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

      {/* Nature */}
      <div className="space-y-3">
        <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          What kind of creature is it?
        </h3>
        <div className="grid gap-3 md:grid-cols-2">
          {NATURE_PRESETS.map(preset => (
            <button
              key={preset.id}
              type="button"
              className={cn(
                'flex items-center gap-3 rounded-lg border p-4 text-left transition-colors',
                selectedNatureId === preset.id
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-border hover:border-foreground/30 hover:bg-muted/50'
              )}
              onClick={() => setSelectedNatureId(preset.id)}
            >
              <span className="text-2xl">{preset.emoji}</span>
              <div>
                <p className="text-foreground font-medium">{preset.label}</p>
                <p className="text-muted-foreground text-sm">{preset.vibe}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Preview */}
      <div className="border-border bg-muted/30 flex items-center gap-3 rounded-lg border p-4">
        <span className="text-2xl">{activeEmoji}</span>
        <div>
          <p className="text-foreground font-medium">{botName || 'Your bot'}</p>
          <p className="text-muted-foreground text-sm">{nature.label}</p>
        </div>
      </div>

      <Button
        className="w-full bg-emerald-600 py-6 text-base text-white hover:bg-emerald-700"
        onClick={handleContinue}
      >
        Continue
        <ChevronRight className="ml-1 h-5 w-5" />
      </Button>
    </OnboardingStepView>
  );
}
