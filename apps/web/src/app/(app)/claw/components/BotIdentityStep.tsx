'use client';

import { useState } from 'react';
import { ChevronRight, Shuffle } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { OnboardingStepView } from './OnboardingStepView';
import type { BotIdentity } from './claw.types';
import { cn } from '@/lib/utils';

const SHUFFLE_STEPS = 4;
const SHUFFLE_INTERVAL_MS = 90;
const EASE_OUT_QUART = [0.22, 1, 0.36, 1] as const;
const TAP_EASE = { duration: 0.12, ease: EASE_OUT_QUART } as const;
const TEXT_SWAP_EASE = { duration: 0.18, ease: EASE_OUT_QUART } as const;

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
  const [selectedNatureId, setSelectedNatureId] = useState('ai-assistant');
  const [isShuffling, setIsShuffling] = useState(false);
  const reducedMotion = useReducedMotion();

  const nature = NATURE_PRESETS.find(n => n.id === selectedNatureId) ?? NATURE_PRESETS[0];

  async function handleShuffle() {
    if (isShuffling) return;
    if (reducedMotion) {
      setBotName(pickRandom(NAME_SUGGESTIONS));
      setSelectedEmoji(pickRandom(EMOJI_OPTIONS));
      setSelectedNatureId(pickRandom(NATURE_PRESETS).id);
      return;
    }
    setIsShuffling(true);
    for (let i = 0; i < SHUFFLE_STEPS; i++) {
      setBotName(pickRandom(NAME_SUGGESTIONS));
      setSelectedEmoji(pickRandom(EMOJI_OPTIONS));
      setSelectedNatureId(pickRandom(NATURE_PRESETS).id);
      await new Promise(resolve => setTimeout(resolve, SHUFFLE_INTERVAL_MS));
    }
    setBotName(pickRandom(NAME_SUGGESTIONS));
    setSelectedEmoji(pickRandom(EMOJI_OPTIONS));
    setSelectedNatureId(pickRandom(NATURE_PRESETS).id);
    setIsShuffling(false);
  }

  function handleContinue() {
    onContinue({
      botName: botName.trim() || 'KiloClaw',
      botEmoji: selectedEmoji,
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
      <div className="grid gap-6 md:grid-cols-[1fr_2fr] md:gap-8">
        <div className="relative">
          <div className="border-border bg-muted/30 relative flex h-full flex-col items-center justify-center gap-4 overflow-hidden rounded-lg border p-8 text-center">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundImage: `linear-gradient(var(--muted-foreground) 1px, transparent 1px), linear-gradient(90deg, var(--muted-foreground) 1px, transparent 1px)`,
                backgroundSize: '28px 28px',
                maskImage: 'radial-gradient(circle at 50% 50%, black 25%, transparent 75%)',
                WebkitMaskImage: 'radial-gradient(circle at 50% 50%, black 25%, transparent 75%)',
                opacity: 0.22,
              }}
            />
            <div className="relative flex h-24 w-24 items-center justify-center">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={selectedEmoji}
                  initial={{ scale: 0.85, opacity: 0, rotate: -8 }}
                  animate={{ scale: 1, opacity: 1, rotate: 0 }}
                  exit={{ scale: 0.85, opacity: 0, rotate: 8 }}
                  transition={{ type: 'spring', stiffness: 380, damping: 26 }}
                  className="text-7xl leading-none"
                >
                  {selectedEmoji}
                </motion.span>
              </AnimatePresence>
            </div>
            <div className="relative flex min-h-[3.5rem] flex-col items-center gap-1">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.p
                  key={botName || 'empty'}
                  initial={{ y: 4, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -4, opacity: 0 }}
                  transition={TEXT_SWAP_EASE}
                  className={cn(
                    'text-xl font-semibold',
                    botName ? 'text-foreground' : 'text-muted-foreground italic'
                  )}
                >
                  {botName || 'Your bot'}
                </motion.p>
              </AnimatePresence>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.p
                  key={nature.label}
                  initial={{ y: 4, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -4, opacity: 0 }}
                  transition={TEXT_SWAP_EASE}
                  className="text-muted-foreground text-sm"
                >
                  {nature.label}
                </motion.p>
              </AnimatePresence>
            </div>
          </div>
          <motion.button
            type="button"
            onClick={handleShuffle}
            disabled={isShuffling}
            aria-label="Shuffle name and emoji"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.97 }}
            transition={TAP_EASE}
            className="bg-card border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 absolute bottom-0 left-1/2 flex h-11 w-11 -translate-x-1/2 translate-y-1/2 cursor-pointer items-center justify-center rounded-full border shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Shuffle className="h-4 w-4" />
          </motion.button>
        </div>

        <div className="flex flex-col gap-6">
          <div className="space-y-3">
            <Input
              value={botName}
              onChange={e => setBotName(e.target.value)}
              maxLength={80}
              placeholder="Name your bot"
            />
            <div className="flex flex-wrap gap-2">
              {NAME_SUGGESTIONS.map(name => (
                <motion.button
                  key={name}
                  type="button"
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  transition={TAP_EASE}
                  className={cn(
                    'cursor-pointer rounded-full border px-3 py-1 text-sm transition-colors',
                    botName === name
                      ? 'border-brand-primary bg-brand-primary/10 text-brand-primary'
                      : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
                  )}
                  onClick={() => setBotName(name)}
                >
                  {name}
                </motion.button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            {EMOJI_OPTIONS.map(emoji => (
              <motion.button
                key={emoji}
                type="button"
                whileHover={{ scale: 1.05, y: -1 }}
                whileTap={{ scale: 0.97 }}
                transition={TAP_EASE}
                className={cn(
                  'flex h-14 w-14 cursor-pointer items-center justify-center rounded-lg border text-2xl transition-colors',
                  selectedEmoji === emoji
                    ? 'border-brand-primary bg-brand-primary/10'
                    : 'border-border hover:border-foreground/30 hover:bg-muted/50'
                )}
                onClick={() => setSelectedEmoji(emoji)}
              >
                {emoji}
              </motion.button>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {NATURE_PRESETS.map(preset => (
              <motion.button
                key={preset.id}
                type="button"
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                transition={TAP_EASE}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors',
                  selectedNatureId === preset.id
                    ? 'border-brand-primary bg-brand-primary/10 text-brand-primary'
                    : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
                )}
                onClick={() => setSelectedNatureId(preset.id)}
              >
                <span>{preset.emoji}</span>
                {preset.label}
              </motion.button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          className="bg-brand-primary hover:bg-brand-primary/90 text-black"
          onClick={handleContinue}
        >
          Continue
          <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </OnboardingStepView>
  );
}
