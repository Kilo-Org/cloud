/**
 * Migrate to GitHub Dialog
 *
 * Multi-step modal that guides users through exporting their App Builder project
 * to a GitHub repository using the user-created repository approach.
 *
 * Steps:
 * 1. Create Repository - Instructions to create empty repo on GitHub
 * 2. Grant Access - Instructions to grant GitHub App access (if using selective repo access)
 * 3. Select Repository - Searchable list of accessible repos
 * 4. Success - Link to GitHub repo
 */

'use client';

import { useState, useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Github,
  Loader2,
  AlertCircle,
  ExternalLink,
  Check,
  ChevronRight,
  ChevronLeft,
  RefreshCw,
} from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import { RepositoryCombobox, type RepositoryOption } from '@/components/shared/RepositoryCombobox';
import type { CanMigrateToGitHubResult, MigrateToGitHubErrorCode } from '@/lib/app-builder/types';

type MigrateToGitHubDialogProps = {
  projectId: string;
  organizationId?: string;
  disabled?: boolean;
  /** Called after migration completes successfully, with the GitHub repo full name */
  onMigrationComplete?: (repoFullName: string) => void;
};

type Step = 'create' | 'grant-access' | 'select' | 'success';

const errorMessages: Record<MigrateToGitHubErrorCode, string> = {
  github_app_not_installed: 'GitHub App is not installed. Please install the GitHub App first.',
  already_migrated: 'This project has already been migrated to GitHub.',
  repo_not_found:
    "Repository not found or not accessible. Make sure you've granted the Kilo GitHub App access to this repository.",
  repo_not_empty:
    'Repository is not empty. Please use an empty repository (no commits, no README).',
  push_failed: 'Failed to push code to GitHub. Please try again.',
  project_not_found: 'Project not found.',
  internal_error: 'An unexpected error occurred. Please try again.',
};

