'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useRouter, useSearchParams } from 'next/navigation';
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
import { useTRPC } from '@/lib/trpc/utils';
import { ALL_PLATFORMS, CHAT_PLATFORM_IDS, CODE_PLATFORM_IDS, type PlatformId } from './platforms';
import { PlatformTile } from './PlatformTile';
import {
  buildPlatformSetupStatuses,
  canSelectPlatform,
  getConnectedPlatformIds,
  getSelectedServiceIdsToAuthorize,
  hasAnyConfiguredOrSelectedPlatform,
  isCheckingPlatformSetup,
  type PlatformSetupStatusMap,
} from './setup-status';
import { buildSetupPath, getInitialSetupState } from './setup-path';
import { WorkspaceSelector, type WorkspaceSelection } from './WorkspaceSelector';

const TOTAL_STEPS = 2;
type MissingPlatformWarning = 'chat' | 'code';

export function BotWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const setupSearch = searchParams.toString();
  const trpc = useTRPC();
  const [setupState, setSetupState] = useState(() => getInitialSetupState(searchParams));
  const [selected, setSelected] = useState<Set<PlatformId>>(new Set());
  const [missingPlatformWarning, setMissingPlatformWarning] =
    useState<MissingPlatformWarning | null>(null);
  const { stepIndex, workspace } = setupState;

  const isWorkspaceStep = stepIndex === 0;
  const setupInput = workspace?.type === 'org' ? { organizationId: workspace.id } : undefined;
  const shouldCheckSetup = workspace !== null && !isWorkspaceStep;

  const setupQuery = useQuery(
    trpc.platformIntegrations.listSetupStatus.queryOptions(setupInput, {
      enabled: shouldCheckSetup,
    })
  );

  const setupStatuses = buildPlatformSetupStatuses({
    data: setupQuery.data,
    isError: setupQuery.isError,
    isFetching: setupQuery.isFetching,
    isLoading: setupQuery.isLoading,
  });

  const isCheckingSetup = isCheckingPlatformSetup(setupStatuses);
  const servicesToAuthorize = getSelectedServiceIdsToAuthorize(selected, setupStatuses);
  const connectedPlatformIds = getConnectedPlatformIds(setupStatuses);
  const hasChatPlatform = hasAnyConfiguredOrSelectedPlatform(
    CHAT_PLATFORM_IDS,
    selected,
    setupStatuses
  );
  const hasCodePlatform = hasAnyConfiguredOrSelectedPlatform(
    CODE_PLATFORM_IDS,
    selected,
    setupStatuses
  );
  const canAdvance = isWorkspaceStep ? workspace !== null : workspace !== null && !isCheckingSetup;

  useEffect(() => {
    const params = new URLSearchParams(setupSearch);
    const nextSetupState = getInitialSetupState(params);
    setSetupState(nextSetupState);
    setMissingPlatformWarning(null);

    if (params.has('step') && nextSetupState.stepIndex === 0) {
      router.replace(buildSetupPath(nextSetupState), { scroll: false });
    }
  }, [router, setupSearch]);

  const navigateToStep = (nextStepIndex: number, nextWorkspace: WorkspaceSelection | null) => {
    const nextSetupState = { stepIndex: nextStepIndex, workspace: nextWorkspace };
    setMissingPlatformWarning(null);
    setSetupState(nextSetupState);
    router.push(buildSetupPath(nextSetupState), {
      scroll: false,
    });
  };

  const handleToggle = (platformId: PlatformId) => {
    if (!canSelectPlatform(setupStatuses[platformId])) return;

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
    if (workspace === null) return;
    setMissingPlatformWarning(null);
    const params = new URLSearchParams();
    if (servicesToAuthorize.length > 0) {
      params.set('services', servicesToAuthorize.join(','));
    }
    if (connectedPlatformIds.length > 0) {
      params.set('connected', connectedPlatformIds.join(','));
    }
    if (workspace?.type === 'org') {
      params.set('organizationId', workspace.id);
    }
    const query = params.toString();
    router.push(query ? `/collab/authorize?${query}` : '/collab/authorize');
  };

  const handleContinueWithoutRecommendedPlatform = () => {
    if (isCheckingSetup || workspace === null) return;

    if (missingPlatformWarning === 'chat' && !hasCodePlatform) {
      setMissingPlatformWarning('code');
      return;
    }
    proceedToAuthorize();
  };

  const handleNext = () => {
    if (!canAdvance) return;
    if (isWorkspaceStep) {
      if (workspace === null) return;
      navigateToStep(1, workspace);
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
    navigateToStep(1, selection);
  };

  const handleBack = () => {
    if (stepIndex > 0) navigateToStep(stepIndex - 1, workspace);
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
                Already set up services are marked and count toward setup. Select any remaining
                services Kilo should use.
              </p>
            </header>

            <ExistingSetupNotice statuses={setupStatuses} />

            <div
              className="grid grid-cols-1 gap-3 sm:grid-cols-2"
              role="group"
              aria-label="Integration setup status"
            >
              {ALL_PLATFORMS.map(option => (
                <PlatformTile
                  key={option.id}
                  option={option}
                  selected={selected.has(option.id)}
                  setupStatus={setupStatuses[option.id]}
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
          {!isWorkspaceStep && isCheckingSetup ? 'Checking setup...' : 'Continue'}
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
            <Button
              variant="ghost"
              onClick={handleContinueWithoutRecommendedPlatform}
              disabled={isCheckingSetup}
            >
              {missingPlatformWarning === 'code'
                ? 'Continue without code'
                : 'Continue without chat'}
            </Button>
            <Button onClick={() => setMissingPlatformWarning(null)} disabled={isCheckingSetup}>
              {missingPlatformWarning === 'code' ? 'Choose code platform' : 'Choose chat service'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ExistingSetupNotice({ statuses }: { statuses: PlatformSetupStatusMap }) {
  const connectedPlatformIds = getConnectedPlatformIds(statuses);
  const isCheckingSetup = isCheckingPlatformSetup(statuses);

  if (isCheckingSetup) {
    return (
      <div
        className="text-muted-foreground flex items-center gap-2 rounded-lg border border-border bg-card/70 px-3 py-2 text-sm"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Checking existing integrations...
      </div>
    );
  }

  if (connectedPlatformIds.length === 0) return null;

  const connectedNames = connectedPlatformIds.map(getPlatformName);

  return (
    <div className="flex gap-3 rounded-lg border border-green-500/20 bg-green-500/10 px-3 py-2 text-sm text-green-100">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-400" aria-hidden="true" />
      <p className="leading-relaxed">
        <span className="font-medium text-green-300">
          Already set up: {formatPlatformList(connectedNames)}.
        </span>{' '}
        Select anything else you want to connect now.
      </p>
    </div>
  );
}

function getPlatformName(platformId: PlatformId): string {
  return ALL_PLATFORMS.find(platform => platform.id === platformId)?.name ?? platformId;
}

function formatPlatformList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'None';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
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
