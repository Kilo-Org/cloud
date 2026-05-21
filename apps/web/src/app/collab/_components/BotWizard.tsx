'use client';

import { useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { ALL_PLATFORMS, CHAT_PLATFORM_IDS, CODE_PLATFORM_IDS, type PlatformId } from './platforms';
import { PlatformTile } from './PlatformTile';
import { WorkspaceSelector, type WorkspaceSelection } from './WorkspaceSelector';

const TOTAL_STEPS = 2;
type MissingPlatformWarning = 'chat' | 'code';

export function BotWizard() {
  const router = useRouter();
  const [stepIndex, setStepIndex] = useState(0);
  const [selected, setSelected] = useState<Set<PlatformId>>(new Set());
  const [workspace, setWorkspace] = useState<WorkspaceSelection | null>(null);
  const [missingPlatformWarning, setMissingPlatformWarning] =
    useState<MissingPlatformWarning | null>(null);

  const isWorkspaceStep = stepIndex === 0;
  const hasChatPlatform = Array.from(selected).some(platformId =>
    CHAT_PLATFORM_IDS.has(platformId)
  );
  const hasCodePlatform = Array.from(selected).some(platformId =>
    CODE_PLATFORM_IDS.has(platformId)
  );
  const canAdvance = isWorkspaceStep ? workspace !== null : true;

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

  const proceedToAuthorize = () => {
    setMissingPlatformWarning(null);
    const params = new URLSearchParams({ services: Array.from(selected).join(',') });
    if (workspace?.type === 'org') {
      params.set('organizationId', workspace.id);
    }
    router.push(`/collab/authorize?${params.toString()}`);
  };

  const handleContinueWithoutRecommendedPlatform = () => {
    if (missingPlatformWarning === 'chat' && !hasCodePlatform) {
      setMissingPlatformWarning('code');
      return;
    }
    proceedToAuthorize();
  };

  const handleNext = () => {
    if (!canAdvance) return;
    if (isWorkspaceStep) {
      setStepIndex(1);
      return;
    }
    if (!hasChatPlatform) {
      setMissingPlatformWarning('chat');
      return;
    }
    if (!hasCodePlatform) {
      setMissingPlatformWarning('code');
      return;
    }
    proceedToAuthorize();
  };

  const handleWorkspaceSelect = (selection: WorkspaceSelection) => {
    setWorkspace(selection);
    setStepIndex(1);
  };

  const handleBack = () => {
    if (stepIndex > 0) setStepIndex(i => i - 1);
  };

  return (
    <div className="flex w-full flex-col gap-10">
      <StepIndicator activeIndex={stepIndex} />

      <AnimatePresence mode="wait" initial={false}>
        {isWorkspaceStep ? (
          <motion.section
            key="workspace"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
            className="flex flex-col gap-8"
            aria-labelledby="step-workspace-title"
          >
            <header className="flex flex-col gap-2">
              <span className="text-muted-foreground text-[11px] font-semibold tracking-[0.06em] uppercase">
                Step 1 of 2
              </span>
              <h1 id="step-workspace-title" className="text-3xl font-bold tracking-tight">
                Where do you want to install Kilo?
              </h1>
              <p className="text-muted-foreground text-sm">
                Organizations are ideal for team collaboration. You can also install on your
                personal account.
              </p>
            </header>

            <WorkspaceSelector value={workspace} onSelect={handleWorkspaceSelect} />
          </motion.section>
        ) : (
          <motion.section
            key="services"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
            className="flex flex-col gap-8"
            aria-labelledby="step-services-title"
          >
            <header className="flex flex-col gap-2">
              <span className="text-muted-foreground text-[11px] font-semibold tracking-[0.06em] uppercase">
                Step 2 of 2
              </span>
              <h1 id="step-services-title" className="text-3xl font-bold tracking-tight">
                What services do you want to connect?
              </h1>
              <p className="text-muted-foreground text-sm">
                Select every service Kilo should use. Each service appears once; you can skip any
                authorization screen later.
              </p>
            </header>

            <div
              className="grid grid-cols-1 gap-3 sm:grid-cols-2"
              role="group"
              aria-label="Services to connect"
            >
              {ALL_PLATFORMS.map(option => (
                <PlatformTile
                  key={option.id}
                  option={option}
                  selected={selected.has(option.id)}
                  onSelect={() => handleToggle(option.id)}
                />
              ))}
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      <footer className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
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
          Continue
          <ArrowRight className="size-4" />
        </Button>
      </footer>

      <Dialog
        open={missingPlatformWarning !== null}
        onOpenChange={open => {
          if (!open) setMissingPlatformWarning(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {missingPlatformWarning === 'code'
                ? 'Kilo needs a code platform'
                : 'Kilo works best with chat'}
            </DialogTitle>
            <DialogDescription>
              {missingPlatformWarning === 'code'
                ? 'Connect GitHub or GitLab so cloud agents can inspect code and open changes.'
                : "Connect your team's collaboration platform so Kilo can respond where work happens."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:space-x-0">
            <Button variant="ghost" onClick={handleContinueWithoutRecommendedPlatform}>
              {missingPlatformWarning === 'code'
                ? 'Continue without code'
                : 'Continue without chat'}
            </Button>
            <Button onClick={() => setMissingPlatformWarning(null)}>
              {missingPlatformWarning === 'code' ? 'Choose code platform' : 'Choose chat service'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StepIndicator({ activeIndex }: { activeIndex: number }) {
  return (
    <div
      className="flex items-center gap-2"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={TOTAL_STEPS}
      aria-valuenow={activeIndex + 1}
      aria-label="Setup progress"
    >
      {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
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