export function MigrateToGitHubDialog({
  projectId,
  organizationId,
  disabled,
  onMigrationComplete,
}: MigrateToGitHubDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<Step>('create');
  const [selectedRepo, setSelectedRepo] = useState<string>('');

  const [migrationResult, setMigrationResult] = useState<{
    success: true;
    githubRepoUrl: string;
  } | null>(null);
  const [migrationError, setMigrationError] = useState<MigrateToGitHubErrorCode | null>(null);

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Pre-flight check queries for personal/org context
  const personalCanMigrateQuery = useQuery({
    ...trpc.appBuilder.canMigrateToGitHub.queryOptions({ projectId }),
    enabled: isOpen && !organizationId,
  });

  const orgCanMigrateQuery = useQuery({
    ...trpc.organizations.appBuilder.canMigrateToGitHub.queryOptions({
      projectId,
      organizationId: organizationId || '',
    }),
    enabled: isOpen && !!organizationId,
  });

  const canMigrateQuery = organizationId ? orgCanMigrateQuery : personalCanMigrateQuery;
  const canMigrateData: CanMigrateToGitHubResult | undefined = canMigrateQuery.data;

  // Migration mutations for personal/org context
  const handleMigrationSuccess = useCallback(
    (
      data:
        | { success: true; githubRepoUrl: string; newSessionId: string }
        | { success: false; error: MigrateToGitHubErrorCode }
    ) => {
      if (data.success) {
        setMigrationResult(data);
        setMigrationError(null);
        setStep('success');
        onMigrationComplete?.(selectedRepo);
      } else {
        setMigrationError(data.error);
      }
    },
    [onMigrationComplete, selectedRepo]
  );

  const {
    mutate: personalMigrate,
    isPending: personalIsPending,
    reset: personalReset,
  } = useMutation(
    trpc.appBuilder.migrateToGitHub.mutationOptions({
      onSuccess: handleMigrationSuccess,
      onError: () => {
        setMigrationError('internal_error');
      },
    })
  );

  const {
    mutate: orgMigrate,
    isPending: orgIsPending,
    reset: orgReset,
  } = useMutation(
    trpc.organizations.appBuilder.migrateToGitHub.mutationOptions({
      onSuccess: handleMigrationSuccess,
      onError: () => {
        setMigrationError('internal_error');
      },
    })
  );

  const isPending = organizationId ? orgIsPending : personalIsPending;
  const reset = organizationId ? orgReset : personalReset;

  // Map available repos to RepositoryCombobox format
  const repositoryOptions: RepositoryOption[] = useMemo(
    () =>
      (canMigrateData?.availableRepos ?? []).map(repo => ({
        id: repo.fullName,
        fullName: repo.fullName,
        private: repo.isPrivate,
        platform: 'github' as const,
      })),
    [canMigrateData?.availableRepos]
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (!open) {
        // Reset state when closing
        setStep('create');
        setSelectedRepo('');
        setMigrationResult(null);
        setMigrationError(null);
        reset();
      }
    },
    [reset]
  );

  const handleRefreshRepos = useCallback(() => {
    if (organizationId) {
      void queryClient.invalidateQueries({
        queryKey: trpc.organizations.appBuilder.canMigrateToGitHub.queryKey({
          projectId,
          organizationId,
        }),
      });
    } else {
      void queryClient.invalidateQueries({
        queryKey: trpc.appBuilder.canMigrateToGitHub.queryKey({ projectId }),
      });
    }
  }, [organizationId, queryClient, trpc, projectId]);

  const handleMigrate = useCallback(() => {
    if (!selectedRepo) return;

    setMigrationError(null);

    if (organizationId) {
      orgMigrate({ projectId, organizationId, repoFullName: selectedRepo });
    } else {
      personalMigrate({ projectId, repoFullName: selectedRepo });
    }
  }, [organizationId, orgMigrate, personalMigrate, projectId, selectedRepo]);

  // Skip grant-access step if user has "all repositories" access
  const needsGrantAccess = canMigrateData?.repositorySelection === 'selected';

  const handleNext = useCallback(() => {
    if (step === 'create') {
      // Skip grant-access step if user has access to all repos
      setStep(needsGrantAccess ? 'grant-access' : 'select');
    } else if (step === 'grant-access') {
      setStep('select');
    }
  }, [step, needsGrantAccess]);

  const handleBack = useCallback(() => {
    if (step === 'grant-access') {
      setStep('create');
    } else if (step === 'select') {
      // Go back to grant-access only if needed, otherwise go to create
      setStep(needsGrantAccess ? 'grant-access' : 'create');
    }
  }, [step, needsGrantAccess]);

  // Determine if migration is possible
  const canMigrate = canMigrateData?.hasGitHubIntegration && !canMigrateData?.alreadyMigrated;

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          title="Migrate to GitHub"
          className="gap-2"
        >
          <Github className="h-4 w-4" />
          <span className="hidden sm:inline">Migrate to GitHub</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Migrate to GitHub</DialogTitle>
          <DialogDescription>
            {step === 'create' && 'Step 1: Create an empty repository on GitHub'}
            {step === 'grant-access' && 'Step 2: Grant access to your repository'}
            {step === 'select' && `Step ${needsGrantAccess ? '3' : '2'}: Select your repository`}
            {step === 'success' && 'Migration complete!'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Loading state */}
          {canMigrateQuery.isPending && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
              <span className="text-muted-foreground ml-2 text-sm">Loading...</span>
            </div>
          )}

          {/* Query error */}
          {canMigrateQuery.error && (
            <div className="flex items-start gap-3 rounded-md bg-red-500/10 p-4 text-sm text-red-400">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Failed to check migration eligibility. Please try again.</span>
            </div>
          )}

          {/* Migration not available - no GitHub integration */}
          {canMigrateData && !canMigrateData.hasGitHubIntegration && (
            <div className="flex items-start gap-3 rounded-md bg-yellow-500/10 p-4 text-sm text-yellow-400">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">GitHub App not installed</p>
                <p className="text-muted-foreground mt-1">
                  Install the Kilo GitHub App to export your project to GitHub.
                </p>
              </div>
            </div>
          )}

          {/* Already migrated */}
          {canMigrateData?.alreadyMigrated && (
            <div className="flex items-start gap-3 rounded-md bg-blue-500/10 p-4 text-sm text-blue-400">
              <Check className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Already exported</p>
                <p className="text-muted-foreground mt-1">
                  This project has already been exported to GitHub.
                </p>
              </div>
            </div>
          )}

          {/* Step 1: Create Repository */}
          {canMigrate && step === 'create' && (
            <div className="space-y-4">
              <div className="rounded-md border p-4">
                <h4 className="font-medium">Create an empty repository</h4>
                <p className="text-muted-foreground mt-1 text-sm">
                  Create a new repository on GitHub. Make sure to:
                </p>
                <ul className="text-muted-foreground mt-2 list-inside list-disc space-y-1 text-sm">
                  <li>
                    <strong>Don&apos;t</strong> initialize with a README
                  </li>
                  <li>
                    <strong>Don&apos;t</strong> add a .gitignore or license
                  </li>
                  <li>The repository must be completely empty</li>
                </ul>
                {canMigrateData.suggestedRepoName && (
                  <p className="text-muted-foreground mt-2 text-sm">
                    Suggested name:{' '}
                    <code className="bg-muted rounded px-1">
                      {canMigrateData.suggestedRepoName}
                    </code>
                  </p>
                )}
              </div>

              <Button asChild className="w-full gap-2">
                <a href={canMigrateData.newRepoUrl} target="_blank" rel="noopener noreferrer">
                  <Github className="h-4 w-4" />
                  Create Repository on GitHub
                  <ExternalLink className="h-3 w-3" />
                </a>
              </Button>
            </div>
          )}

          {/* Step 2: Grant Access */}
          {canMigrate && step === 'grant-access' && (
            <div className="space-y-4">
              <div className="rounded-md border p-4">
                <h4 className="font-medium">Grant repository access</h4>
                <p className="text-muted-foreground mt-1 text-sm">
                  If you use <strong>selective repository access</strong> for the Kilo GitHub App,
                  you need to grant access to your new repository.
                </p>
                <p className="text-muted-foreground mt-2 text-sm">
                  If you granted access to <strong>all repositories</strong>, you can skip this
                  step.
                </p>
              </div>

              {canMigrateData.installationSettingsUrl && (
                <Button asChild variant="outline" className="w-full gap-2">
                  <a
                    href={canMigrateData.installationSettingsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Github className="h-4 w-4" />
                    Open GitHub App Settings
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </Button>
              )}
            </div>
          )}

          {/* Step 3: Select Repository */}
          {canMigrate && step === 'select' && (
            <div className="space-y-4">
              {/* Migration error */}
              {migrationError && (
                <div className="flex items-start gap-3 rounded-md bg-red-500/10 p-4 text-sm text-red-400">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{errorMessages[migrationError]}</span>
                </div>
              )}

              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <RepositoryCombobox
                    label="Repository"
                    helperText="Select the empty repository you created"
                    repositories={repositoryOptions}
                    value={selectedRepo}
                    onValueChange={setSelectedRepo}
                    isLoading={canMigrateQuery.isFetching}
                    placeholder="Select a repository"
                    searchPlaceholder="Search repositories..."
                    noResultsText="No repositories match your search"
                    emptyStateText="No repositories found. Create one on GitHub first."
                    hideLabel={false}
                    required={false}
                  />
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleRefreshRepos}
                  disabled={canMigrateQuery.isFetching || isPending}
                  title="Refresh repository list"
                  className="mb-6 shrink-0"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${canMigrateQuery.isFetching ? 'animate-spin' : ''}`}
                  />
                </Button>
              </div>
            </div>
          )}

          {/* Step 4: Success */}
          {step === 'success' && migrationResult && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-md bg-green-500/10 p-4 text-sm text-green-400">
                <Check className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">Export successful!</p>
                  <p className="text-muted-foreground mt-1">
                    Your project has been exported to GitHub. You can now clone, push, and
                    collaborate using Git.
                  </p>
                </div>
              </div>
              <Button asChild className="w-full">
                <a
                  href={migrationResult.githubRepoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gap-2"
                >
                  <Github className="h-4 w-4" />
                  View on GitHub
                  <ExternalLink className="h-3 w-3" />
                </a>
              </Button>
            </div>
          )}
        </div>

        {/* Footer with navigation */}
        {canMigrate && step !== 'success' && (
          <DialogFooter className="flex-row justify-between sm:justify-between">
            {step !== 'create' ? (
              <Button variant="ghost" onClick={handleBack} disabled={isPending}>
                <ChevronLeft className="mr-1 h-4 w-4" />
                Back
              </Button>
            ) : (
              <div /> // Spacer
            )}

            {step === 'select' ? (
              <Button
                onClick={handleMigrate}
                disabled={isPending || !selectedRepo}
                className="gap-2"
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Exporting...
                  </>
                ) : (
                  <>
                    <Github className="h-4 w-4" />
                    Export
                  </>
                )}
              </Button>
            ) : (
              <Button onClick={handleNext} className="gap-1">
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
