'use client';

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRefreshRepositories } from '@/hooks/useRefreshRepositories';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/Button';
import { Button as UIButton } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTRPC, useRawTRPCClient } from '@/lib/trpc/utils';
import { useRouter } from 'next/navigation';
import { AlertCircle, ExternalLink, Loader2, RefreshCw, Rocket, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { PageLayout } from '@/components/PageLayout';
import { DemoSessionCTA } from './DemoSessionCTA';
import { DemoSessionModal } from './DemoSessionModal';
import {
  DEMO_CONFIGS,
  DEMO_SOURCE_REPO,
  DEMO_SOURCE_REPO_NAME,
  templatePrompt,
  type DemoConfig,
} from './demo-config';
import type { AgentMode } from './types';
import { useProfile, useProfiles, useCombinedProfiles } from '@/hooks/useCloudAgentProfiles';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  manualEnvVarsAtom,
  manualSetupCommandsAtom,
  selectedProfileIdAtom,
  hasAutoSelectedDefaultAtom,
  profileConfigAtom,
  effectiveEnvVarsAtom,
  effectiveSetupCommandsAtom,
  resetSessionFormAtom,
} from './store/session-form-atoms';
import { useOrganizationWithMembers, useOrganizationDefaults } from '@/app/api/organizations/hooks';
import { useOpenRouterModels } from '@/app/api/openrouter/hooks';
import {
  RepositoryCombobox,
  type RepositoryOption,
  type RepositoryPlatform,
} from '@/components/shared/RepositoryCombobox';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { InsufficientBalanceBanner } from '@/components/shared/InsufficientBalanceBanner';
import { AdvancedConfig } from '@/components/shared/AdvancedConfig';
import { cn } from '@/lib/utils';
import { MODES } from './ResumeConfigModal';

type CloudSessionsPageProps = {
  organizationId?: string;
};

type Repository = {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
};

