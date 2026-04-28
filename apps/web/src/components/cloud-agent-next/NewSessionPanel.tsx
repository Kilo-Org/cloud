'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { toast } from 'sonner';
import {
  AlertCircle,
  FolderGit2,
  Loader2,
  Lock,
  RefreshCw,
  Send,
  Settings,
  Unlock,
  Check,
  Paperclip,
  Upload,
} from 'lucide-react';
import { startOfDay, subDays } from 'date-fns';
import { useTRPC, useRawTRPCClient } from '@/lib/trpc/utils';
import { SetPageTitle } from '@/components/SetPageTitle';
import { Badge } from '@/components/ui/badge';
import { MobileSidebarToggle } from './MobileSidebarToggle';
import { MobileToolbarPopover } from './MobileToolbarPopover';

import {
  useProfile,
  useProfiles,
  useCombinedProfiles,
  useRepoBindings,
} from '@/hooks/useCloudAgentProfiles';
import { useRefreshRepositories } from '@/hooks/useRefreshRepositories';
import { useOrganizationDefaults } from '@/app/api/organizations/hooks';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import {
  manualEnvVarsAtom,
  manualSetupCommandsAtom,
  selectedProfileIdAtom,
  hasAutoSelectedDefaultAtom,
  profileConfigAtom,
  effectiveEnvVarsAtom,
  effectiveSetupCommandsAtom,
  resetSessionFormAtom,
} from '@/components/cloud-agent/store/session-form-atoms';
import {
  type RepositoryOption,
  type RepositoryPlatform,
} from '@/components/shared/RepositoryCombobox';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { ModeCombobox, NEXT_MODE_OPTIONS } from '@/components/shared/ModeCombobox';
import { VariantCombobox } from '@/components/shared/VariantCombobox';
import { InsufficientBalanceBanner } from '@/components/shared/InsufficientBalanceBanner';
import { AdvancedConfig } from '@/components/shared/AdvancedConfig';
import {
  buildProfileConfigIndicatorState,
  ProfileConfigIndicator,
} from '@/components/cloud-agent/ProfileConfigIndicator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Button as UIButton } from '@/components/ui/button';
import { LinkButton } from '@/components/Button';
import { cn } from '@/lib/utils';
import {
  extractRepoFromGitUrl,
  findAllGitPlatformUrls,
  detectGitPlatform,
} from '@/components/cloud-agent-next/utils/git-utils';
import type { AgentMode } from './types';
import { generateMessageId } from '@/lib/cloud-agent-sdk/message-id';
import { useImageUpload } from '@/hooks/useImageUpload';
import { ImagePreviewStrip } from '@/components/shared/ImagePreviewStrip';
import {
  CLOUD_AGENT_IMAGE_ALLOWED_TYPES,
  CLOUD_AGENT_IMAGE_MAX_COUNT,
  CLOUD_AGENT_IMAGE_MAX_DIMENSION_PX,
  CLOUD_AGENT_IMAGE_MAX_ORIGINAL_SIZE_BYTES,
  CLOUD_AGENT_IMAGE_MAX_SIZE_BYTES,
  CLOUD_AGENT_PROMPT_MAX_LENGTH,
} from '@/lib/cloud-agent/constants';

type Repository = {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
};

type NewSessionPanelProps = {
  organizationId?: string;
};

