'use client';

import { useMemo, useState, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { OnboardingStepView } from './OnboardingStepView';
import {
  INTEREST_TOPIC_PRESETS,
  MORNING_BRIEFING_INTERESTS_MAX_TOPICS as MAX_TOPICS,
  MORNING_BRIEFING_INTERESTS_MAX_TOPIC_LENGTH as MAX_TOPIC_LENGTH,
} from '@/lib/kiloclaw/morning-briefing-interests';

type InterestsStepViewProps = {
  currentStep: number;
  totalSteps: number;
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

export function InterestsStepView({
  currentStep,
  totalSteps,
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

  const previewText = useMemo(() => {
    if (selected.length === 0) {
      return 'Pick topics to scope tomorrow’s briefing.';
    }
    if (selected.length === 1) {
      return `Tomorrow’s briefing will cover ${selected[0]}.`;
    }
    const head = selected.slice(0, selected.length - 1).join(', ');
    const tail = selected[selected.length - 1];
    return `Tomorrow’s briefing will cover ${head} and ${tail}.`;
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
      description="Pick topics your morning briefing should cover. Choosing topics turns on your daily briefing — you can add your own, adjust the schedule, or turn it off later from settings."
      showProvisioningBanner
    >
      <div className="border-border bg-card flex flex-col gap-5 rounded-lg border p-5 sm:p-6">
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
            Topics
          </span>
          <div className="flex flex-wrap gap-2">
            {INTEREST_TOPIC_PRESETS.map(preset => {
              const active = isPresetSelected(preset, selected);
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => togglePreset(preset)}
                  disabled={!active && atCap}
                  className={`focus-visible:ring-ring rounded-full border px-3 py-1 text-sm transition focus-visible:ring-2 focus-visible:outline-none ${
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50'
                  }`}
                  aria-pressed={active}
                >
                  {preset}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label
            htmlFor="claw-interests-custom"
            className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase"
          >
            Add your own
          </label>
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
                  className="border-border bg-muted text-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
                >
                  {topic}
                  <button
                    type="button"
                    onClick={() => removeTopic(topic)}
                    aria-label={`Remove ${topic}`}
                    className="hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
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
        </div>

        <div className="bg-muted/40 border-border rounded-md border p-3">
          <span className="text-muted-foreground block text-[10px] font-semibold tracking-wider uppercase">
            Morning workflow
          </span>
          <p className="text-foreground mt-1 text-sm">{previewText}</p>
        </div>

        <div className="flex items-center justify-end gap-3 pt-1">
          <Button type="button" variant="ghost" onClick={onSkip} disabled={saving}>
            Skip for now
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => onContinue(selected)}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Continue →'}
          </Button>
        </div>
      </div>
    </OnboardingStepView>
  );
}