export function CloudSessionsPage({ organizationId }: CloudSessionsPageProps) {
  const router = useRouter();
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();

  // Fetch eligibility to check if user can use Cloud Agent
  // Use separate queries for personal vs org context to ensure correct balance is checked
  const personalEligibilityQuery = useQuery({
    ...trpc.cloudAgent.checkEligibility.queryOptions(),
    enabled: !organizationId,
  });
  const orgEligibilityQuery = useQuery({
    ...trpc.organizations.cloudAgent.checkEligibility.queryOptions({
      organizationId: organizationId || '',
    }),
    enabled: !!organizationId,
  });
  const eligibilityData = organizationId ? orgEligibilityQuery.data : personalEligibilityQuery.data;
  const isEligibilityLoading = organizationId
    ? orgEligibilityQuery.isPending
    : personalEligibilityQuery.isPending;
  const hasInsufficientBalance =
    !isEligibilityLoading && eligibilityData && !eligibilityData.isEligible;

  // Fetch organization configuration and models
  const { data: organizationData } = useOrganizationWithMembers(organizationId || '', {
    enabled: !!organizationId,
  });
  const { data: modelsData } = useOpenRouterModels();
  const { data: defaultsData } = useOrganizationDefaults(organizationId);

  // Get organization's allowed models
  const savedModelAllowList = organizationData?.settings?.model_allow_list || [];
  const allModels = modelsData?.data || [];

  // Filter models based on organization's allow list (memoized to avoid prompt re-render churn)
  const availableModels = useMemo(() => {
    return savedModelAllowList.length === 0
      ? allModels
      : allModels.filter(model => savedModelAllowList.includes(model.id));
  }, [allModels, savedModelAllowList]);

  // Format models for the combobox (ModelOption format: id, name)
  const modelOptions = useMemo<ModelOption[]>(
    () => availableModels.map(model => ({ id: model.id, name: model.name })),
    [availableModels]
  );

  // Form state (non-profile related)
  const [prompt, setPrompt] = useState('');
  const [selectedRepo, setSelectedRepo] = useState('');
  const [selectedPlatform, setSelectedPlatform] = useState<RepositoryPlatform>('github');
  const [mode, setMode] = useState<AgentMode>('build');
  const [model, setModel] = useState<string>('');
  const [isModelUserSelected, setIsModelUserSelected] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);

  // Demo session state
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [showDemoModal, setShowDemoModal] = useState(false);
  const [selectedDemo, setSelectedDemo] = useState<DemoConfig | null>(null);
  const [isDemoActionLoading, setIsDemoActionLoading] = useState(false);
  const [highlightedDemoId, setHighlightedDemoId] = useState<string | null>(null);

  // Session form atoms (profile/env/commands)
  const [manualEnvVars, setManualEnvVars] = useAtom(manualEnvVarsAtom);
  const [manualSetupCommands, setManualSetupCommands] = useAtom(manualSetupCommandsAtom);
  const [selectedProfileId, setSelectedProfileId] = useAtom(selectedProfileIdAtom);
  const [hasAutoSelectedDefault, setHasAutoSelectedDefault] = useAtom(hasAutoSelectedDefaultAtom);
  const setProfileConfig = useSetAtom(profileConfigAtom);
  const effectiveEnvVars = useAtomValue(effectiveEnvVarsAtom);
  const effectiveSetupCommands = useAtomValue(effectiveSetupCommandsAtom);
  const resetSessionForm = useSetAtom(resetSessionFormAtom);

  // Clear any lingering manual overrides whenever the page loads
  useEffect(() => {
    resetSessionForm();
  }, [resetSessionForm]);

  // Parse URL hash to highlight demo if present
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const hash = window.location.hash;
      if (hash.startsWith('#demo-')) {
        const demoId = hash.slice(6); // Remove '#demo-' prefix
        setHighlightedDemoId(demoId);
      }
    }
  }, []);

  // Set or reset model when defaults change (organization switch or initial load)
  useEffect(() => {
    // If no models are available, clear the selection to prevent invalid submissions
    if (modelOptions.length === 0) {
      if (model) {
        setModel('');
        setIsModelUserSelected(false);
      }
      return;
    }

    // If current model is not in the available models list, or if we don't have a model yet,
    // reset to an allowed model
    const isCurrentModelAvailable = modelOptions.some(m => m.id === model);
    if (!isCurrentModelAvailable || !model || !isModelUserSelected) {
      // Prefer the default model if it's in the allow list, otherwise use the first available
      const defaultModel = defaultsData?.defaultModel;
      const isDefaultAllowed = defaultModel && modelOptions.some(m => m.id === defaultModel);
      const newModel = isDefaultAllowed ? defaultModel : modelOptions[0]?.id;

      if (newModel && newModel !== model) {
        setModel(newModel);
        setIsModelUserSelected(false); // Auto-selected, not user-selected
      }
    }
  }, [defaultsData?.defaultModel, modelOptions, model, isModelUserSelected]);

  // Fetch profiles list to find default profile
  // In org context, use combined profiles to get both org and personal profiles
  const { data: combinedProfilesData } = useCombinedProfiles({
    organizationId: organizationId ?? '',
    enabled: !!organizationId,
  });
  const { data: personalProfiles } = useProfiles({
    organizationId: undefined,
    enabled: !organizationId,
  });

  // Get all profiles and effective default based on context
  const allProfiles = organizationId
    ? [
        ...(combinedProfilesData?.orgProfiles ?? []),
        ...(combinedProfilesData?.personalProfiles ?? []),
      ]
    : (personalProfiles ?? []);
  const effectiveDefaultId = organizationId
    ? combinedProfilesData?.effectiveDefaultId
    : personalProfiles?.find(p => p.isDefault)?.id;

  // Auto-select effective default profile on initial load
  useEffect(() => {
    if (!hasAutoSelectedDefault && !selectedProfileId && effectiveDefaultId) {
      setSelectedProfileId(effectiveDefaultId);
      setHasAutoSelectedDefault(true);
    } else if (!hasAutoSelectedDefault && allProfiles.length > 0) {
      // Mark as auto-selected even if no default exists
      setHasAutoSelectedDefault(true);
    }
  }, [
    allProfiles.length,
    effectiveDefaultId,
    hasAutoSelectedDefault,
    selectedProfileId,
    setSelectedProfileId,
    setHasAutoSelectedDefault,
  ]);

  // If a profile is deleted from the list, clear the selection so derived counts reset
  useEffect(() => {
    if (!selectedProfileId || allProfiles.length === 0) {
      return;
    }
    const stillPresent = allProfiles.some(p => p.id === selectedProfileId);
    if (!stillPresent) {
      setSelectedProfileId(null);
      setProfileConfig(null);
    }
  }, [allProfiles, selectedProfileId, setProfileConfig, setSelectedProfileId]);

  // Fetch selected profile data
  const { data: selectedProfile } = useProfile(selectedProfileId || '', {
    organizationId,
    enabled: !!selectedProfileId,
  });

  // Update profile config atom when profile data is loaded
  useEffect(() => {
    if (selectedProfile) {
      setProfileConfig({
        vars: selectedProfile.vars.map(v => ({
          key: v.key,
          value: v.value,
          isSecret: v.isSecret,
        })),
        commands: selectedProfile.commands
          .sort((a, b) => a.sequence - b.sequence)
          .map(c => c.command),
      });
    } else {
      setProfileConfig(null);
    }
  }, [selectedProfile, setProfileConfig]);

  // Profile selection handler
  const handleProfileSelect = useCallback(
    (profileId: string | null) => {
      setSelectedProfileId(profileId);
    },
    [setSelectedProfileId]
  );

  // Fetch GitHub repositories
  const {
    data: githubRepoData,
    isLoading: isLoadingGitHubRepos,
    error: githubRepoError,
  } = useQuery(
    organizationId
      ? trpc.organizations.cloudAgent.listGitHubRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgent.listGitHubRepositories.queryOptions({
          forceRefresh: false,
        })
  );

  // Fetch GitLab repositories
  const {
    data: gitlabRepoData,
    isLoading: isLoadingGitLabRepos,
    error: gitlabRepoError,
  } = useQuery(
    organizationId
      ? trpc.organizations.cloudAgent.listGitLabRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgent.listGitLabRepositories.queryOptions({
          forceRefresh: false,
        })
  );

  // Combined loading state - only show loading if both are loading
  const isLoadingRepos = isLoadingGitHubRepos && isLoadingGitLabRepos;

  // Refresh repositories hook (refreshes both GitHub and GitLab)
  const { refresh: refreshGitHubRepositories, isRefreshing: isRefreshingGitHubRepos } =
    useRefreshRepositories({
      getRefreshQueryOptions: useCallback(
        () =>
          organizationId
            ? trpc.organizations.cloudAgent.listGitHubRepositories.queryOptions({
                organizationId,
                forceRefresh: true,
              })
            : trpc.cloudAgent.listGitHubRepositories.queryOptions({
                forceRefresh: true,
              }),
        [organizationId, trpc]
      ),
      getCacheQueryKey: useCallback(
        () =>
          organizationId
            ? trpc.organizations.cloudAgent.listGitHubRepositories.queryKey({
                organizationId,
                forceRefresh: false,
              })
            : trpc.cloudAgent.listGitHubRepositories.queryKey({
                forceRefresh: false,
              }),
        [organizationId, trpc]
      ),
    });

  const { refresh: refreshGitLabRepositories, isRefreshing: isRefreshingGitLabRepos } =
    useRefreshRepositories({
      getRefreshQueryOptions: useCallback(
        () =>
          organizationId
            ? trpc.organizations.cloudAgent.listGitLabRepositories.queryOptions({
                organizationId,
                forceRefresh: true,
              })
            : trpc.cloudAgent.listGitLabRepositories.queryOptions({
                forceRefresh: true,
              }),
        [organizationId, trpc]
      ),
      getCacheQueryKey: useCallback(
        () =>
          organizationId
            ? trpc.organizations.cloudAgent.listGitLabRepositories.queryKey({
                organizationId,
                forceRefresh: false,
              })
            : trpc.cloudAgent.listGitLabRepositories.queryKey({
                forceRefresh: false,
              }),
        [organizationId, trpc]
      ),
    });

  // Combined refresh function
  const refreshRepositories = useCallback(async () => {
    await Promise.all([refreshGitHubRepositories(), refreshGitLabRepositories()]);
  }, [refreshGitHubRepositories, refreshGitLabRepositories]);

  const isRefreshingRepos = isRefreshingGitHubRepos || isRefreshingGitLabRepos;

  // Get repositories from both platforms
  const githubRepositories = (githubRepoData?.repositories || []) as Repository[];
  const gitlabRepositories = (gitlabRepoData?.repositories || []) as Repository[];

  // Combine repositories with platform tags
  const unifiedRepositories = useMemo<RepositoryOption[]>(() => {
    const github = githubRepositories.map(repo => ({
      id: repo.id,
      fullName: repo.fullName,
      private: repo.private,
      platform: 'github' as const,
    }));
    const gitlab = gitlabRepositories.map(repo => ({
      id: repo.id,
      fullName: repo.fullName,
      private: repo.private,
      platform: 'gitlab' as const,
    }));
    return [...github, ...gitlab];
  }, [githubRepositories, gitlabRepositories]);

  // Determine if grouping is needed (both platforms have repositories)
  const hasMultiplePlatforms = githubRepositories.length > 0 && gitlabRepositories.length > 0;

  // Handle repository selection - track platform based on selected repo
  const handleRepoSelect = useCallback(
    (repoFullName: string) => {
      setSelectedRepo(repoFullName);
      const repo = unifiedRepositories.find(r => r.fullName === repoFullName);
      if (repo?.platform) {
        setSelectedPlatform(repo.platform);
      }
    },
    [unifiedRepositories]
  );

  // Get the most recent sync time from either platform
  const syncedAt = githubRepoData?.syncedAt || gitlabRepoData?.syncedAt;

  // Combine errors - show first error if any
  const repoError = githubRepoError || gitlabRepoError;

  // Check if demo repo fork exists in the repositories list (GitHub only for demo)
  const demoForkInRepos = useMemo(() => {
    if (organizationId) return null; // Demo only for personal users

    // Look for a repo that ends with the demo repo name (e.g., username/KiloMan)
    const forkRepo = githubRepositories.find(repo =>
      repo.fullName.endsWith(`/${DEMO_SOURCE_REPO_NAME}`)
    );

    return forkRepo
      ? { exists: true, forkedRepo: forkRepo.fullName }
      : { exists: false, forkedRepo: null };
  }, [githubRepositories, organizationId]);

  const handleStartSession = useCallback(async () => {
    if (!prompt.trim() || !selectedRepo) {
      return;
    }

    setIsPreparing(true);

    try {
      // Call prepareSession to create DB entry and cloud-agent DO
      // If a profile is selected, pass the profile name so the backend
      // can resolve encrypted secrets from the profile
      // Build the base input without the repo field
      const baseInput = {
        prompt: prompt.trim(),
        mode,
        model,
        envVars: Object.keys(manualEnvVars).length > 0 ? manualEnvVars : undefined,
        setupCommands: manualSetupCommands.length > 0 ? manualSetupCommands : undefined,
        profileName: selectedProfile?.name,
        autoCommit: true,
      };

      let result: { kiloSessionId: string; cloudAgentSessionId: string };

      // Use cloudAgentNext endpoints with new modes ('plan' | 'build')
      if (organizationId) {
        // Organization context - use org-scoped endpoint
        // Use the correct field based on selected platform
        if (selectedPlatform === 'gitlab') {
          result = await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
            ...baseInput,
            gitlabProject: selectedRepo,
            organizationId,
          });
        } else {
          result = await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
            ...baseInput,
            githubRepo: selectedRepo,
            organizationId,
          });
        }
      } else {
        // Personal context
        // Use the correct field based on selected platform
        if (selectedPlatform === 'gitlab') {
          result = await trpcClient.cloudAgentNext.prepareSession.mutate({
            ...baseInput,
            gitlabProject: selectedRepo,
          });
        } else {
          result = await trpcClient.cloudAgentNext.prepareSession.mutate({
            ...baseInput,
            githubRepo: selectedRepo,
          });
        }
      }

      // Invalidate the sessions list cache so the sidebar shows the new session
      void queryClient.invalidateQueries({
        queryKey: trpc.cliSessions.list.queryKey({
          limit: 3,
          createdOnPlatform: 'cloud-agent',
          orderBy: 'updated_at',
          organizationId: organizationId ?? null,
        }),
      });

      // Navigate to chat page with sessionId (use cloud-next routes)
      const basePath = organizationId
        ? `/organizations/${organizationId}/cloud-next`
        : '/cloud-next';
      router.push(`${basePath}/chat?sessionId=${result.kiloSessionId}`);
    } catch (error) {
      console.error('Failed to prepare session:', error);
      toast.error('Failed to create session. Please try again.');
    } finally {
      setIsPreparing(false);
    }
  }, [
    manualEnvVars,
    manualSetupCommands,
    model,
    mode,
    organizationId,
    prompt,
    queryClient,
    router,
    selectedPlatform,
    selectedRepo,
    selectedProfile,
    trpc.cliSessions.list,
    trpcClient,
  ]);

  // Handle demo card click - either show modal or populate form
  const handleDemoClick = useCallback(
    async (demo: DemoConfig) => {
      if (organizationId) return; // Demo is only for personal users

      setSelectedDemo(demo);

      if (demoForkInRepos?.exists && demoForkInRepos.forkedRepo) {
        const repoOwner = demoForkInRepos.forkedRepo.split('/')[0];
        const templatedPrompt = repoOwner ? templatePrompt(demo.prompt, repoOwner) : demo.prompt;

        setPrompt(templatedPrompt);
        setSelectedRepo(demoForkInRepos.forkedRepo);
        setModel(demo.model);
        setIsModelUserSelected(true);
        setMode(demo.mode);
        setIsDemoMode(true);

        // Scroll to the form
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        // Not forked - open GitHub fork page and show modal
        window.open(`https://github.com/${DEMO_SOURCE_REPO}/fork`, '_blank');
        setShowDemoModal(true);
      }
    },
    [organizationId, demoForkInRepos]
  );

  // Handle "Done. Let's Go!" button in modal
  const handleModalComplete = useCallback(async () => {
    if (!selectedDemo) return;

    setIsDemoActionLoading(true);

    try {
      const maxAttempts = 10;
      const delayMs = 1000;

      const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

      const pollForDemoFork = async () => {
        let forkCheck: {
          exists: boolean;
          forkedRepo: string | null;
          githubUsername: string | null;
        } | null = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          forkCheck = await trpcClient.cloudAgent.checkDemoRepositoryFork.query();

          if (forkCheck.exists && forkCheck.forkedRepo) {
            return forkCheck;
          }

          if (attempt < maxAttempts - 1) {
            await sleep(delayMs);
          }
        }

        return forkCheck;
      };

      const forkCheck = await pollForDemoFork();

      if (!forkCheck?.exists || !forkCheck.forkedRepo) {
        toast.error(
          'Fork not detected. Please make sure you forked the repository on GitHub and try again.'
        );
        return;
      }

      // Refresh repositories to include the fork in the dropdown
      await refreshRepositories();

      // Close modal
      setShowDemoModal(false);

      // Template the prompt with GitHub username if available
      const templatedPrompt = forkCheck.githubUsername
        ? templatePrompt(selectedDemo.prompt, forkCheck.githubUsername)
        : selectedDemo.prompt;

      // Populate the form with demo data
      setPrompt(templatedPrompt);
      setSelectedRepo(forkCheck.forkedRepo);
      setModel(selectedDemo.model);
      setIsModelUserSelected(true);
      setMode(selectedDemo.mode);
      setIsDemoMode(true);

      // Scroll to the form
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      console.error('Failed to check for fork:', error);
      toast.error('Failed to check for fork. Please try again.');
    } finally {
      setIsDemoActionLoading(false);
    }
  }, [selectedDemo, refreshRepositories, trpcClient]);

  const isFormValid =
    prompt.trim().length > 0 &&
    selectedRepo.length > 0 &&
    model.length > 0 &&
    !isPreparing &&
    !hasInsufficientBalance;

  const titleContent = (
    <div className="flex items-center gap-3">
      <h1 className="text-foreground text-3xl font-bold">Cloud Agent</h1>
      <Badge variant="new">new</Badge>
    </div>
  );

  const subtitleContent = (
    <p className="text-muted-foreground">
      Start a new cloud agent session{' '}
      <a
        href="https://kilo.ai/docs/advanced-usage/cloud-agent"
        className="inline-flex items-center gap-1 text-blue-400 underline hover:text-blue-300"
      >
        Learn more
        <ExternalLink className="h-3 w-3" />
      </a>
    </p>
  );

  // Check if NEITHER platform has an integration installed
  // Show the banner only if both platforms report integrationInstalled === false
  const githubIntegrationMissing =
    !isLoadingGitHubRepos && githubRepoData?.integrationInstalled === false;
  const gitlabIntegrationMissing =
    !isLoadingGitLabRepos && gitlabRepoData?.integrationInstalled === false;
  const isIntegrationMissing = githubIntegrationMissing && gitlabIntegrationMissing;

  const content = (
    <>
      {/* Insufficient Balance Banner */}
      {hasInsufficientBalance && eligibilityData && (
        <div className="mb-6">
          <InsufficientBalanceBanner
            balance={eligibilityData.balance}
            content={{ type: 'productName', productName: 'Cloud Agent' }}
          />
        </div>
      )}

      {/* New Session Form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            Start New Session
          </CardTitle>
          <CardDescription>
            Configure and launch a cloud agent to work on your repository
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Prompt */}
          <PromptField value={prompt} onChange={setPrompt} />

          {/* Repository Selector */}
          <RepositorySelector
            repositories={unifiedRepositories}
            value={selectedRepo}
            onChange={handleRepoSelect}
            isLoading={isLoadingRepos}
            error={repoError ? repoError.message : undefined}
            syncedAt={syncedAt}
            onRefresh={refreshRepositories}
            isRefreshing={isRefreshingRepos}
            groupByPlatform={hasMultiplePlatforms}
          />

          {/* Mode and Model Row */}
          <ModeModelRow
            mode={mode}
            model={model}
            onModeChange={setMode}
            onModelChange={newModel => {
              setModel(newModel);
              setIsModelUserSelected(true);
            }}
            modelOptions={modelOptions}
            isLoadingModels={!modelsData}
          />

          {/* Advanced Configuration */}
          <AdvancedConfig
            organizationId={organizationId}
            selectedProfileId={selectedProfileId}
            onProfileSelect={handleProfileSelect}
            manualEnvVars={manualEnvVars}
            manualSetupCommands={manualSetupCommands}
            effectiveEnvVars={effectiveEnvVars}
            effectiveSetupCommands={effectiveSetupCommands}
            onManualEnvVarsChange={setManualEnvVars}
            onManualSetupCommandsChange={setManualSetupCommands}
          />

          {/* Submit Button */}
          <SubmitButton
            onClick={handleStartSession}
            disabled={!isFormValid}
            isLoading={isPreparing}
            isDemoMode={isDemoMode}
          />
        </CardContent>
      </Card>

      {/* Demo CTAs - Only for personal users */}
      {!organizationId && (
        <div className="space-y-4">
          {isLoadingRepos
            ? // Show loading skeletons while loading repositories
              DEMO_CONFIGS.map(demo => (
                <Card key={demo.id} className="border-muted-foreground/25 border-2 border-dashed">
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex flex-1 items-center gap-3">
                        <Sparkles className="h-5 w-5 text-yellow-500" />
                        <div className="flex-1 space-y-2">
                          <div className="bg-muted h-5 w-48 animate-pulse rounded" />
                          <div className="bg-muted h-4 w-96 animate-pulse rounded" />
                        </div>
                      </div>
                      <div className="bg-muted h-10 w-32 animate-pulse rounded" />
                    </div>
                  </CardContent>
                </Card>
              ))
            : DEMO_CONFIGS.map(demo => (
                <DemoSessionCTA
                  key={demo.id}
                  demo={demo}
                  onAction={() => handleDemoClick(demo)}
                  isForked={demoForkInRepos?.exists ?? false}
                  isWaitingForFork={
                    showDemoModal && selectedDemo?.id === demo.id && isDemoActionLoading
                  }
                  isHighlighted={highlightedDemoId === demo.id}
                />
              ))}
        </div>
      )}

      {/* Demo Fork Instructions Modal */}
      <DemoSessionModal
        open={showDemoModal}
        onOpenChange={setShowDemoModal}
        onComplete={handleModalComplete}
        isLoading={isDemoActionLoading}
        demo={selectedDemo}
      />
    </>
  );

  if (isIntegrationMissing) {
    const integrationsPath = organizationId
      ? `/organizations/${organizationId}/integrations`
      : '/integrations';
    const integrationMessage =
      githubRepoData?.errorMessage ||
      gitlabRepoData?.errorMessage ||
      'Connect a GitHub or GitLab integration to select a repository for the cloud agent.';

    const integrationContent = (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-amber-400" />
            Connect GitHub or GitLab to start a session
          </CardTitle>
          <CardDescription>{integrationMessage}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <p className="text-sm text-gray-300">
            We need access to your repositories to launch cloud agent sessions. Install the GitHub
            or GitLab integration to continue.
          </p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href={integrationsPath} variant="primary" size="md">
              Open integrations
            </LinkButton>
            <Button variant="secondary" size="md" onClick={() => router.refresh()}>
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>
    );

    // When in organization context, skip PageLayout (OrganizationTrialWrapper provides PageContainer)
    if (organizationId) {
      return (
        <>
          <div className="flex items-start justify-between">
            <div className="flex flex-col gap-2">
              {titleContent}
              {subtitleContent}
            </div>
          </div>
          {integrationContent}
        </>
      );
    }

    return (
      <PageLayout title={titleContent} subtitle={subtitleContent}>
        {integrationContent}
      </PageLayout>
    );
  }

  // When in organization context, skip PageLayout (OrganizationTrialWrapper provides PageContainer)
  if (organizationId) {
    return (
      <>
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-2">
            {titleContent}
            {subtitleContent}
          </div>
        </div>
        {content}
      </>
    );
  }

  return (
    <PageLayout title={titleContent} subtitle={subtitleContent}>
      {content}
    </PageLayout>
  );
}

