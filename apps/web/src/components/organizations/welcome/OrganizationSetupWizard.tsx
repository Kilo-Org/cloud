'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Circle,
  Cloud,
  CodeXml,
  Coins,
  ExternalLink,
  Github,
  GitBranch,
  Key,
  Loader2,
  Mail,
  RefreshCw,
  Route,
  Terminal,
  Users,
} from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import {
  ORGANIZATION_ONBOARDING_STEP_KEYS,
  type OrganizationOnboardingStepKey,
} from '@/lib/organizations/onboarding-steps';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { canManageOrganizationBilling } from '@kilocode/app-shared/organizations';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { InviteMemberDialog } from '@/components/organizations/members/InviteMemberDialog';
import { useUserOrganizationRole } from '@/components/organizations/OrganizationContext';
import { OpenInExtensionButton } from '@/components/auth/OpenInExtensionButton';
import Image from 'next/image';
import { cn } from '@/lib/utils';
import {
  buildOrganizationWelcomePath,
  getFirstIncompleteOnboardingScreen,
  getNextOnboardingScreen,
  getOrganizationOnboardingScreen,
  getPreviousOnboardingScreen,
  type OrganizationOnboardingScreen,
} from './organization-setup-path';

const GitHubIntegrationDetails = dynamic(
  () =>
    import('@/components/integrations/GitHubIntegrationDetails').then(
      module => module.GitHubIntegrationDetails
    ),
  { loading: GitHubIntegrationDetailsLoading }
);

const STEP_CONTENT = {
  'source-control': {
    title: 'Source Control',
    description: 'Connect GitHub for guided setup, or continue without GitHub if you use GitLab.',
    actionLabel: 'Choose your source control path',
    helpText: 'Guided source control and Code Reviewer setup currently supports GitHub.',
    docsLabel: 'Read the integrations guide',
    docsHref: 'https://kilo.ai/docs/automate/integrations',
    icon: GitBranch,
  },
  'code-reviewer': {
    title: 'Turn on Code Reviewer',
    description: 'Enable AI-assisted reviews for pull requests and merge requests.',
    actionLabel: 'Turn on Code Reviewer',
    helpText:
      'Turn on automatic reviews with balanced defaults. You can fine-tune repositories, review style, and models later.',
    docsLabel: 'Read the Code Reviewer guide',
    docsHref: 'https://kilo.ai/docs/automate/code-reviews',
    icon: CodeXml,
  },
  'invite-team': {
    title: 'Invite your team',
    description: 'Bring teammates into the organization so they can collaborate in Kilo.',
    actionLabel: 'Invite your team',
    helpText:
      'Owners manage organization settings and billing. Billing managers manage billing and can invite members. Members use Kilo with the organization.',
    docsLabel: 'Read the team management guide',
    docsHref: 'https://kilo.ai/docs/collaborate/teams/team-management',
    icon: Users,
  },
} satisfies Record<
  OrganizationOnboardingStepKey,
  {
    title: string;
    description: string;
    actionLabel: string;
    helpText: string;
    docsLabel: string;
    docsHref: string;
    icon: typeof Github;
  }
>;

const STEP_KEYS = ORGANIZATION_ONBOARDING_STEP_KEYS;

function GitHubIntegrationDetailsLoading() {
  return (
    <div className="animate-pulse space-y-4 rounded-xl border border-border bg-surface-background p-6">
      <div className="h-5 w-40 rounded bg-surface-hover" />
      <div className="h-16 rounded-lg bg-surface-raised" />
      <div className="h-10 rounded-md bg-surface-hover" />
    </div>
  );
}

type OrganizationSetupWizardProps = {
  organizationId: string;
};

