'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingProvider, useOnboarding } from './OnboardingContext';
import { OnboardingStepName } from './OnboardingStepName';
import { OnboardingStepRepo } from './OnboardingStepRepo';
import { OnboardingStepModel } from './OnboardingStepModel';
import { OnboardingStepTask } from './OnboardingStepTask';

const STEPS = [
  { key: 'name', label: 'Name' },
  { key: 'model', label: 'Models' },
  { key: 'repo', label: 'Repo' },
  { key: 'task', label: 'Task' },
] as const;

type StepKey = (typeof STEPS)[number]['key'];

function StepIndicator({ currentIndex }: { currentIndex: number }) {
  return (
    <div className="flex items-center justify-center gap-0">
      {STEPS.map((step, i) => {
        const status = i < currentIndex ? 'completed' : i === currentIndex ? 'current' : 'pending';

        return (
          <div key={step.key} className="flex items-center">
            {/* Step circle + label */}
            <div className="flex flex-col items-center gap-1.5">
              <div className="relative flex items-center justify-center">
                {status === 'completed' ? (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                  >
                    <CheckCircle className="size-6 text-emerald-400" />
                  </motion.div>
                ) : status === 'current' ? (
                  <div className="relative">
                    <motion.div
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                      className="flex size-6 items-center justify-center rounded-full border-2 border-[color:oklch(95%_0.15_108)] bg-[color:oklch(95%_0.15_108_/_0.15)]"
                    >
                      <span className="text-xs font-bold text-[color:oklch(95%_0.15_108)]">
                        {i + 1}
                      </span>
                    </motion.div>
                    <span className="absolute -inset-1 animate-ping rounded-full bg-[color:oklch(95%_0.15_108_/_0.12)]" />
                  </div>
                ) : (
                  <div className="flex size-6 items-center justify-center rounded-full border border-white/15">
                    <span className="text-xs text-white/25">{i + 1}</span>
                  </div>
                )}
              </div>
              <span
                className={`text-[11px] font-medium ${
                  status === 'completed'
                    ? 'text-white/60'
                    : status === 'current'
                      ? 'text-white/90'
                      : 'text-white/25'
                }`}
              >
                {step.label}
              </span>
            </div>

            {/* Connector line between steps */}
            {i < STEPS.length - 1 && (
              <div className="mx-4 mb-5 h-px w-16">
                <div
                  className={`h-full w-full transition-colors duration-300 ${
                    i < currentIndex ? 'bg-emerald-500/40' : 'bg-white/[0.08]'
                  }`}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Triggers background town creation + mayor pre-warm when the repo step is reached. */
function BackgroundProvisioner({ currentStepKey }: { currentStepKey: StepKey }) {
  const { provisionTownInBackground } = useOnboarding();

  useEffect(() => {
    if (currentStepKey === 'repo') {
      provisionTownInBackground();
    }
  }, [currentStepKey, provisionTownInBackground]);

  return null;
}

/** Best-effort cleanup of the background town if the user closes/navigates away. */
function AbandonmentCleanup() {
  const { deleteBackgroundTown, backgroundTownId } = useOnboarding();

  useEffect(() => {
    if (!backgroundTownId) return;

    const handleBeforeUnload = () => {
      deleteBackgroundTown({ keepalive: true });
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [backgroundTownId, deleteBackgroundTown]);

  return null;
}

function CancelButton() {
  const router = useRouter();
  const { deleteBackgroundTown, state } = useOnboarding();

  const handleCancel = useCallback(() => {
    // Use keepalive fetch — router.push unmounts the provider which cancels tRPC mutations
    deleteBackgroundTown({ keepalive: true });
    const destination = state.orgId ? `/organizations/${state.orgId}/gastown` : '/gastown';
    router.push(destination);
  }, [deleteBackgroundTown, state.orgId, router]);

  return (
    <button
      type="button"
      onClick={handleCancel}
      className="flex items-center gap-1.5 text-sm text-white/40 transition-colors hover:text-white/70"
    >
      <X className="size-4" />
      Cancel
    </button>
  );
}

function WizardContent() {
  const searchParams = useSearchParams();
  const orgId = searchParams.get('orgId');
  const [currentStepKey, setCurrentStepKey] = useState<StepKey>('name');

  const currentIndex = STEPS.findIndex(s => s.key === currentStepKey);

  const goNext = useCallback(() => {
    const nextIndex = currentIndex + 1;
    if (nextIndex < STEPS.length) {
      setCurrentStepKey(STEPS[nextIndex].key);
    }
  }, [currentIndex]);

  const goBack = useCallback(() => {
    const prevIndex = currentIndex - 1;
    if (prevIndex >= 0) {
      setCurrentStepKey(STEPS[prevIndex].key);
    }
  }, [currentIndex]);

  const isFirstStep = currentIndex === 0;
  const isLastStep = currentIndex === STEPS.length - 1;

  return (
    <OnboardingProvider goNext={goNext} orgId={orgId}>
      <BackgroundProvisioner currentStepKey={currentStepKey} />
      <AbandonmentCleanup />
      <div className="flex min-h-[calc(100vh-4rem)] flex-col items-center px-4 py-8">
        {/* Top bar with cancel */}
        <div className="mb-4 flex w-full max-w-xl justify-start">
          <CancelButton />
        </div>

        {/* Header */}
        <div className="mb-2 text-center">
          <h1 className="text-2xl font-bold text-white/95">Set up your town</h1>
          <p className="mt-1 text-sm text-white/40">
            Get from zero to an agent working on your code in under 2 minutes.
          </p>
        </div>

        {/* Step indicator */}
        <div className="mb-8 mt-6">
          <StepIndicator currentIndex={currentIndex} />
        </div>

        {/* Step content */}
        <div className="w-full max-w-xl flex-1">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentStepKey}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              {currentStepKey === 'name' && <OnboardingStepName />}
              {currentStepKey === 'model' && <OnboardingStepModel />}
              {currentStepKey === 'repo' && <OnboardingStepRepo />}
              {currentStepKey === 'task' && <OnboardingStepTask />}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Navigation buttons */}
        <div className="mt-8 flex w-full max-w-xl items-center justify-between">
          <Button
            variant="ghost"
            onClick={goBack}
            disabled={isFirstStep}
            className="gap-1.5 text-white/60 hover:text-white/90 disabled:opacity-0"
          >
            <ChevronLeft className="size-4" />
            Back
          </Button>

          {isLastStep ? (
            <FinalStepNav />
          ) : (
            <Button
              onClick={goNext}
              className="gap-1.5 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
            >
              Next
              <ChevronRight className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </OnboardingProvider>
  );
}

/** Create Town button shown in the bottom nav on the final (task) step. */
function FinalStepNav() {
  const { finalStepHandlers: handlers } = useOnboarding();

  if (!handlers) return null;

  if (handlers.isSubmitting) {
    return <Loader2 className="size-5 animate-spin text-[color:oklch(95%_0.15_108_/_0.7)]" />;
  }

  return (
    <Button
      onClick={handlers.submit}
      disabled={!handlers.canSubmit}
      className="h-10 gap-1.5 px-6 text-sm font-medium bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)] disabled:opacity-50"
    >
      Create Town & Start
      <ChevronRight className="size-4" />
    </Button>
  );
}

export function OnboardingWizardClient() {
  return <WizardContent />;
}