type PromptFieldProps = {
  value: string;
  onChange: (value: string) => void;
};

const PromptField = memo(function PromptField({ value, onChange }: PromptFieldProps) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
    },
    [onChange]
  );

  return (
    <div className="space-y-2">
      <Label htmlFor="prompt">Task Description</Label>
      <Textarea
        id="prompt"
        value={value}
        onChange={handleChange}
        placeholder="Describe your task..."
        rows={3}
        className="resize-y"
      />
      <p className="text-xs text-gray-400">Describe what you want the cloud agent to do</p>
    </div>
  );
});

type RepositorySelectorProps = {
  repositories: RepositoryOption[];
  value: string;
  onChange: (value: string) => void;
  isLoading: boolean;
  error?: string;
  syncedAt?: string | null;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  groupByPlatform?: boolean;
};

const RepositorySelector = memo(function RepositorySelector({
  repositories,
  value,
  onChange,
  isLoading,
  error,
  syncedAt,
  onRefresh,
  isRefreshing,
  groupByPlatform,
}: RepositorySelectorProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Repository</Label>
        {onRefresh && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">
              Last synced:{' '}
              {syncedAt ? formatDistanceToNow(new Date(syncedAt), { addSuffix: true }) : 'Never'}
            </span>
            <UIButton
              type="button"
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
            </UIButton>
          </div>
        )}
      </div>
      <RepositoryCombobox
        repositories={repositories}
        value={value}
        onValueChange={onChange}
        isLoading={isLoading}
        error={error}
        helperText="Select a repository to work on"
        placeholder="Select a repository"
        emptyStateText="No repositories found"
        hideLabel
        groupByPlatform={groupByPlatform}
      />
    </div>
  );
});