export function OrganizationSetupWizard({ organizationId }: OrganizationSetupWizardProps) {
  const trpc = useTRPC();
  const router = useRouter();
  const searchParams = useSearchParams();
  const prefersReducedMotion = useReducedMotion();
  const userRole = useUserOrganizationRole();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const handledReturnRef = useRef<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [showGitHubSetup, setShowGitHubSetup] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [visitedSteps, setVisitedSteps] = useState<Set<OrganizationOnboardingStepKey>>(new Set());

  const checklistQueryOptions = trpc.organizations.getOnboardingChecklist.queryOptions({
    organizationId,
  });
  const checklistQuery = useQuery(checklistQueryOptions);
  const enableCodeReviewerMutation = useMutation(
    trpc.organizations.reviewAgent.toggleReviewAgent.mutationOptions()
  );
  const requestedScreen = getOrganizationOnboardingScreen(searchParams);
  const currentScreen =
    requestedScreen ??
    (checklistQuery.data
      ? getFirstIncompleteOnboardingScreen(checklistQuery.data)
      : 'source-control');
  const organizationSummaryQuery = useQuery({
    ...trpc.organizations.getOnboardingSummary.queryOptions({ organizationId }),
    enabled: currentScreen === 'complete',
  });
  const stepState = useMemo(
    () => new Map(checklistQuery.data?.steps.map(step => [step.key, step.done]) ?? []),
    [checklistQuery.data]
  );

  useEffect(() => {
    if (!checklistQuery.data || requestedScreen) return;
    router.replace(
      buildOrganizationWelcomePath(
        organizationId,
        getFirstIncompleteOnboardingScreen(checklistQuery.data)
      ),
      { scroll: false }
    );
  }, [checklistQuery.data, organizationId, requestedScreen, router]);

  useEffect(() => {
    if (!requestedScreen) return;
    headingRef.current?.focus();
    if (requestedScreen !== 'complete') {
      setVisitedSteps(previous => {
        if (previous.has(requestedScreen)) return previous;
        const next = new Set(previous);
        next.add(requestedScreen);
        return next;
      });
    }
  }, [requestedScreen]);

  useEffect(() => {
    const githubResult =
      searchParams.get('github_install') ??
      searchParams.get('github_pending_approval') ??
      searchParams.get('github_action') ??
      searchParams.get('error');
    const returnKey = githubResult ? `github:${githubResult}` : null;

    if (!returnKey) {
      handledReturnRef.current = null;
      return;
    }
    if (handledReturnRef.current === returnKey) return;
    handledReturnRef.current = returnKey;

    const handleReturn = async () => {
      const result = await checklistQuery.refetch();
      const cleanScreen = 'source-control';
      const completed = result.data?.steps.find(step => step.key === cleanScreen)?.done ?? false;

      if (searchParams.get('github_pending_approval') === 'true') {
        setStatusMessage('GitHub is waiting for an organization administrator to approve access.');
      } else if (searchParams.get('error')) {
        setStatusMessage('GitHub setup did not complete. Review the error and try again.');
      } else if (completed) {
        setStatusMessage(`${STEP_CONTENT[cleanScreen].title} is complete.`);
      }

      router.replace(
        buildOrganizationWelcomePath(
          organizationId,
          completed ? getNextOnboardingScreen(cleanScreen) : cleanScreen
        ),
        { scroll: false }
      );
    };

    void handleReturn();
  }, [checklistQuery, organizationId, router, searchParams]);

  const navigate = (screen: OrganizationOnboardingScreen) => {
    setStatusMessage('');
    router.push(buildOrganizationWelcomePath(organizationId, screen), { scroll: false });
  };

  const handleGitHubDetected = async () => {
    const result = await checklistQuery.refetch();
    const completed = result.data?.steps.find(step => step.key === 'source-control')?.done ?? false;
    if (completed) {
      toast.success('GitHub is connected');
      navigate('code-reviewer');
    }
  };

  const handleEnableCodeReviewer = async () => {
    setStatusMessage('');
    const connectedPlatform = checklistQuery.data?.connectedPlatform;
    if (!connectedPlatform) {
      const message = 'Connect GitHub before turning on Code Reviewer.';
      setStatusMessage(message);
      toast.error(message);
      return;
    }

    try {
      await enableCodeReviewerMutation.mutateAsync({
        organizationId,
        platform: connectedPlatform,
        isEnabled: true,
      });
      const result = await checklistQuery.refetch();
      const completed =
        result.data?.steps.find(step => step.key === 'code-reviewer')?.done ?? false;
      if (completed) {
        toast.success('Code Reviewer is on', {
          description: 'Balanced defaults are active for GitHub repositories.',
        });
        navigate('invite-team');
      } else {
        const message = 'Code Reviewer was enabled, but setup status has not updated yet.';
        setStatusMessage(message);
        toast.error(message);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not turn on Code Reviewer. Try again.';
      setStatusMessage(message);
      toast.error('Could not turn on Code Reviewer', { description: message });
    }
  };

  const handleInvitationSuccess = async () => {
    const result = await checklistQuery.refetch();
    const completed = result.data?.steps.find(step => step.key === 'invite-team')?.done ?? false;
    if (completed) {
      setStatusMessage('Team invitation sent.');
      navigate('complete');
    }
  };

  if (checklistQuery.isLoading) {
    return (
      <WizardShell>
        <div className="flex min-h-72 items-center justify-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          Checking organization setup…
        </div>
      </WizardShell>
    );
  }

  if (checklistQuery.isError || !checklistQuery.data) {
    return (
      <WizardShell>
        <Alert variant="destructive">
          <AlertTitle>Could not check organization setup</AlertTitle>
          <AlertDescription>
            <p>{checklistQuery.error?.message ?? 'Try loading the setup checklist again.'}</p>
            <Button variant="outline" size="sm" onClick={() => void checklistQuery.refetch()}>
              <RefreshCw className="size-4" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </WizardShell>
    );
  }

  const checklist = checklistQuery.data;
  const progressLabel = `${checklist.completedCount} of ${checklist.totalCount} complete`;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 py-4 md:py-8">
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="gap-4 border-b border-border pb-5">
          <div className="flex items-end justify-between gap-4">
            <div className="space-y-1">
              <p className="type-eyebrow text-muted-foreground">Onboarding progress</p>
              <p className="type-body text-muted-foreground">
                Complete these steps to prepare your organization.
              </p>
            </div>
            <div className="text-right">
              <p className="type-heading tabular-nums">
                {checklist.completedCount}/{checklist.totalCount}
              </p>
              <p className="type-label text-muted-foreground">steps complete</p>
            </div>
          </div>
          <div
            role="progressbar"
            aria-label={progressLabel}
            aria-valuemin={0}
            aria-valuemax={checklist.totalCount}
            aria-valuenow={checklist.completedCount}
            className="h-2 overflow-hidden rounded-full bg-surface-inset"
          >
            <div
              className="h-full rounded-full bg-primary transition-transform duration-200 motion-reduce:transition-none"
              style={{
                transform: `translateX(-${100 - (checklist.completedCount / checklist.totalCount) * 100}%)`,
              }}
            />
          </div>
          {checklistQuery.isFetching && !checklistQuery.isLoading && (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-icon-sm animate-spin motion-reduce:animate-none" />
              Checking setup…
            </span>
          )}
        </CardHeader>

        <div className="grid md:grid-cols-[18rem_minmax(0,1fr)]">
          <SetupNavigation
            currentScreen={currentScreen}
            stepState={stepState}
            visitedSteps={visitedSteps}
            onNavigate={navigate}
          />

          <CardContent className="min-w-0 p-4 sm:p-6 md:border-l md:border-border lg:p-8">
            {statusMessage && (
              <p className="sr-only" aria-live="polite">
                {statusMessage}
              </p>
            )}
            <AnimatePresence mode="wait" initial={false}>
              <motion.section
                key={currentScreen}
                initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: prefersReducedMotion ? 0 : -8 }}
                transition={{
                  duration: prefersReducedMotion ? 0 : 0.22,
                  ease: [0.23, 1, 0.32, 1],
                }}
                aria-labelledby={`setup-${currentScreen}-title`}
                className="flex min-h-[32rem] flex-col"
              >
                {currentScreen === 'complete' ? (
                  <CompletionScreen
                    headingRef={headingRef}
                    completedCount={checklist.completedCount}
                    totalCount={checklist.totalCount}
                    organizationId={organizationId}
                    balanceMicrodollars={organizationSummaryQuery.data?.balanceMicrodollars ?? 0}
                    organizationLoading={organizationSummaryQuery.isLoading}
                    userRole={userRole}
                    recommendationsDigestEnabled={
                      organizationSummaryQuery.data?.recommendationsDigestEnabled ?? false
                    }
                    onBack={() => navigate('invite-team')}
                  />
                ) : (
                  <StepScreen
                    headingRef={headingRef}
                    step={currentScreen}
                    done={stepState.get(currentScreen) ?? false}
                    organizationId={organizationId}
                    previous={getPreviousOnboardingScreen(currentScreen)}
                    onBack={navigate}
                    showGitHubSetup={showGitHubSetup}
                    onShowGitHubSetup={() => setShowGitHubSetup(true)}
                    onUseGitLab={() => navigate('invite-team')}
                    onGitHubDetected={() => void handleGitHubDetected()}
                    connectedPlatform={checklist.connectedPlatform}
                    codeReviewerPending={enableCodeReviewerMutation.isPending}
                    onEnableCodeReviewer={() => void handleEnableCodeReviewer()}
                    onContinue={() => navigate(getNextOnboardingScreen(currentScreen))}
                    onInvite={() => setInviteOpen(true)}
                  />
                )}
              </motion.section>
            </AnimatePresence>
          </CardContent>
        </div>
      </Card>

      <InviteMemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        organizationId={organizationId}
        onMemberInvited={() => void handleInvitationSuccess()}
      />
    </div>
  );
}

function WizardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl py-4 md:py-8">
      <Card>
        <CardContent className="p-6">{children}</CardContent>
      </Card>
    </div>
  );
}

function SetupNavigation({
  currentScreen,
  stepState,
  visitedSteps,
  onNavigate,
}: {
  currentScreen: OrganizationOnboardingScreen;
  stepState: Map<OrganizationOnboardingStepKey, boolean>;
  visitedSteps: Set<OrganizationOnboardingStepKey>;
  onNavigate: (screen: OrganizationOnboardingScreen) => void;
}) {
  return (
    <nav aria-label="Organization setup" className="bg-surface-inset p-3 sm:p-4 md:p-3">
      <ol className="grid gap-2 sm:grid-cols-3 md:grid-cols-1">
        {STEP_KEYS.map((key, index) => {
          const content = STEP_CONTENT[key];
          const Icon = content.icon;
          const done = stepState.get(key) ?? false;
          const active = currentScreen === key;
          const visited = visitedSteps.has(key);
          return (
            <li key={key}>
              <button
                type="button"
                aria-current={active ? 'step' : undefined}
                onClick={() => onNavigate(key)}
                className={cn(
                  'flex min-h-control-touch w-full items-start gap-3 rounded-lg border border-transparent p-3 text-left transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  active && 'border-border-strong bg-surface-selected',
                  !active && 'hover:bg-surface-hover',
                  done && !active && 'text-muted-foreground',
                  visited && !done && !active && 'bg-surface-raised'
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-background text-muted-foreground',
                    active && 'border-border-strong text-foreground',
                    done && 'text-status-success-icon'
                  )}
                  aria-hidden="true"
                >
                  {done ? <Check className="size-4" /> : <Icon className="size-4" />}
                </span>
                <span className="min-w-0 space-y-1">
                  <span className="type-eyebrow block text-muted-foreground">Step {index + 1}</span>
                  <span className="type-body block font-medium text-foreground">
                    {content.title}
                  </span>
                  <span className="type-label hidden text-muted-foreground lg:block">
                    {content.description}
                  </span>
                  {done && <span className="sr-only">, done</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepScreen({
  headingRef,
  step,
  done,
  organizationId,
  previous,
  showGitHubSetup,
  onBack,
  onShowGitHubSetup,
  onUseGitLab,
  onGitHubDetected,
  connectedPlatform,
  codeReviewerPending,
  onEnableCodeReviewer,
  onContinue,
  onInvite,
}: {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  step: OrganizationOnboardingStepKey;
  done: boolean;
  organizationId: string;
  previous: OrganizationOnboardingScreen | null;
  showGitHubSetup: boolean;
  onBack: (screen: OrganizationOnboardingScreen) => void;
  onShowGitHubSetup: () => void;
  onUseGitLab: () => void;
  onGitHubDetected: () => void;
  connectedPlatform: 'github' | null;
  codeReviewerPending: boolean;
  onEnableCodeReviewer: () => void;
  onContinue: () => void;
  onInvite: () => void;
}) {
  const content = STEP_CONTENT[step];
  const Icon = content.icon;
  const returnTo = buildOrganizationWelcomePath(organizationId, step);

  return (
    <>
      <div className="flex flex-1 flex-col">
        <div className="flex items-start justify-between gap-4 border-b border-border pb-6">
          <div className="flex items-start gap-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-inset">
              <Icon className="size-5 text-muted-foreground" />
            </div>
            <div className="space-y-2">
              <p className="type-eyebrow text-muted-foreground">
                Step {STEP_KEYS.indexOf(step) + 1} of {STEP_KEYS.length}
              </p>
              <h1
                ref={headingRef}
                tabIndex={-1}
                id={`setup-${step}-title`}
                className="type-title focus:outline-none"
              >
                {content.title}
              </h1>
              <p className="type-body max-w-2xl text-muted-foreground">{content.description}</p>
              <a
                href={content.docsHref}
                target="_blank"
                rel="noopener noreferrer"
                className="type-label inline-flex min-h-8 items-center gap-2 rounded-md text-link underline-offset-4 hover:text-link-hover hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <BookOpen className="size-4" />
                {content.docsLabel}
                <ExternalLink className="size-icon-sm" />
              </a>
            </div>
          </div>
          {done && (
            <span className="type-label flex shrink-0 items-center gap-1 rounded-full border border-status-success-border bg-status-success-surface px-2 py-1 text-status-success">
              <Check className="size-icon-sm text-status-success-icon" />
              Done
            </span>
          )}
        </div>

        <div className="flex-1 py-6">
          <div className="min-w-0">
            {step === 'source-control' && showGitHubSetup && !done ? (
              <GitHubIntegrationDetails
                organizationId={organizationId}
                appReturnPath={returnTo}
                onInstallationDetected={onGitHubDetected}
              />
            ) : (
              <div className="flex min-h-56 flex-col justify-between rounded-xl border border-border bg-surface-background p-6">
                <div className="space-y-3">
                  <h2 className="type-heading">
                    {done ? `${content.title} is complete` : content.actionLabel}
                  </h2>
                  <p className="type-body max-w-xl text-muted-foreground">
                    {done
                      ? 'Kilo detected this setup in your organization. Continue when you are ready.'
                      : content.helpText}
                  </p>
                </div>

                <div className="mt-8">
                  {done ? (
                    <Button onClick={onContinue} className="min-h-control-touch sm:min-h-0">
                      Continue setup
                      <ArrowRight className="size-4" />
                    </Button>
                  ) : step === 'invite-team' ? (
                    <Button onClick={onInvite} className="min-h-control-touch sm:min-h-0">
                      <Users className="size-4" />
                      {content.actionLabel}
                    </Button>
                  ) : step === 'source-control' ? (
                    <div className="space-y-4">
                      <div className="rounded-lg border border-status-info-border bg-status-info-surface p-4">
                        <p className="type-label text-status-info">
                          Guided setup currently supports GitHub. GitLab remains available from
                          Integrations after onboarding.
                        </p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <button
                          type="button"
                          onClick={onShowGitHubSetup}
                          className="flex min-h-24 items-center gap-4 rounded-lg border border-border bg-surface-inset p-4 text-left transition-colors hover:border-border-strong hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          <span className="flex size-10 items-center justify-center rounded-md border border-border bg-surface-raised">
                            <Github className="size-5" />
                          </span>
                          <span>
                            <span className="type-heading block">Continue with GitHub</span>
                            <span className="type-label text-muted-foreground">
                              Connect GitHub and enable Code Reviewer
                            </span>
                          </span>
                          <ArrowRight className="ml-auto size-4 text-muted-foreground" />
                        </button>
                        <button
                          type="button"
                          onClick={onUseGitLab}
                          className="flex min-h-24 items-center gap-4 rounded-lg border border-border bg-surface-inset p-4 text-left transition-colors hover:border-border-strong hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          <span className="flex size-10 items-center justify-center rounded-md border border-border bg-surface-raised">
                            <GitBranch className="size-5" />
                          </span>
                          <span>
                            <span className="type-heading block">I use GitLab</span>
                            <span className="type-label text-muted-foreground">
                              Skip GitHub-specific setup for now
                            </span>
                          </span>
                          <ArrowRight className="ml-auto size-4 text-muted-foreground" />
                        </button>
                      </div>
                    </div>
                  ) : connectedPlatform ? (
                    <Button
                      onClick={onEnableCodeReviewer}
                      disabled={codeReviewerPending}
                      className="min-h-control-touch sm:min-h-0"
                    >
                      {codeReviewerPending ? (
                        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                      ) : (
                        <CodeXml className="size-4" />
                      )}
                      {codeReviewerPending ? 'Turning on…' : 'Turn on Code Reviewer'}
                    </Button>
                  ) : (
                    <div className="flex flex-col items-start gap-3">
                      <p className="type-label text-status-warning">
                        Code Reviewer guided setup needs a connected GitHub integration.
                      </p>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => onBack('source-control')}
                        className="min-h-control-touch sm:min-h-0"
                      >
                        <GitBranch className="size-4" />
                        Connect source control
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-10 flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          {previous && (
            <Button
              variant="ghost"
              onClick={() => onBack(previous)}
              className="min-h-control-touch sm:min-h-0"
            >
              <ArrowLeft className="size-4" />
              Back
            </Button>
          )}
          {!done && (
            <Button
              variant="secondary"
              onClick={onContinue}
              className="min-h-control-touch sm:min-h-0"
            >
              Skip for now
            </Button>
          )}
        </div>
        <Button asChild variant="ghost" className="min-h-control-touch sm:min-h-0">
          <Link href={`/organizations/${organizationId}`}>Finish later</Link>
        </Button>
      </div>
    </>
  );
}

function CompletionScreen({
  headingRef,
  completedCount,
  totalCount,
  organizationId,
  balanceMicrodollars,
  organizationLoading,
  userRole,
  recommendationsDigestEnabled,
  onBack,
}: {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  completedCount: number;
  totalCount: number;
  organizationId: string;
  balanceMicrodollars: number;
  organizationLoading: boolean;
  userRole: OrganizationRole;
  recommendationsDigestEnabled: boolean;
  onBack: () => void;
}) {
  const complete = completedCount === totalCount;
  const hasCredits = balanceMicrodollars > 0;
  const canManageBilling = canManageOrganizationBilling(userRole);
  const returnPath = buildOrganizationWelcomePath(organizationId, 'complete');
  const topUpPath = `/payments/topup?${new URLSearchParams({
    amount: '10',
    'organization-id': organizationId,
    'cancel-path': returnPath,
  })}`;

  return (
    <>
      <div className="flex flex-1 flex-col">
        <div className="flex items-start gap-4 border-b border-border pb-6">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-status-success-border bg-status-success-surface text-status-success-icon">
            {complete ? <Check className="size-5" /> : <Circle className="size-5" />}
          </div>
          <div className="space-y-2">
            <p className="type-eyebrow text-muted-foreground">Setup summary</p>
            <h1
              ref={headingRef}
              tabIndex={-1}
              id="setup-complete-title"
              className="type-title focus:outline-none"
            >
              {complete ? 'Your organization is ready' : 'Finish setup when you’re ready'}
            </h1>
            <p className="type-body max-w-2xl text-muted-foreground">
              You completed{' '}
              <span className="tabular-nums">
                {completedCount} of {totalCount}
              </span>{' '}
              setup tasks. Choose how your team should start using Kilo.
            </p>
          </div>
        </div>

        <div className="space-y-6 py-6">
          <section aria-labelledby="configured-title" className="space-y-3">
            <h2 id="configured-title" className="type-heading">
              Configured for you
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <SetupStatus
                icon={Mail}
                title="Weekly recommendations"
                detail={recommendationsDigestEnabled ? 'Enabled' : 'Not enabled'}
              />
              <SetupStatus icon={Route} title="Auto routing" detail="Best accuracy per dollar" />
            </div>
          </section>

          <section aria-labelledby="start-title" className="space-y-3">
            <div>
              <h2 id="start-title" className="type-heading">
                {hasCredits ? 'Start a cloud workflow' : 'Start coding for free'}
              </h2>
              <p className="type-body mt-1 text-muted-foreground">
                {hasCredits
                  ? 'Your organization has usage credits, so paid models and Cloud Agent are ready.'
                  : 'Your organization has no usage credits yet. Auto Free, local tools, and BYOK remain available.'}
              </p>
            </div>

            {organizationLoading ? (
              <div className="flex min-h-32 items-center justify-center rounded-xl border border-border bg-surface-inset">
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              </div>
            ) : hasCredits ? (
              <div className="rounded-xl border border-border bg-surface-background p-6">
                <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
                  <div className="space-y-2">
                    <Cloud className="size-5 text-muted-foreground" />
                    <h3 className="type-heading">Run your first Cloud Agent</h3>
                    <p className="type-body max-w-xl text-muted-foreground">
                      Ask Kilo to review a repository, improve its README, or explain its
                      architecture.
                    </p>
                  </div>
                  <Button asChild className="min-h-control-touch shrink-0 sm:min-h-0">
                    <Link href={`/organizations/${organizationId}/cloud`}>Start Cloud Agent</Link>
                  </Button>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-border bg-surface-background p-6">
                <div className="space-y-2">
                  <h3 className="type-heading">Install Kilo Code</h3>
                  <p className="type-body text-muted-foreground">
                    Use Auto Free from your editor or terminal without adding Kilo credits.
                  </p>
                </div>
                <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <OpenInExtensionButton
                    ideName="VS Code"
                    source="vscode"
                    className="min-h-control-touch sm:min-h-0"
                  >
                    <Image src="/logos/vscode.svg" alt="" width={16} height={16} />
                    Install for VS Code
                  </OpenInExtensionButton>
                  <Button asChild variant="outline" className="min-h-control-touch sm:min-h-0">
                    <a
                      href="https://plugins.jetbrains.com/plugin/28350-kilo-code"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Image src="/logos/idea.svg" alt="" width={16} height={16} />
                      Install for JetBrains
                    </a>
                  </Button>
                  <Button asChild variant="outline" className="min-h-control-touch sm:min-h-0">
                    <a href="https://kilo.ai/install#cli" target="_blank" rel="noopener noreferrer">
                      <Terminal className="size-4" />
                      Install CLI
                    </a>
                  </Button>
                </div>
              </div>
            )}
          </section>

          {!hasCredits && !organizationLoading && (
            <section aria-labelledby="unlock-title" className="space-y-3">
              <h2 id="unlock-title" className="type-heading">
                Unlock paid workflows
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <ChoiceCard
                  icon={Coins}
                  title="Add $10 in credits"
                  description="Unlock Auto Balanced, paid models, Cloud Agent, Security Agent analysis, and remediation."
                  actionLabel="Add $10"
                  href={canManageBilling ? topUpPath : undefined}
                  disabled={!canManageBilling}
                />
                <ChoiceCard
                  icon={Key}
                  title="Use your provider key"
                  description="Use supported models through organization BYOK. Your provider bills the usage."
                  actionLabel="Configure BYOK"
                  href={canManageBilling ? `/organizations/${organizationId}/byok` : undefined}
                  disabled={!canManageBilling}
                />
              </div>
            </section>
          )}

          <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:flex-wrap">
            <Button asChild className="min-h-control-touch sm:min-h-0">
              <Link href={`/organizations/${organizationId}`}>Open organization</Link>
            </Button>
            <Button asChild className="min-h-control-touch sm:min-h-0">
              <a href="mailto:sales@kilocode.ai">Contact sales</a>
            </Button>
          </div>
        </div>
      </div>
      <div className="border-t border-border pt-5">
        <Button variant="ghost" onClick={onBack} className="min-h-control-touch sm:min-h-0">
          <ArrowLeft className="size-4" />
          Back
        </Button>
      </div>
    </>
  );
}

function SetupStatus({
  icon: Icon,
  title,
  detail,
  children,
}: {
  icon: typeof Mail;
  title: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-20 items-center gap-3 rounded-lg border border-border bg-surface-inset p-4">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="type-body font-medium">{title}</p>
        <p className="type-label truncate text-muted-foreground">{detail}</p>
      </div>
      {children}
    </div>
  );
}

function ChoiceCard({
  icon: Icon,
  title,
  description,
  actionLabel,
  disabled = false,
  href,
}: {
  icon: typeof Mail;
  title: string;
  description: string;
  actionLabel: string;
  disabled?: boolean;
  href?: string;
}) {
  const action = href ? (
    <Button asChild variant="outline" size="sm" className="mt-auto w-full">
      <Link href={href}>{actionLabel}</Link>
    </Button>
  ) : (
    <Button type="button" variant="outline" size="sm" className="mt-auto w-full" disabled>
      {actionLabel}
    </Button>
  );

  return (
    <div
      className={cn(
        'flex min-h-56 flex-col rounded-xl border border-border bg-surface-background p-5',
        disabled && 'opacity-60'
      )}
    >
      <div className="flex size-8 items-center justify-center rounded-md border border-border bg-surface-inset">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <h3 className="type-heading mt-4">{title}</h3>
      <p className="type-body mt-2 flex-1 text-muted-foreground">{description}</p>
      {action}
    </div>
  );
}