export function NewSessionPanel({ organizationId }: NewSessionPanelProps) {
  const router = useRouter();
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { mutateAsync: personalUploadUrl } = useMutation(
    trpc.cloudAgentNext.getImageUploadUrl.mutationOptions()
  );
  const { mutateAsync: orgUploadUrl } = useMutation(
    trpc.organizations.cloudAgentNext.getImageUploadUrl.mutationOptions()
  );

  // ---------------------------------------------------------------------------
  // Eligibility
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------
  const { data: modelsData } = useModelSelectorList(organizationId);
  const { data: defaultsData } = useOrganizationDefaults(organizationId);

  const allModels = modelsData?.data || [];

  const modelOptions = useMemo<ModelOption[]>(
    () =>
      allModels.map(model => ({
        id: model.id,
        name: model.name,
        variants: model.opencode?.variants ? Object.keys(model.opencode.variants) : undefined,
      })),
    [allModels]
  );

  // ---------------------------------------------------------------------------
  // Form state
  // ---------------------------------------------------------------------------
  const [prompt, setPrompt] = useState('');
  const [selectedRepo, setSelectedRepo] = useState('');
  const [selectedPlatform, setSelectedPlatform] = useState<RepositoryPlatform>('github');
  const [mode, setMode] = useState<AgentMode>('code');
  const [model, setModel] = useState<string>('');
  const [variant, setVariant] = useState<string | undefined>(undefined);
  const [isModelUserSelected, setIsModelUserSelected] = useState(false);
  const [isRepoUserSelected, setIsRepoUserSelected] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [imageMessageUuid, setImageMessageUuid] = useState(() => crypto.randomUUID());

  const imageUpload = useImageUpload({
    messageUuid: imageMessageUuid,
    organizationId,
    maxImages: CLOUD_AGENT_IMAGE_MAX_COUNT,
    maxOriginalFileSizeBytes: CLOUD_AGENT_IMAGE_MAX_ORIGINAL_SIZE_BYTES,
    maxFileSizeBytes: CLOUD_AGENT_IMAGE_MAX_SIZE_BYTES,
    allowedTypes: CLOUD_AGENT_IMAGE_ALLOWED_TYPES,
    resizeImages: { maxDimensionPx: CLOUD_AGENT_IMAGE_MAX_DIMENSION_PX },
    getUploadUrl: {
      personal: personalUploadUrl,
      organization: orgUploadUrl,
    },
  });
  const isImageLimitReached = imageUpload.images.length >= CLOUD_AGENT_IMAGE_MAX_COUNT;

  // ---------------------------------------------------------------------------
  // Session form atoms (profile / env / commands)
  // ---------------------------------------------------------------------------
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

  const availableVariants = modelOptions.find(m => m.id === model)?.variants ?? [];

  // ---------------------------------------------------------------------------
  // Model auto-selection
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (modelOptions.length === 0) {
      if (model) {
        setModel('');
        setIsModelUserSelected(false);
      }
      return;
    }

    const isCurrentModelAvailable = modelOptions.some(m => m.id === model);
    if (!isCurrentModelAvailable || !model || !isModelUserSelected) {
      const defaultModel = defaultsData?.defaultModel;
      const isDefaultAllowed = defaultModel && modelOptions.some(m => m.id === defaultModel);
      const newModel = isDefaultAllowed ? defaultModel : modelOptions[0]?.id;

      if (newModel && newModel !== model) {
        setModel(newModel);
        setIsModelUserSelected(false);
        // Default variant to first available variant (typically "none") for the new model
        const newVariants = modelOptions.find(m => m.id === newModel)?.variants ?? [];
        setVariant(newVariants[0]);
      }
    }
  }, [defaultsData?.defaultModel, modelOptions, model, isModelUserSelected]);

  // ---------------------------------------------------------------------------
  // Profiles
  // ---------------------------------------------------------------------------
  const {
    data: combinedProfilesData,
    isLoading: isLoadingCombinedProfiles,
    error: combinedProfilesError,
  } = useCombinedProfiles({
    organizationId: organizationId ?? '',
    enabled: !!organizationId,
  });
  const {
    data: personalProfiles,
    isLoading: isLoadingPersonalProfiles,
    error: personalProfilesError,
  } = useProfiles({
    organizationId: undefined,
    enabled: !organizationId,
  });

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

  // If a profile is deleted from the list, clear the selection
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

  const selectedProfileSummary = selectedProfileId
    ? allProfiles.find(profile => profile.id === selectedProfileId)
    : undefined;

  const { data: repoBindings, error: repoBindingsError } = useRepoBindings({
    organizationId,
    enabled: !!selectedRepo,
  });

  const repoBoundProfileName = useMemo(() => {
    if (!selectedRepo || !repoBindings) return null;
    const binding = repoBindings.find(
      repoBinding =>
        repoBinding.repoFullName.toLowerCase() === selectedRepo.toLowerCase() &&
        repoBinding.platform === selectedPlatform
    );
    return binding?.profileName ?? null;
  }, [repoBindings, selectedPlatform, selectedRepo]);

  const isProfilesLoading = organizationId ? isLoadingCombinedProfiles : isLoadingPersonalProfiles;
  const profilesError = organizationId ? combinedProfilesError : personalProfilesError;
  const profileIndicatorState = buildProfileConfigIndicatorState({
    selectedProfileName: selectedProfileSummary?.name ?? null,
    repoBoundProfileName,
    hasManualEnvVars: Object.keys(manualEnvVars).length > 0,
    hasManualSetupCommands: manualSetupCommands.length > 0,
    hasSelectedProfileId: !!selectedProfileId,
    isProfilesLoading,
    hasProfileError: !!profilesError,
    hasRepoBindingError: !!selectedRepo && !!repoBindingsError,
  });

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

  const handleProfileSelect = useCallback(
    (profileId: string | null) => {
      setSelectedProfileId(profileId);
    },
    [setSelectedProfileId]
  );

  // ---------------------------------------------------------------------------
  // Repositories (GitHub + GitLab)
  // ---------------------------------------------------------------------------
  const {
    data: githubRepoData,
    isLoading: isLoadingGitHubRepos,
    error: githubRepoError,
  } = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({
          forceRefresh: false,
        })
  );

  const {
    data: gitlabRepoData,
    isLoading: isLoadingGitLabRepos,
    error: gitlabRepoError,
  } = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitLabRepositories.queryOptions({
          forceRefresh: false,
        })
  );

  const repoUpdatedSince = useMemo(() => startOfDay(subDays(new Date(), 5)).toISOString(), []);
  const { data: recentRepoData } = useQuery(
    trpc.unifiedSessions.recentRepositories.queryOptions({
      organizationId: organizationId ?? null,
      updatedSince: repoUpdatedSince,
    })
  );

  const isLoadingRepos = isLoadingGitHubRepos && isLoadingGitLabRepos;

  const githubRepositories = (githubRepoData?.repositories || []) as Repository[];
  const gitlabRepositories = (gitlabRepoData?.repositories || []) as Repository[];

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

  const recentRepos = useMemo<RepositoryOption[]>(() => {
    const recentList = recentRepoData?.repositories;
    if (!recentList?.length || unifiedRepositories.length === 0) return [];

    const seen = new Set<string>();
    const result: RepositoryOption[] = [];

    for (const recent of recentList) {
      const fullName = extractRepoFromGitUrl(recent.gitUrl);
      if (!fullName || seen.has(fullName)) continue;
      seen.add(fullName);

      const match = unifiedRepositories.find(r => r.fullName === fullName);
      if (match) result.push(match);
    }

    return result;
  }, [recentRepoData?.repositories, unifiedRepositories]);

  const hasMultiplePlatforms = githubRepositories.length > 0 && gitlabRepositories.length > 0;

  const handleRepoSelect = useCallback(
    (repoFullName: string, userInitiated = true) => {
      setSelectedRepo(repoFullName);
      if (userInitiated) setIsRepoUserSelected(true);
      const repo = unifiedRepositories.find(r => r.fullName === repoFullName);
      if (repo?.platform) {
        setSelectedPlatform(repo.platform);
      }
    },
    [unifiedRepositories]
  );

  // ---------------------------------------------------------------------------
  // Auto-select repo from last session (most recently used)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (selectedRepo || isRepoUserSelected || recentRepos.length === 0) return;
    const firstRecent = recentRepos[0];
    if (!firstRecent) return;
    handleRepoSelect(firstRecent.fullName, false);
  }, [recentRepos, selectedRepo, isRepoUserSelected, handleRepoSelect]);

  // ---------------------------------------------------------------------------
  // Auto-select repo from pasted GitHub/GitLab URLs
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (isRepoUserSelected) return;

    for (const url of findAllGitPlatformUrls(prompt)) {
      const repoName = extractRepoFromGitUrl(url);
      if (!repoName) continue;

      const match = unifiedRepositories.find(
        r => r.fullName.toLowerCase() === repoName.toLowerCase()
      );
      if (!match) continue;

      setSelectedRepo(match.fullName);
      const platform = detectGitPlatform(url);
      if (platform) {
        setSelectedPlatform(platform);
      }
      break;
    }
  }, [prompt, isRepoUserSelected, unifiedRepositories]);

  const repoError = githubRepoError || gitlabRepoError;

  const { refresh: refreshGitHubRepositories, isRefreshing: isRefreshingGitHubRepos } =
    useRefreshRepositories({
      silent: true,
      getRefreshQueryOptions: useCallback(
        () =>
          organizationId
            ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
                organizationId,
                forceRefresh: true,
              })
            : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({
                forceRefresh: true,
              }),
        [organizationId, trpc]
      ),
      getCacheQueryKey: useCallback(
        () =>
          organizationId
            ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryKey({
                organizationId,
                forceRefresh: false,
              })
            : trpc.cloudAgentNext.listGitHubRepositories.queryKey({
                forceRefresh: false,
              }),
        [organizationId, trpc]
      ),
    });

  const { refresh: refreshGitLabRepositories, isRefreshing: isRefreshingGitLabRepos } =
    useRefreshRepositories({
      silent: true,
      getRefreshQueryOptions: useCallback(
        () =>
          organizationId
            ? trpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
                organizationId,
                forceRefresh: true,
              })
            : trpc.cloudAgentNext.listGitLabRepositories.queryOptions({
                forceRefresh: true,
              }),
        [organizationId, trpc]
      ),
      getCacheQueryKey: useCallback(
        () =>
          organizationId
            ? trpc.organizations.cloudAgentNext.listGitLabRepositories.queryKey({
                organizationId,
                forceRefresh: false,
              })
            : trpc.cloudAgentNext.listGitLabRepositories.queryKey({
                forceRefresh: false,
              }),
        [organizationId, trpc]
      ),
    });

  const refreshRepositories = useCallback(async () => {
    try {
      await Promise.all([refreshGitHubRepositories(), refreshGitLabRepositories()]);
      toast.success('Repositories refreshed');
    } catch (error) {
      toast.error('Failed to refresh repositories', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, [refreshGitHubRepositories, refreshGitLabRepositories]);

  const isRefreshingRepos = isRefreshingGitHubRepos || isRefreshingGitLabRepos;

  // ---------------------------------------------------------------------------
  // Integration missing check
  // ---------------------------------------------------------------------------
  const githubIntegrationMissing =
    !isLoadingGitHubRepos && githubRepoData?.integrationInstalled === false;
  const gitlabIntegrationMissing =
    !isLoadingGitLabRepos && gitlabRepoData?.integrationInstalled === false;
  const isIntegrationMissing = githubIntegrationMissing && gitlabIntegrationMissing;

  // ---------------------------------------------------------------------------
  // Repo popover state (must be declared before early returns to satisfy Rules of Hooks)
  // ---------------------------------------------------------------------------
  const [repoPopoverOpen, setRepoPopoverOpen] = useState(false);
  const [settingsPopoverOpen, setSettingsPopoverOpen] = useState(false);

  const recentFullNames = useMemo(() => new Set(recentRepos.map(r => r.fullName)), [recentRepos]);
  const githubRepos = unifiedRepositories.filter(
    r => r.platform === 'github' && !recentFullNames.has(r.fullName)
  );
  const gitlabRepos = unifiedRepositories.filter(
    r => r.platform === 'gitlab' && !recentFullNames.has(r.fullName)
  );
  const otherRepos = unifiedRepositories.filter(
    r => !r.platform && !recentFullNames.has(r.fullName)
  );
  const filteredUnifiedRepos = unifiedRepositories.filter(r => !recentFullNames.has(r.fullName));

  const handleRepoPillSelect = useCallback(
    (fullName: string) => {
      handleRepoSelect(fullName);
      setRepoPopoverOpen(false);
    },
    [handleRepoSelect]
  );

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------
  const isPromptTooLong = prompt.length > CLOUD_AGENT_PROMPT_MAX_LENGTH;

  const isFormValid =
    prompt.trim().length > 0 &&
    !isPromptTooLong &&
    model.length > 0 &&
    !isPreparing &&
    !hasInsufficientBalance &&
    !imageUpload.hasUploadingImages;

  const handleStartSession = useCallback(async () => {
    if (!prompt.trim() || imageUpload.hasUploadingImages) return;
    if (!selectedRepo) {
      toast.error('Please select a repository');
      return;
    }

    setIsPreparing(true);

    try {
      const initialMessageId = generateMessageId();
      const baseInput = {
        prompt: prompt.trim(),
        mode,
        model,
        variant,
        envVars: Object.keys(manualEnvVars).length > 0 ? manualEnvVars : undefined,
        setupCommands: manualSetupCommands.length > 0 ? manualSetupCommands : undefined,
        profileName: selectedProfile?.name,
        autoCommit: true,
        autoInitiate: true,
        initialMessageId,
        images: imageUpload.getImagesData(),
      };
      let result: { kiloSessionId: string; cloudAgentSessionId: string };

      if (organizationId) {
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

      void queryClient.invalidateQueries({
        queryKey: trpc.unifiedSessions.list.queryKey({
          limit: 3,
          createdOnPlatform: 'cloud-agent',
          orderBy: 'updated_at',
          organizationId: organizationId ?? null,
        }),
      });

      imageUpload.clearImages();
      setImageMessageUuid(crypto.randomUUID());

      const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
      router.push(`${basePath}/chat?sessionId=${result.kiloSessionId}`);
    } catch (error) {
      console.error('Failed to prepare session:', error);
      toast.error('Failed to create session. Please try again.');
    } finally {
      setIsPreparing(false);
    }
  }, [
    imageUpload,
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
    trpc.unifiedSessions.list,
    trpcClient,
    variant,
  ]);

  // ---------------------------------------------------------------------------
  // Textarea auto-resize
  // ---------------------------------------------------------------------------
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    // Cap at 50% of dynamic viewport height so the textarea never outgrows the
    // screen — `dvh` accounts for mobile virtual keyboards.
    const maxHeight = window.innerHeight * 0.5;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
  }, []);

  const handlePromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setPrompt(e.target.value);
      resizeTextarea();
    },
    [resizeTextarea]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData.items)
        .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
        .map(item => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (files.length > 0) {
        imageUpload.addFiles(files);
      }
    },
    [imageUpload]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (isFormValid) {
          void handleStartSession();
        }
      }
    },
    [isFormValid, handleStartSession]
  );

  // ---------------------------------------------------------------------------
  // Integration missing view
  // ---------------------------------------------------------------------------
  if (isIntegrationMissing) {
    const integrationsPath = organizationId
      ? `/organizations/${organizationId}/integrations`
      : '/integrations';
    const integrationMessage =
      githubRepoData?.errorMessage ||
      gitlabRepoData?.errorMessage ||
      'Connect a GitHub or GitLab integration to select a repository for the cloud agent.';

    return (
      <div className="relative flex h-full flex-col items-center justify-end p-4 pb-8">
        <SetPageTitle title="Cloud Agent">
          <Badge variant="new">new</Badge>
        </SetPageTitle>
        <MobileSidebarToggle />
        <div className="w-full max-w-2xl rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-6">
          <div className="mb-3 flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-amber-400" />
            <h2 className="text-lg font-semibold">Connect GitHub or GitLab to start a session</h2>
          </div>
          <p className="text-muted-foreground mb-4 text-sm">{integrationMessage}</p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href={integrationsPath} variant="primary" size="md">
              Open integrations
            </LinkButton>
            <UIButton variant="outline" onClick={() => router.refresh()}>
              Refresh
            </UIButton>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="relative flex h-full flex-col items-center px-4 pt-16">
      <SetPageTitle title="Cloud Agent">
        <Badge variant="new">new</Badge>
      </SetPageTitle>
      <MobileSidebarToggle />
      <div className="w-full max-w-2xl space-y-4">
        {/* Insufficient balance banner */}
        {hasInsufficientBalance && eligibilityData && (
          <InsufficientBalanceBanner
            balance={eligibilityData.balance}
            organizationId={organizationId}
            content={{ type: 'productName', productName: 'Cloud Agent' }}
          />
        )}

        {/* Textarea + model toolbar container */}
        <div
          className={cn(
            'relative overflow-hidden bg-muted/30 focus-within:ring-ring rounded-lg border focus-within:ring-2',
            isPreparing && 'pointer-events-none opacity-60',
            imageUpload.isDragging && 'border-transparent focus-within:ring-0'
          )}
          {...imageUpload.dragHandlers}
        >
          {imageUpload.isDragging && (
            <div
              className={cn(
                'absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed backdrop-blur-[2px]',
                isImageLimitReached
                  ? 'border-amber-500/60 bg-amber-500/10'
                  : 'border-primary/60 bg-primary/5'
              )}
            >
              <div
                className={cn(
                  'flex items-center gap-2 text-sm font-medium',
                  isImageLimitReached ? 'text-amber-400' : 'text-primary'
                )}
              >
                <Upload className="h-4 w-4" />
                {isImageLimitReached
                  ? `Maximum ${CLOUD_AGENT_IMAGE_MAX_COUNT} images attached`
                  : 'Drop images here'}
              </div>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={e => {
              if (e.target.files) {
                imageUpload.addFiles(e.target.files);
                e.target.value = '';
              }
            }}
          />
          <textarea
            ref={textareaRef}
            className="max-h-[50dvh] w-full resize-none overflow-y-auto border-0 bg-transparent p-4 pb-2 text-base focus:ring-0 focus:outline-none md:text-sm"
            placeholder="What would you like to do?"
            rows={5}
            value={prompt}
            onChange={handlePromptChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={isPreparing}
            maxLength={CLOUD_AGENT_PROMPT_MAX_LENGTH}
          />
          {prompt.length >= CLOUD_AGENT_PROMPT_MAX_LENGTH * 0.9 && (
            <p
              className={cn(
                'px-4 pb-1 text-xs',
                isPromptTooLong ? 'text-red-400' : 'text-muted-foreground'
              )}
            >
              {prompt.length.toLocaleString()} / {CLOUD_AGENT_PROMPT_MAX_LENGTH.toLocaleString()}{' '}
              characters
            </p>
          )}
          {imageUpload.images.length > 0 && (
            <div className="px-4 pb-1">
              <ImagePreviewStrip
                images={imageUpload.images}
                onRemove={imageUpload.removeImage}
                size="compact"
              />
            </div>
          )}
          <div className="flex min-w-0 items-center gap-2 px-3 py-1.5">
            {/* Mobile: single trigger that opens Mode + Model + Variant */}
            <MobileToolbarPopover
              mode={mode}
              onModeChange={setMode}
              model={model}
              modelOptions={modelOptions}
              onModelChange={newModel => {
                setModel(newModel);
                setIsModelUserSelected(true);
                const newVariants = modelOptions.find(m => m.id === newModel)?.variants ?? [];
                if (!variant || !newVariants.includes(variant)) {
                  setVariant(newVariants[0]);
                }
              }}
              isLoadingModels={!modelsData}
              variant={variant}
              availableVariants={availableVariants}
              onVariantChange={setVariant}
              disabled={isPreparing}
              className="md:hidden"
            />
            {/* Desktop: individual pickers */}
            <div className="hidden md:contents">
              <ModeCombobox<AgentMode>
                value={mode}
                onValueChange={setMode}
                options={NEXT_MODE_OPTIONS}
                variant="compact"
                disabled={isPreparing}
                className="min-w-0"
              />
              <ModelCombobox
                models={modelOptions}
                value={model}
                onValueChange={newModel => {
                  setModel(newModel);
                  setIsModelUserSelected(true);
                  const newVariants = modelOptions.find(m => m.id === newModel)?.variants ?? [];
                  if (!variant || !newVariants.includes(variant)) {
                    setVariant(newVariants[0]);
                  }
                }}
                isLoading={!modelsData}
                variant="compact"
                disabled={isPreparing}
                className="min-w-0"
              />
              {availableVariants.length > 0 && (
                <VariantCombobox
                  variants={availableVariants}
                  value={variant}
                  onValueChange={setVariant}
                  disabled={isPreparing}
                  className="min-w-0"
                />
              )}
            </div>

            <div className="flex-1" />

            {isPreparing && <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />}
            <UIButton
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={isPreparing}
              className="h-8 w-8 rounded-lg"
              title="Attach images"
            >
              <Paperclip className="h-4 w-4" />
            </UIButton>
            <UIButton
              type="button"
              variant="primary"
              size="icon"
              onClick={() => void handleStartSession()}
              disabled={!isFormValid || isPreparing || imageUpload.hasUploadingImages}
              className="h-8 w-8 rounded-lg"
            >
              <Send className="h-4 w-4" />
            </UIButton>
          </div>
        </div>

        {/* Repo + Settings row (outside prompt box) */}
        <div className="flex items-center justify-between">
          {/* Repo — bottom left */}
          <Popover open={repoPopoverOpen} onOpenChange={setRepoPopoverOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  'text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 text-sm',
                  selectedRepo && 'text-foreground'
                )}
                disabled={isPreparing}
              >
                <FolderGit2 className="h-3.5 w-3.5" />
                <span className="max-w-[16rem] truncate">{selectedRepo || 'Repository'}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-[min(20rem,calc(100vw-2rem))] p-0" align="start">
              {isLoadingRepos ? (
                <div className="text-muted-foreground p-4 text-center text-sm">
                  Loading repositories...
                </div>
              ) : repoError ? (
                <div className="p-4 text-center text-sm text-red-400">
                  Failed to load repositories
                </div>
              ) : unifiedRepositories.length === 0 ? (
                <div className="text-muted-foreground p-4 text-center text-sm">
                  No repositories found
                </div>
              ) : (
                <Command>
                  <div className="flex items-center border-b pr-2 [&_[cmdk-input-wrapper]]:flex-1 [&_[cmdk-input-wrapper]]:border-b-0">
                    <CommandInput placeholder="Search repositories..." />
                    <button
                      type="button"
                      onClick={() => void refreshRepositories()}
                      disabled={isRefreshingRepos}
                      className="text-muted-foreground hover:text-foreground shrink-0 rounded-sm p-1 disabled:opacity-50"
                      title="Refresh repositories"
                    >
                      <RefreshCw
                        className={cn('h-3.5 w-3.5', isRefreshingRepos && 'animate-spin')}
                      />
                    </button>
                  </div>
                  <CommandEmpty>No repositories match your search</CommandEmpty>
                  <CommandList className="max-h-64 overflow-auto">
                    {recentRepos.length > 0 && (
                      <CommandGroup heading="Recently used">
                        {recentRepos.map(repo => (
                          <RepoCommandItem
                            key={`recent-${repo.id}`}
                            repo={repo}
                            isSelected={repo.fullName === selectedRepo}
                            onSelect={handleRepoPillSelect}
                          />
                        ))}
                      </CommandGroup>
                    )}
                    {hasMultiplePlatforms ? (
                      <>
                        {githubRepos.length > 0 && (
                          <CommandGroup heading="GitHub">
                            {githubRepos.map(repo => (
                              <RepoCommandItem
                                key={repo.id}
                                repo={repo}
                                isSelected={repo.fullName === selectedRepo}
                                onSelect={handleRepoPillSelect}
                              />
                            ))}
                          </CommandGroup>
                        )}
                        {gitlabRepos.length > 0 && (
                          <CommandGroup heading="GitLab">
                            {gitlabRepos.map(repo => (
                              <RepoCommandItem
                                key={repo.id}
                                repo={repo}
                                isSelected={repo.fullName === selectedRepo}
                                onSelect={handleRepoPillSelect}
                              />
                            ))}
                          </CommandGroup>
                        )}
                        {otherRepos.length > 0 && (
                          <CommandGroup heading="Other">
                            {otherRepos.map(repo => (
                              <RepoCommandItem
                                key={repo.id}
                                repo={repo}
                                isSelected={repo.fullName === selectedRepo}
                                onSelect={handleRepoPillSelect}
                              />
                            ))}
                          </CommandGroup>
                        )}
                      </>
                    ) : (
                      <CommandGroup>
                        {filteredUnifiedRepos.map(repo => (
                          <RepoCommandItem
                            key={repo.id}
                            repo={repo}
                            isSelected={repo.fullName === selectedRepo}
                            onSelect={handleRepoPillSelect}
                          />
                        ))}
                      </CommandGroup>
                    )}
                  </CommandList>
                </Command>
              )}
            </PopoverContent>
          </Popover>

          {/* Settings — bottom right */}
          <div className="flex shrink-0 items-center gap-3">
            <ProfileConfigIndicator
              state={profileIndicatorState}
              onOpenSettings={() => setSettingsPopoverOpen(true)}
            />
            {profileIndicatorState && <Separator orientation="vertical" className="h-4" />}
            <Popover open={settingsPopoverOpen} onOpenChange={setSettingsPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
                >
                  <Settings className="h-3.5 w-3.5" />
                  Settings
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-[min(28rem,calc(100vw-2rem))] p-0"
                align="end"
                side="bottom"
                sideOffset={8}
              >
                <div className="px-4 py-3">
                  <p className="text-sm font-medium">Advanced settings</p>
                </div>
                <Separator />
                <div className="p-4">
                  <AdvancedConfig
                    label=""
                    organizationId={organizationId}
                    selectedProfileId={selectedProfileId}
                    onProfileSelect={handleProfileSelect}
                    manualEnvVars={manualEnvVars}
                    manualSetupCommands={manualSetupCommands}
                    effectiveEnvVars={effectiveEnvVars}
                    effectiveSetupCommands={effectiveSetupCommands}
                    onManualEnvVarsChange={setManualEnvVars}
                    onManualSetupCommandsChange={setManualSetupCommands}
                    repoFullName={selectedRepo || undefined}
                    platform={selectedPlatform}
                  />
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal sub-component for repo items in the Command list
// ---------------------------------------------------------------------------

function RepoCommandItem({
  repo,
  isSelected,
  onSelect,
}: {
  repo: RepositoryOption;
  isSelected: boolean;
  onSelect: (fullName: string) => void;
}) {
  return (
    <CommandItem value={repo.fullName} onSelect={onSelect} className="flex items-center gap-2">
      {repo.private ? (
        <Lock className="size-3.5 text-yellow-500" />
      ) : (
        <Unlock className="size-3.5 text-gray-500" />
      )}
      <span className="truncate">{repo.fullName}</span>
      <Check className={cn('ml-auto h-4 w-4', isSelected ? 'opacity-100' : 'opacity-0')} />
    </CommandItem>
  );
}
