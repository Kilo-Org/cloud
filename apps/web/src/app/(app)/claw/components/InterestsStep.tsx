'use client';

import { useMemo, useState, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { OnboardingStepView } from './OnboardingStepView';
import { BriefingChatPreview } from './BriefingChatPreview';
import type { BotIdentity } from './claw.types';
import { cn } from '@/lib/utils';
import {
  INTEREST_TOPIC_PRESETS,
  MORNING_BRIEFING_INTERESTS_MAX_TOPICS as MAX_TOPICS,
  MORNING_BRIEFING_INTERESTS_MAX_TOPIC_LENGTH as MAX_TOPIC_LENGTH,
} from '@/lib/kiloclaw/morning-briefing-interests';

const EASE_OUT_QUART = [0.22, 1, 0.36, 1] as const;
const TAP_EASE = { duration: 0.12, ease: EASE_OUT_QUART } as const;

/**
 * Static realistic preview lines per preset topic, used in the
 * morning-briefing preview card so users can see what each topic
 * means before committing. Custom topics fall back to a generic
 * line composed at render time.
 */
const TOPIC_PREVIEW_SAMPLES: Record<string, string> = {
  Tech: 'Tech: 3 stories on developer tools and AI',
  AI: 'AI: GPT-5 evaluations, new Claude API updates',
  Finance: 'Finance: SPY 0.4%, NVDA 1.8%, Bitcoin steady',
  Health: 'Health: New CDC guidance on flu season',
  Startups: 'Startups: 4 funding rounds in fintech and devtools',
  Markets: 'Markets: Pre-market movers and overnight earnings',
  Science: 'Science: 2 climate papers, 1 fusion update',
  Design: 'Design: Linear release notes, Figma plugin updates',
  'Local News': 'Local: 6 mi rain expected, light traffic',
  Sports: 'Sports: NBA scores from last night, MLB on tap',
};

type InterestsStepViewProps = {
  currentStep: number;
  totalSteps: number;
  bot: BotIdentity;
  /** Existing topics from Postgres, if any (e.g. resume after refresh). */
  initialTopics?: string[];
  /** True when the save mutation is in flight. */
  saving: boolean;
  /** Save and advance. Called with the final topic list. */
  onContinue: (topics: string[]) => void;
  /** Skip without saving; equivalent to "no topics selected." */
  onSkip: () => void;
};

function normalizeTopic(value: string): string {
  return value.trim();
}

function isPresetSelected(topic: string, selected: string[]): boolean {
  return selected.some(value => value.toLowerCase() === topic.toLowerCase());
}

function previewLineForTopic(topic: string): string {
  return TOPIC_PREVIEW_SAMPLES[topic] ?? `${topic}: relevant news from your sources`;
}

export function InterestsStepView({
  currentStep,
  totalSteps,
  bot,
  initialTopics = [],
  saving,
  onContinue,
  onSkip,
}: InterestsStepViewProps) {
  const [selected, setSelected] = useState<string[]>(() =>
    initialTopics.map(normalizeTopic).filter(value => value.length > 0)
  );
  const [customInput, setCustomInput] = useState('');

  const customTopics = useMemo(
    () =>
      selected.filter(
        topic =>
          !INTEREST_TOPIC_PRESETS.some(preset => preset.toLowerCase() === topic.toLowerCase())
      ),
    [selected]
  );

  const previewItems = useMemo(() => {
    const calendarLine = '2 calendar events on your day';
    const topicLines = selected.map(previewLineForTopic);
    // Cap visible topics so the preview shell stays a predictable height
    // even when the user picks many topics. Past the cap we collapse the
    // remainder into a single "+ N more topics" line so the magnitude is
    // still honest without unbounded vertical growth.
    const TOPIC_CAP = 6;
    if (topicLines.length <= TOPIC_CAP) {
      return [calendarLine, ...topicLines];
    }
    const visible = topicLines.slice(0, TOPIC_CAP);
    const hidden = topicLines.length - TOPIC_CAP;
    return [calendarLine, ...visible, `+ ${hidden} more topic${hidden === 1 ? '' : 's'}`];
  }, [selected]);

  function togglePreset(topic: string) {
    setSelected(current => {
      if (isPresetSelected(topic, current)) {
        return current.filter(value => value.toLowerCase() !== topic.toLowerCase());
      }
      if (current.length >= MAX_TOPICS) return current;
      return [...current, topic];
    });
  }

  function addCustom() {
    const value = normalizeTopic(customInput).slice(0, MAX_TOPIC_LENGTH);
    if (!value) return;
    setSelected(current => {
      if (isPresetSelected(value, current)) return current;
      if (current.length >= MAX_TOPICS) return current;
      return [...current, value];
    });
    setCustomInput('');
  }

  function removeTopic(topic: string) {
    setSelected(current => current.filter(value => value !== topic));
  }

  function handleCustomKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      addCustom();
    }
  }

  const atCap = selected.length >= MAX_TOPICS;

  return (
    <OnboardingStepView
      currentStep={currentStep}
      totalSteps={totalSteps}
      stepLabel={`Step ${currentStep} of ${totalSteps} · Interests`}
      title="What should your bot watch?"
      description="Pick topics to turn on your daily briefing. Adjust later in settings."
      showProvisioningBanner
      contentClassName="gap-6"
    >
      <div className="grid gap-6 md:grid-cols-[1fr_2fr] md:gap-8">
        <BriefingChatPreview
          bot={bot}
          greeting={selected.length === 0 ? 'Good morning.' : 'Good morning. Here\u2019s your day.'}
          items={selected.length === 0 ? [] : previewItems}
          emptyMessage="Pick a topic to see your briefing take shape."
          closer={selected.length > 0 ? 'Have a good one.' : undefined}
        />

        <div className="flex flex-col gap-8">
          <section className="flex flex-col gap-3">
            <div className="flex items-baseline gap-2">
              <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
                Topics
              </h3>
              <span className="text-muted-foreground/80 text-xs">
                Pick what your briefing covers
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {INTEREST_TOPIC_PRESETS.map(preset => {
                const active = isPresetSelected(preset, selected);
                return (
                  <motion.button
                    key={preset}
                    type="button"
                    aria-pressed={active}
                    disabled={!active && atCap}
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    transition={TAP_EASE}
                    onClick={() => togglePreset(preset)}
                    className={cn(
                      'focus-visible:ring-brand-primary/60 cursor-pointer rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
                      active
                        ? 'border-brand-primary bg-brand-primary/10 text-brand-primary'
                        : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
                    )}
                  >
                    {preset}
                  </motion.button>
                );
              })}
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex items-baseline gap-2">
              <label
                htmlFor="claw-interests-custom"
                className="text-muted-foreground text-xs font-semibold tracking-wider uppercase"
              >
                Add your own
              </label>
              <span className="text-muted-foreground/80 text-xs">
                Anything specific you want covered
              </span>
            </div>
            <div className="flex gap-2">
              <Input
                id="claw-interests-custom"
                value={customInput}
                onChange={event => setCustomInput(event.target.value)}
                onKeyDown={handleCustomKeyDown}
                maxLength={MAX_TOPIC_LENGTH}
                placeholder="e.g. Biotech, NBA, Real estate"
                disabled={atCap}
              />
              <Button
                type="button"
                variant="outline"
                onClick={addCustom}
                disabled={!customInput.trim() || atCap}
              >
                <Plus className="h-4 w-4" />
                Add
              </Button>
            </div>
            {customTopics.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {customTopics.map(topic => (
                  <span
                    key={topic}
                    className="border-brand-primary/40 bg-brand-primary/10 text-brand-primary inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm"
                  >
                    {topic}
                    <button
                      type="button"
                      onClick={() => removeTopic(topic)}
                      aria-label={`Remove ${topic}`}
                      className="hover:text-foreground transition-colors"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {atCap && (
              <span className="text-muted-foreground text-xs">
                Maximum of {MAX_TOPICS} topics. Remove one to add another.
              </span>
            )}
          </section>
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 pt-2">
        <Button type="button" variant="ghost" size="lg" onClick={onSkip} disabled={saving}>
          Skip for now
        </Button>
        <Button
          type="button"
          variant="default"
          size="lg"
          className="bg-brand-primary hover:bg-brand-primary/90"
          onClick={() => onContinue(selected)}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Continue'}
        </Button>
      </div>
    </OnboardingStepView>
  );
}
