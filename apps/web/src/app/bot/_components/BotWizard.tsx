'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CATEGORIES, type PlatformId } from './platforms';
import { PlatformTile } from './PlatformTile';

export function BotWizard() {
  const [stepIndex, setStepIndex] = useState(0);
  const [selected, setSelected] = useState<Set<PlatformId>>(new Set());

  const category = CATEGORIES[stepIndex];
  const isLastStep = stepIndex === CATEGORIES.length - 1;

  const stepSelectionCount = useMemo(
    () => category.options.filter(o => selected.has(o.id)).length,
    [category, selected]
  );
  const canAdvance = stepSelectionCount > 0;

  const handleToggle = (platformId: PlatformId) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(platformId)) {
        next.delete(platformId);
      } else {
        next.add(platformId);
      }
      return next;
    });
  };

  const handleNext = () => {
    if (!canAdvance) return;
    if (!isLastStep) setStepIndex(i => i + 1);
  };

  const handleBack = () => {
    if (stepIndex > 0) setStepIndex(i => i - 1);
  };

  return (
    <div className="flex w-full flex-col gap-10">
      <StepIndicator activeIndex={stepIndex} />

      <AnimatePresence mode="wait" initial={false}>
        <motion.section
          key={category.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
          className="flex flex-col gap-8"
          aria-labelledby={`step-${category.id}-title`}
        >
          <header className="flex flex-col gap-2">
            <span className="text-muted-foreground text-[11px] font-semibold tracking-[0.06em] uppercase">
              {category.eyebrow}
            </span>
            <h1 id={`step-${category.id}-title`} className="text-3xl font-bold tracking-tight">
              {category.title}
            </h1>
            <p className="text-muted-foreground text-sm">{category.hint}</p>
          </header>

          <div
            className={cn(
              'grid gap-3',
              category.options.length <= 2
                ? 'grid-cols-1 sm:grid-cols-2'
                : 'grid-cols-2 sm:grid-cols-3'
            )}
            role="group"
            aria-label={category.title}
          >
            {category.options.map(option => (
              <PlatformTile
                key={option.id}
                option={option}
                selected={selected.has(option.id)}
                onSelect={() => handleToggle(option.id)}
              />
            ))}
          </div>
        </motion.section>
      </AnimatePresence>

      <footer className="flex items-center justify-between">
        <Button
          variant="ghost"
          onClick={handleBack}
          disabled={stepIndex === 0}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back
        </Button>

        <Button onClick={handleNext} disabled={!canAdvance}>
          {isLastStep ? 'Finish' : 'Continue'}
          <ArrowRight className="size-4" />
        </Button>
      </footer>
    </div>
  );
}

function StepIndicator({ activeIndex }: { activeIndex: number }) {
  return (
    <div
      className="flex items-center gap-2"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={CATEGORIES.length}
      aria-valuenow={activeIndex + 1}
      aria-label="Setup progress"
    >
      {CATEGORIES.map((_, i) => (
        <span
          key={i}
          className={cn(
            'h-1 flex-1 rounded-full transition-colors duration-200',
            i <= activeIndex ? 'bg-primary' : 'bg-border'
          )}
        />
      ))}
    </div>
  );
}