type ModeModelRowProps = {
  mode: AgentMode;
  model: string;
  onModeChange: (value: AgentMode) => void;
  onModelChange: (value: string) => void;
  modelOptions: ModelOption[];
  isLoadingModels: boolean;
};

const ModeModelRow = memo(function ModeModelRow({
  mode,
  model,
  onModeChange,
  onModelChange,
  modelOptions,
  isLoadingModels,
}: ModeModelRowProps) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor="mode">Mode</Label>
        <Select value={mode} onValueChange={value => onModeChange(value as AgentMode)}>
          <SelectTrigger id="mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map(m => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ModelCombobox
        label="Model"
        models={modelOptions}
        value={model}
        onValueChange={onModelChange}
        isLoading={isLoadingModels}
        required
      />
    </div>
  );
});

type SubmitButtonProps = {
  onClick: () => void;
  disabled: boolean;
  isLoading?: boolean;
  isDemoMode?: boolean;
};

const SubmitButton = memo(function SubmitButton({
  onClick,
  disabled,
  isLoading,
  isDemoMode = false,
}: SubmitButtonProps) {
  return (
    <div className="pt-2">
      <Button
        onClick={onClick}
        disabled={disabled}
        variant="primary"
        size="lg"
        className={cn(
          'w-full transition-all duration-500 ease-in-out md:w-auto',
          isDemoMode &&
            'animate-pulse-once bg-[oklch(95%_0.15_108)] text-black shadow-[0_0_20px_rgba(237,255,0,0.3)] ring-[oklch(95%_0.15_108)]/20 hover:bg-[oklch(95%_0.15_108)]/90 hover:ring-[oklch(95%_0.15_108)]/40'
        )}
      >
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Creating Session...
          </>
        ) : isDemoMode ? (
          <>
            <Rocket className="mr-2 h-4 w-4" />
            Engage Kilo Speed
          </>
        ) : (
          <>
            <Sparkles className="mr-2 h-4 w-4" />
            Start Session
          </>
        )}
      </Button>
    </div>
  );
});
