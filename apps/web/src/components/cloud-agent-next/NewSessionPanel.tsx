'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAtom, useSetAtom } from 'jotai';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import {
  AlertCircle,
  Brain,
  FolderGit2,
  Loader2,
  Lock,
  RefreshCw,
  Send,
  Unlock,
  Check,
  Paperclip,
  Upload,
} from 'lucide-react';
import { startOfDay, subDays } from 'date-fns';
import { useTRPC, useRawTRPCClient } from '@/lib/trpc/utils';
import { SetPageTitle } from '@/components/SetPageTitle';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MobileSidebarToggle } from './MobileSidebarToggle';
import { MobileToolbarPopover } from './MobileToolbarPopover';
import { BrowseCommandsDialog } from './BrowseCommandsDialog';

import { useProfiles, useCombinedProfiles, useProfile } from '@/hooks/useCloudAgentProfiles';
import { useRefreshRepositories } from '@/hooks/useRefreshRepositories';
import { useSlashCommandAutocomplete } from '@/hooks/useSlashCommandAutocomplete';
import { commandsOrDefault } from '@cloud-agent-shared';
import { useOrganizationDefaults } from '@/app/api/organizations/hooks';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import {
  selectedProfileIdAtom,
  resetSessionFormAtom,
} from '@/components/cloud-agent/store/session-form-atoms';
import {
  type RepositoryOption,
  type RepositoryPlatform,
} from '@/components/shared/RepositoryCombobox';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { formatShortModelDisplayName } from '@/lib/format-model-name';
import { ModeCombobox, NEXT_MODE_OPTIONS, type ModeOption } from '@/components/shared/ModeCombobox';
import { VariantCombobox } from '@/components/shared/VariantCombobox';
import { thinkingEffortLabel } from '@/lib/code-reviews/core/model-variants';
import { InsufficientBalanceBanner } from '@/components/shared/InsufficientBalanceBanner';
import { ProfilePickerPopover } from '@/components/cloud-agent/ProfilePickerPopover';
import { Popover, PopoverContent, PopoverTrigger, PopoverAnchor } from '@/components/ui/popover';
import {
  Command as UICommand,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Button as UIButton } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import type { SlashCommand } from '@/lib/cloud-agent/slash-commands';
import {
  extractRepoFromGitUrl,
  findAllGitPlatformUrls,
  detectGitPlatform,
} from '@/components/cloud-agent-next/utils/git-utils';
import type { AgentMode } from './types';
import { formatSessionError } from '@/lib/cloud-agent-sdk';
import { generateMessageId } from '@/lib/cloud-agent-sdk/message-id';
import { useCloudAgentAttachmentUpload } from '@/hooks/useCloudAgentAttachmentUpload';
import { AttachmentPreviewStrip } from './AttachmentPreviewStrip';
import {
  CLOUD_AGENT_ATTACHMENT_MAX_COUNT,
  CLOUD_AGENT_PROMPT_MAX_LENGTH,
} from '@/lib/cloud-agent/constants';
import {
  appendCloudAgentNextLocalTestModel,
  getDevcontainerEnabled,
  getLastUsedModel,
  getLastUsedRepo,
  getLastUsedVariant,
  getPreferredInitialModel,
  getPreferredInitialRepo,
  getPreferredInitialVariant,
  setDevcontainerEnabled,
  setLastUsedModel,
  setLastUsedRepo,
  setLastUsedVariant,
} from '@/components/cloud-agent-next/model-preferences';
import {
  GITHUB_IDENTITY_HINT_DISMISSED_STORAGE_KEY,
  getGitHubIdentityHint,
  getGitHubIdentityHintDismissed,
  markGitHubIdentityHintDismissed,
} from '@/components/cloud-agent-next/github-identity-hint';
import {
  getBitbucketRepositoryRefreshFailureMessage,
  refreshSessionRepositories,
  shouldCacheBitbucketRepositoryRefreshResult,
  shouldIncludeBitbucketRepositoryRefresh,
} from '@/components/cloud-agent-next/repository-refresh';
import { RepositoryProviderOnboardingPanel } from './RepositoryProviderOnboardingPanel';

type Repository = {
  id: string | number;
  name: string;
  fullName: string;
  private: boolean;
  workspaceUuid?: string;
};

type NewSessionPanelProps = {
  organizationId?: string;
  isDevcontainerAvailable: boolean;
};

type ContextualTipProps = {
  body: string;
  linkLabel: string;
  href: string;
  onDismiss: () => void;
};

export function NewSessionPanel({ organizationId, isDevcontainerAvailable }: NewSessionPanelProps) {
  const router = useRouter();
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const commandListRef = useRef<HTMLDivElement>(null);
  const [devcontainer, setDevcontainer] = useState(false);
  const [isGitHubIdentityHintDismissed, setIsGitHubIdentityHintDismissed] = useState<
    boolean | null
  >(null);
  const { mutateAsync: personalUploadUrl } = useMutation(
    trpc.cloudAgentNext.getAttachmentUploadUrl.mutationOptions()
  );
  const { mutateAsync: orgUploadUrl } = useMutation(
    trpc.organizations.cloudAgentNext.getAttachmentUploadUrl.mutationOptions()
  );

  // ---------------------------------------------------------------------------
  // Eligibility
  // ---------------------------------------------------------------------------
  const personalEligibilityQuery = useQuery({
    ...trpc.cloudAgentNext.checkEligibility.queryOptions(),
    enabled: !organizationId,
  });
  const orgEligibilityQuery = useQuery({
    ...trpc.organizations.cloudAgentNext.checkEligibility.queryOptions({
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
  const hasLimitedAccess = !isEligibilityLoading && eligibilityData?.accessLevel === 'limited';

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------
  const { data: modelsData } = useModelSelectorList(organizationId);
  const { lastSelected: serverLastSelected, setLastSelected: persistServerLastSelected } =
    useModelPreferences(organizationId);
  const { data: defaultsData } = useOrganizationDefaults(organizationId);

  const allModels = modelsData?.data || [];

  const modelOptions = useMemo<ModelOption[]>(() => {
    const options = allModels.map(model => ({
      id: model.id,
      name: model.name,
      isFree: model.isFree,
      mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
      hasUserByokAvailable: model.hasUserByokAvailable,
      variants: model.opencode?.variants ? Object.keys(model.opencode.variants) : undefined,
    }));
    const withLocalTest = appendCloudAgentNextLocalTestModel(options);
    if (!hasLimitedAccess) return withLocalTest;
    return withLocalTest.filter(option => option.isFree || option.hasUserByokAvailable);
  }, [allModels, hasLimitedAccess]);

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
  const [showRepositoryRequiredMessage, setShowRepositoryRequiredMessage] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [attachmentMessageUuid, setAttachmentMessageUuid] = useState(() => uuidv4());
  // Repo profile bindings are only keyed by GitHub/GitLab today.
  const profileBindingPlatform: Exclude<RepositoryPlatform, 'bitbucket'> | undefined =
    selectedPlatform === 'bitbucket' ? undefined : selectedPlatform;

  // ---------------------------------------------------------------------------
  // GitHub identity awareness
  // ---------------------------------------------------------------------------
  const {
    data: githubUserAuthorization,
    isLoading: isGitHubUserAuthorizationLoading,
    isError: isGitHubUserAuthorizationError,
  } = useQuery({
    ...trpc.githubApps.getUserAuthorization.queryOptions(),
    enabled:
      isGitHubIdentityHintDismissed === false &&
      selectedRepo.length > 0 &&
      selectedPlatform === 'github',
  });

  const attachmentUpload = useCloudAgentAttachmentUpload({
    messageUuid: attachmentMessageUuid,
    organizationId,
    getUploadUrl: {
      personal: personalUploadUrl,
      organization: orgUploadUrl,
    },
  });
  const isAttachmentLimitReached =
    attachmentUpload.attachments.length >= CLOUD_AGENT_ATTACHMENT_MAX_COUNT;

  // ---------------------------------------------------------------------------
  // Session form atoms (profile override)
  // ---------------------------------------------------------------------------
  const [selectedProfileId, setSelectedProfileId] = useAtom(selectedProfileIdAtom);
  const resetSessionForm = useSetAtom(resetSessionFormAtom);

  // Clear any lingering manual overrides whenever the page loads
  useEffect(() => {
    resetSessionForm();
  }, [resetSessionForm]);

  useEffect(() => {
    setDevcontainer(getDevcontainerEnabled());
    setIsGitHubIdentityHintDismissed(getGitHubIdentityHintDismissed());

    const handleGitHubIdentityHintStorage = (event: StorageEvent) => {
      if (event.key === GITHUB_IDENTITY_HINT_DISMISSED_STORAGE_KEY && event.newValue === 'true') {
        setIsGitHubIdentityHintDismissed(true);
      }
    };
    window.addEventListener('storage', handleGitHubIdentityHintStorage);
    return () => window.removeEventListener('storage', handleGitHubIdentityHintStorage);
  }, []);

  const handleDevcontainerChange = useCallback((enabled: boolean) => {
    setDevcontainer(enabled);
    setDevcontainerEnabled(enabled);
  }, []);

  const effectiveDevcontainer = isDevcontainerAvailable && devcontainer;
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
      const serverLastModelId = serverLastSelected?.model;
      const newModel = getPreferredInitialModel({
        modelOptions,
        lastUsedModel: serverLastModelId ?? getLastUsedModel(organizationId),
        defaultModel: defaultsData?.defaultModel,
      });

      if (newModel && newModel !== model) {
        setModel(newModel);
        setIsModelUserSelected(false);
        // Restore the server-synced variant when seeding the server's model,
        // then the last-used variant, otherwise fall back to the first
        // available variant (typically "none").
        const serverVariant =
          newModel === serverLastSelected?.model ? serverLastSelected.variant : undefined;
        const newVariants = modelOptions.find(m => m.id === newModel)?.variants ?? [];
        setVariant(
          getPreferredInitialVariant({
            availableVariants: newVariants,
            lastUsedVariant: serverVariant ?? getLastUsedVariant(newModel, organizationId),
          })
        );
      }
    }
  }, [
    defaultsData?.defaultModel,
    modelOptions,
    model,
    isModelUserSelected,
    organizationId,
    serverLastSelected,
  ]);

  const handleModelChange = useCallback(
    (newModel: string) => {
      setModel(newModel);
      setIsModelUserSelected(true);
      setLastUsedModel(newModel, organizationId);
      persistServerLastSelected({ model: newModel });
      const newVariants = modelOptions.find(m => m.id === newModel)?.variants ?? [];
      setVariant(
        getPreferredInitialVariant({
          availableVariants: newVariants,
          lastUsedVariant: getLastUsedVariant(newModel, organizationId),
          currentVariant: variant,
        })
      );
    },
    [modelOptions, organizationId, variant, persistServerLastSelected]
  );

  const handleVariantChange = useCallback(
    (newVariant: string) => {
      setVariant(newVariant);
      if (model) {
        setLastUsedVariant(model, newVariant, organizationId);
        persistServerLastSelected({ model, ...(newVariant ? { variant: newVariant } : {}) });
      }
    },
    [model, organizationId, persistServerLastSelected]
  );

  // ---------------------------------------------------------------------------
  // Profiles — used for the selector and to clear a stale selection when a
  // selected profile is deleted elsewhere.
  // ---------------------------------------------------------------------------
  const { data: combinedProfilesData } = useCombinedProfiles({
    organizationId: organizationId ?? '',
    enabled: !!organizationId,
  });
  const { data: personalProfiles } = useProfiles({
    organizationId: undefined,
    enabled: !organizationId,
  });

  const allProfiles = organizationId
    ? [
        ...(combinedProfilesData?.orgProfiles ?? []),
        ...(combinedProfilesData?.personalProfiles ?? []),
      ]
    : (personalProfiles ?? []);

  // If the override profile was deleted, clear the selection
  useEffect(() => {
    if (!selectedProfileId || allProfiles.length === 0) return;
    if (!allProfiles.some(p => p.id === selectedProfileId)) {
      setSelectedProfileId(null);
    }
  }, [allProfiles, selectedProfileId, setSelectedProfileId]);

  // Resolve the profile whose custom agents should appear in the mode picker.
  // Prefers an explicit selection; otherwise falls back to the effective
  // default (personal default wins over org default). This mirrors the
  // server-side resolution in mergeProfileConfiguration for a useful preview.
  const effectiveAgentProfileId =
    selectedProfileId ??
    (organizationId
      ? combinedProfilesData?.effectiveDefaultId
      : (personalProfiles?.find(p => p.isDefault)?.id ?? null)) ??
    null;
  const effectiveAgentProfileOrg =
    effectiveAgentProfileId && organizationId
      ? combinedProfilesData?.orgProfiles.some(p => p.id === effectiveAgentProfileId)
        ? organizationId
        : undefined
      : undefined;
  const { data: selectedProfileDetails } = useProfile(effectiveAgentProfileId ?? '', {
    organizationId: effectiveAgentProfileOrg,
    enabled: !!effectiveAgentProfileId,
  });
  // Expose only agents that would actually surface in the chat picker:
  // not disabled, not hidden, and not subagent-only. Matches the
  // extension's `session.agents().filter(a => a.mode !== 'subagent' && !a.hidden)`.
  const visibleCustomAgents = (selectedProfileDetails?.agents ?? []).filter(
    a => !a.config.disable && !a.config.hidden && a.config.mode !== 'subagent'
  );
  const customModeOptions: ModeOption<AgentMode>[] = visibleCustomAgents.map(a => ({
    value: a.slug as AgentMode,
    label: a.name,
    description: a.config.description ?? '',
  }));

  // When a custom agent pins a `model`, the override wins over the user's
  // model combobox selection. The agent's `variant` is only meaningful when
  // it also pins a model (variants are model-specific, validated at write
  // time in AgentConfigSchema), so it travels with the locked model.
  const selectedCustomAgent = visibleCustomAgents.find(a => a.slug === mode);
  const agentModelOverride = selectedCustomAgent?.config.model?.trim() || undefined;
  const hasAgentModelOverride = !!agentModelOverride;
  const agentVariantOverride = hasAgentModelOverride
    ? selectedCustomAgent?.config.variant?.trim() || undefined
    : undefined;
  const displayModel = agentModelOverride ?? model;
  const displayModelOption = modelOptions.find(m => m.id === displayModel);
  const displayModelLabel = displayModelOption
    ? formatShortModelDisplayName(displayModelOption.name)
    : displayModel;
  const displayVariant = hasAgentModelOverride ? agentVariantOverride : variant;
  const displayVariants = hasAgentModelOverride ? [] : availableVariants;

  // ---------------------------------------------------------------------------
  // Repositories (GitHub + GitLab + Bitbucket)
  // ---------------------------------------------------------------------------
  const {
    data: githubRepoData,
    isLoading: isLoadingGitHubRepos,
    error: githubRepoError,
    refetch: refetchGitHubRepositories,
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
    refetch: refetchGitLabRepositories,
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

  const {
    data: bitbucketRepoData,
    isLoading: isLoadingBitbucketRepos,
    error: bitbucketRepoError,
    isRefetching: isRefetchingBitbucketRepos,
  } = useQuery({
    ...trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryOptions({
      organizationId: organizationId ?? '',
      forceRefresh: false,
    }),
    enabled: Boolean(organizationId),
  });
  const { data: bitbucketStatusData, refetch: refetchBitbucketStatus } = useQuery({
    ...trpc.organizations.bitbucket.getStatus.queryOptions({
      organizationId: organizationId ?? '',
    }),
    enabled: Boolean(organizationId),
  });

  const repoUpdatedSince = useMemo(() => startOfDay(subDays(new Date(), 5)).toISOString(), []);
  const { data: recentRepoData } = useQuery(
    trpc.cliSessionsV2.recentRepositories.queryOptions({
      organizationId: organizationId ?? null,
      updatedSince: repoUpdatedSince,
    })
  );

  const isLoadingRepos =
    isLoadingGitHubRepos && isLoadingGitLabRepos && (!organizationId || isLoadingBitbucketRepos);

  const githubRepositories = (githubRepoData?.repositories || []) as Repository[];
  const gitlabRepositories = (gitlabRepoData?.repositories || []) as Repository[];
  const bitbucketRepositories =
    organizationId && bitbucketRepoData?.status === 'available'
      ? bitbucketRepoData.repositories
      : [];

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
    const bitbucket = bitbucketRepositories.map(repo => ({
      id: repo.id,
      fullName: repo.fullName,
      private: repo.private,
      platform: 'bitbucket' as const,
      workspaceUuid: repo.workspaceUuid,
    }));
    return [...github, ...gitlab, ...bitbucket];
  }, [githubRepositories, gitlabRepositories, bitbucketRepositories]);

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

  const hasMultiplePlatforms =
    [githubRepositories, gitlabRepositories, bitbucketRepositories].filter(
      repositories => repositories.length > 0
    ).length > 1;

  const handleRepoSelect = useCallback(
    (repo: RepositoryOption, userInitiated = true) => {
      setSelectedRepo(repo.fullName);
      setShowRepositoryRequiredMessage(false);
      if (userInitiated) setIsRepoUserSelected(true);
      if (repo.platform) {
        setSelectedPlatform(repo.platform);
        if (userInitiated) setLastUsedRepo(repo.fullName, repo.platform, organizationId);
      }
    },
    [organizationId]
  );

  // ---------------------------------------------------------------------------
  // Auto-select repo from saved preference, recent session, or the only
  // available repository, in that priority order.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (selectedRepo || isRepoUserSelected || unifiedRepositories.length === 0) return;

    const onlyAvailableRepo =
      !isLoadingGitHubRepos &&
      !isLoadingGitLabRepos &&
      (!organizationId || !isLoadingBitbucketRepos) &&
      !githubRepoError &&
      !gitlabRepoError &&
      (!organizationId || !bitbucketRepoError) &&
      unifiedRepositories.length === 1
        ? unifiedRepositories[0]
        : undefined;
    const preferredRepo = getPreferredInitialRepo({
      availableRepos: unifiedRepositories,
      recentRepos,
      onlyAvailableRepo,
      lastUsedRepo: getLastUsedRepo(organizationId),
      isLoadingGitHubRepos,
      isLoadingGitLabRepos,
      isLoadingBitbucketRepos,
    });
    if (!preferredRepo) return;

    handleRepoSelect(preferredRepo, false);
  }, [
    recentRepos,
    selectedRepo,
    isRepoUserSelected,
    handleRepoSelect,
    unifiedRepositories,
    organizationId,
    isLoadingGitHubRepos,
    isLoadingGitLabRepos,
    isLoadingBitbucketRepos,
    githubRepoError,
    gitlabRepoError,
    bitbucketRepoError,
  ]);

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
      setShowRepositoryRequiredMessage(false);
      const platform = detectGitPlatform(url);
      if (platform) {
        setSelectedPlatform(platform);
      }
      break;
    }
  }, [prompt, isRepoUserSelected, unifiedRepositories]);

  const repoError =
    githubRepoError || gitlabRepoError || (organizationId ? bitbucketRepoError : null);

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

  const {
    mutateAsync: refreshBitbucketRepositoriesFromProvider,
    isPending: isRefreshingBitbucketRepos,
  } = useMutation(
    trpc.organizations.bitbucket.refreshRepositories.mutationOptions({
      onSuccess: result => {
        if (!organizationId) return;

        const repositoryQueryKey =
          trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryKey({
            organizationId,
            forceRefresh: false,
          });
        if (shouldCacheBitbucketRepositoryRefreshResult(result.status)) {
          queryClient.setQueryData(repositoryQueryKey, result);
        }

        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.bitbucket.getStatus.queryKey({ organizationId }),
        });
      },
    })
  );

  const refreshBitbucketRepositories = useCallback(
    async (statusOverride?: typeof bitbucketStatusData) => {
      if (!organizationId) return;

      const bitbucketStatus =
        statusOverride ??
        bitbucketStatusData ??
        (await queryClient.fetchQuery(
          trpc.organizations.bitbucket.getStatus.queryOptions({
            organizationId,
          })
        ));

      if (bitbucketStatus.integrationId && bitbucketStatus.canManage) {
        const result = await refreshBitbucketRepositoriesFromProvider({
          organizationId,
          integrationId: bitbucketStatus.integrationId,
        });
        if (result.status !== 'available') {
          throw new Error(getBitbucketRepositoryRefreshFailureMessage(result.status));
        }
        return;
      }

      const result = await queryClient.fetchQuery({
        ...trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryOptions({
          organizationId,
          forceRefresh: true,
        }),
        staleTime: 0,
      });
      if (shouldCacheBitbucketRepositoryRefreshResult(result.status)) {
        queryClient.setQueryData(
          trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryKey({
            organizationId,
            forceRefresh: false,
          }),
          result
        );
      }
      void queryClient.invalidateQueries({
        queryKey: trpc.organizations.bitbucket.getStatus.queryKey({ organizationId }),
      });
      if (result.status !== 'available') {
        throw new Error(getBitbucketRepositoryRefreshFailureMessage(result.status));
      }
    },
    [
      bitbucketStatusData?.canManage,
      bitbucketStatusData?.integrationId,
      organizationId,
      queryClient,
      refreshBitbucketRepositoriesFromProvider,
      trpc.organizations.bitbucket.getStatus,
      trpc.organizations.cloudAgentNext.listBitbucketRepositories,
    ]
  );

  const shouldRefreshBitbucketRepositories =
    organizationId && shouldIncludeBitbucketRepositoryRefresh(bitbucketRepoData?.status);

  const refreshRepositories = useCallback(async () => {
    try {
      await refreshSessionRepositories({
        refreshGitHubRepositories,
        refreshGitLabRepositories,
        refreshBitbucketRepositories: shouldRefreshBitbucketRepositories
          ? refreshBitbucketRepositories
          : undefined,
      });
      toast.success('Repositories refreshed');
    } catch (error) {
      toast.error('Failed to refresh repositories', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, [
    refreshBitbucketRepositories,
    refreshGitHubRepositories,
    refreshGitLabRepositories,
    shouldRefreshBitbucketRepositories,
  ]);

  const isRefreshingRepos =
    isRefreshingGitHubRepos ||
    isRefreshingGitLabRepos ||
    isRefreshingBitbucketRepos ||
    isRefetchingBitbucketRepos;

  const [isCheckingConnection, setIsCheckingConnection] = useState(false);
  const checkSourceControlConnection = useCallback(async () => {
    setIsCheckingConnection(true);

    try {
      const [githubResult, gitlabResult, bitbucketStatusResult] = await Promise.allSettled([
        refetchGitHubRepositories(),
        refetchGitLabRepositories(),
        organizationId ? refetchBitbucketStatus() : Promise.resolve(null),
      ]);
      const connectionAvailable =
        (githubResult.status === 'fulfilled' && githubResult.value.data?.integrationInstalled) ||
        (gitlabResult.status === 'fulfilled' && gitlabResult.value.data?.integrationInstalled);

      if (connectionAvailable) return;

      if (
        bitbucketStatusResult.status === 'fulfilled' &&
        bitbucketStatusResult.value?.data?.status === 'connected'
      ) {
        await refreshBitbucketRepositories(bitbucketStatusResult.value.data);
        return;
      }

      const connectionError = [githubResult, gitlabResult, bitbucketStatusResult]
        .map(result => (result.status === 'rejected' ? result.reason : result.value?.error))
        .find(Boolean);
      if (connectionError) throw connectionError;

      toast.info('No repository provider connected yet');
    } catch (error) {
      toast.error('Could not check source control connections', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setIsCheckingConnection(false);
    }
  }, [
    organizationId,
    refetchBitbucketStatus,
    refetchGitHubRepositories,
    refetchGitLabRepositories,
    refreshBitbucketRepositories,
  ]);

  // ---------------------------------------------------------------------------
  // Integration missing check
  // ---------------------------------------------------------------------------
  const githubIntegrationMissing =
    !isLoadingGitHubRepos && githubRepoData?.integrationInstalled === false;
  const gitlabIntegrationMissing =
    !isLoadingGitLabRepos && gitlabRepoData?.integrationInstalled === false;
  const bitbucketIntegrationMissing = organizationId
    ? !isLoadingBitbucketRepos && bitbucketRepoData?.status !== 'available'
    : true;
  const isIntegrationMissing =
    githubIntegrationMissing && gitlabIntegrationMissing && bitbucketIntegrationMissing;
  const bitbucketIntegrationHref = organizationId
    ? `/organizations/${organizationId}/integrations/bitbucket`
    : null;

  // ---------------------------------------------------------------------------
  // Repo popover state (must be declared before early returns to satisfy Rules of Hooks)
  // ---------------------------------------------------------------------------
  const [repoPopoverOpen, setRepoPopoverOpen] = useState(false);

  const recentFullNames = useMemo(() => new Set(recentRepos.map(r => r.fullName)), [recentRepos]);
  const githubRepos = unifiedRepositories.filter(
    r => r.platform === 'github' && !recentFullNames.has(r.fullName)
  );
  const gitlabRepos = unifiedRepositories.filter(
    r => r.platform === 'gitlab' && !recentFullNames.has(r.fullName)
  );
  const bitbucketRepos = unifiedRepositories.filter(
    r => r.platform === 'bitbucket' && !recentFullNames.has(r.fullName)
  );
  const otherRepos = unifiedRepositories.filter(
    r => !r.platform && !recentFullNames.has(r.fullName)
  );
  const filteredUnifiedRepos = unifiedRepositories.filter(r => !recentFullNames.has(r.fullName));

  const handleRepoPillSelect = useCallback(
    (repo: RepositoryOption) => {
      handleRepoSelect(repo);
      setRepoPopoverOpen(false);
    },
    [handleRepoSelect]
  );

  // ---------------------------------------------------------------------------
  // Slash commands
  // ---------------------------------------------------------------------------
  const slashCommands = useMemo<SlashCommand[]>(() => {
    const defaults = commandsOrDefault(undefined).map(cmd => ({
      trigger: cmd.name,
      label: cmd.name,
      description: cmd.description ?? '',
      expansion: '',
    }));
    const profileCommands = (selectedProfileDetails?.kiloCommands ?? [])
      .filter(cmd => cmd.enabled)
      .map(cmd => ({
        trigger: cmd.name,
        label: cmd.name,
        description: cmd.description ?? '',
        expansion: '',
      }));
    return [...defaults, ...profileCommands];
  }, [selectedProfileDetails?.kiloCommands]);

  const handleSelectCommand = useCallback((command: SlashCommand, autoSend = false) => {
    if (autoSend) {
      setPrompt(`/${command.trigger}`);
    } else {
      const inserted = `/${command.trigger} `;
      setPrompt(inserted);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, window.innerHeight * 0.5)}px`;
        const end = inserted.length;
        textareaRef.current.setSelectionRange(end, end);
      }
    }
    textareaRef.current?.focus();
  }, []);

  const {
    showAutocomplete,
    selectedIndex,
    setSelectedIndex,
    filteredCommands,
    handleKeyDown: handleAutocompleteKeyDown,
    setShowAutocomplete,
  } = useSlashCommandAutocomplete({
    value: prompt,
    slashCommands,
    onSelect: handleSelectCommand,
    listRef: commandListRef,
  });

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------
  const isPromptTooLong = prompt.length > CLOUD_AGENT_PROMPT_MAX_LENGTH;

  const selectedModelOption = modelOptions.find(m => m.id === model);
  // Limited-access users can submit when they've picked a free or BYOK-capable
  // model from the filtered picker; the server still gates paid models behind
  // the minimum balance, but the submit button shouldn't pretend otherwise.
  const limitedAccessModelIsAllowed =
    hasLimitedAccess &&
    !!selectedModelOption &&
    (selectedModelOption.isFree || selectedModelOption.hasUserByokAvailable);

  const isFormValid =
    prompt.trim().length > 0 &&
    !isPromptTooLong &&
    model.length > 0 &&
    !isPreparing &&
    (!hasInsufficientBalance || limitedAccessModelIsAllowed) &&
    !attachmentUpload.hasUploadingAttachments;

  const handleStartSession = useCallback(async () => {
    if (!prompt.trim() || attachmentUpload.hasUploadingAttachments) return;
    if (!selectedRepo) {
      setShowRepositoryRequiredMessage(true);
      return;
    }
    const selectedRepository = unifiedRepositories.find(
      repository => repository.fullName === selectedRepo && repository.platform === selectedPlatform
    );
    if (
      selectedPlatform === 'bitbucket' &&
      (!organizationId ||
        !selectedRepository ||
        typeof selectedRepository.id !== 'string' ||
        !selectedRepository.workspaceUuid)
    ) {
      toast.error('Select the Bitbucket repository again.');
      return;
    }
    const bitbucketRepo =
      organizationId &&
      selectedPlatform === 'bitbucket' &&
      selectedRepository &&
      typeof selectedRepository.id === 'string' &&
      selectedRepository.workspaceUuid
        ? {
            fullName: selectedRepository.fullName,
            workspaceUuid: selectedRepository.workspaceUuid,
            repositoryUuid: selectedRepository.id,
          }
        : undefined;

    setIsPreparing(true);

    try {
      const initialMessageId = generateMessageId();
      const trimmed = prompt.trim();

      // Parse slash command: if the input matches a known command, send a
      // structured initialPayload so the backend dispatches a command rather
      // than treating the text as a free-text prompt.
      const slashMatch = /^\s*\/([\w.-]+)(?:\s+([\s\S]*))?\s*$/.exec(trimmed);
      const slashCommand =
        slashMatch && slashCommands.some(c => c.trigger === slashMatch[1])
          ? { command: slashMatch[1], args: slashMatch[2]?.trim() ?? '' }
          : null;

      if (slashCommand && attachmentUpload.attachments.length > 0) {
        toast.error('Files cannot be attached to slash commands', {
          description: 'Remove the files or type a plain prompt instead.',
        });
        setIsPreparing(false);
        return;
      }

      const baseInput = {
        prompt: trimmed,
        mode,
        model: displayModel,
        variant: displayVariant,
        profileId: selectedProfileId ?? undefined,
        autoCommit: true,
        autoInitiate: true,
        initialMessageId,
        attachments: attachmentUpload.getAttachmentsData(),
        ...(slashCommand
          ? {
              initialPayload: {
                type: 'command' as const,
                command: slashCommand.command,
                arguments: slashCommand.args,
              },
            }
          : {}),
        ...(effectiveDevcontainer ? { devcontainer: true } : {}),
      };
      let result: { kiloSessionId: string; cloudAgentSessionId: string };

      if (organizationId) {
        if (selectedPlatform === 'gitlab') {
          result = await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
            ...baseInput,
            gitlabProject: selectedRepo,
            organizationId,
          });
        } else if (selectedPlatform === 'bitbucket' && bitbucketRepo) {
          result = await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
            ...baseInput,
            bitbucketRepo,
            organizationId,
          });
        } else {
          result = await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
            ...baseInput,
            githubRepo: selectedRepo,
            organizationId,
          });
        }
      } else if (selectedPlatform === 'gitlab') {
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

      if (!hasAgentModelOverride) {
        setLastUsedModel(model, organizationId);
      }
      if (!hasAgentModelOverride && variant) {
        setLastUsedVariant(model, variant, organizationId);
      }

      void queryClient.invalidateQueries({
        queryKey: trpc.cliSessionsV2.list.queryKey({
          limit: 3,
          createdOnPlatform: 'cloud-agent',
          orderBy: 'updated_at',
          organizationId: organizationId ?? null,
        }),
      });

      attachmentUpload.clearAttachments();
      setAttachmentMessageUuid(uuidv4());

      const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
      router.push(`${basePath}/chat?sessionId=${result.kiloSessionId}`);
    } catch (error) {
      console.error('Failed to prepare session:', error);
      toast.error('Failed to create session', {
        description: formatSessionError(error),
      });
    } finally {
      setIsPreparing(false);
    }
  }, [
    effectiveDevcontainer,
    attachmentUpload,
    displayModel,
    // `displayVariant` is what we actually submit; raw `variant` is only read
    // inside the `!hasAgentModelOverride` branch for last-used persistence, so
    // keeping `displayVariant` (which equals `variant` in that branch) here is
    // sufficient and avoids the stale-variant race when the agent-provided
    // override changes while `variant`/`model`/`mode`/`hasAgentModelOverride`
    // stay the same.
    displayVariant,
    hasAgentModelOverride,
    model,
    mode,
    organizationId,
    prompt,
    queryClient,
    router,
    selectedPlatform,
    selectedProfileId,
    selectedRepo,
    slashCommands,
    trpc.cliSessionsV2.list,
    trpcClient,
    unifiedRepositories,
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
        attachmentUpload.addFiles(files);
      }
    },
    [attachmentUpload]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;

      if (handleAutocompleteKeyDown(e)) return;

      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (isFormValid) {
          void handleStartSession();
        }
      }
    },
    [handleAutocompleteKeyDown, isFormValid, handleStartSession]
  );

  const githubIdentityHint = getGitHubIdentityHint({
    selectedRepo,
    selectedPlatform,
    authorization: githubUserAuthorization,
    isLoading: isGitHubUserAuthorizationLoading,
    isError: isGitHubUserAuthorizationError,
    isDismissed: isGitHubIdentityHintDismissed !== false,
  });

  const handleDismissGitHubIdentityHint = useCallback(() => {
    markGitHubIdentityHintDismissed();
    setIsGitHubIdentityHintDismissed(true);
  }, []);

  // ---------------------------------------------------------------------------
  // Integration missing view
  // ---------------------------------------------------------------------------
  if (isIntegrationMissing) {
    return (
      <div className="relative flex h-full flex-col items-center justify-start overflow-y-auto px-4 py-8">
        <SetPageTitle title="Cloud Agent">
          <Badge variant="new">new</Badge>
        </SetPageTitle>
        <MobileSidebarToggle />
        <div className="my-auto w-full max-w-2xl">
          <RepositoryProviderOnboardingPanel
            organizationId={organizationId}
            isCheckingConnection={isCheckingConnection}
            onCheckConnection={() => void checkSourceControlConnection()}
          />
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
        {hasInsufficientBalance && eligibilityData && !hasLimitedAccess && (
          <InsufficientBalanceBanner
            balance={eligibilityData.balance}
            organizationId={organizationId}
            content={{ type: 'productName', productName: 'Cloud Agent' }}
          />
        )}

        {/* Free-models-available banner when balance is low but free models are usable */}
        {hasLimitedAccess && eligibilityData && (
          <InsufficientBalanceBanner
            balance={eligibilityData.balance}
            organizationId={organizationId}
            colorScheme="info"
            content={{
              type: 'custom',
              title: 'Free Models Available',
              description:
                'You can use free models in Cloud Agent. Add credits to unlock all models.',
              compactActionText: 'Add credits to unlock all models',
            }}
          />
        )}

        {/* Textarea + model toolbar container */}
        <div
          className={cn(
            'relative overflow-hidden bg-muted/30 focus-within:ring-ring rounded-lg border focus-within:ring-2',
            isPreparing && 'pointer-events-none opacity-60',
            attachmentUpload.isDragging && 'border-transparent focus-within:ring-0'
          )}
          {...attachmentUpload.dragHandlers}
        >
          {attachmentUpload.isDragging && (
            <div
              className={cn(
                'absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed backdrop-blur-[2px]',
                isAttachmentLimitReached
                  ? 'border-amber-500/60 bg-amber-500/10'
                  : 'border-primary/60 bg-primary/5'
              )}
            >
              <div
                className={cn(
                  'flex items-center gap-2 text-sm font-medium',
                  isAttachmentLimitReached ? 'text-amber-400' : 'text-primary'
                )}
              >
                <Upload className="h-4 w-4" />
                {isAttachmentLimitReached
                  ? `Maximum ${CLOUD_AGENT_ATTACHMENT_MAX_COUNT} files attached`
                  : 'Drop files here'}
              </div>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.txt,.md,.csv"
            multiple
            className="hidden"
            onChange={e => {
              if (e.target.files) {
                attachmentUpload.addFiles(e.target.files);
                e.target.value = '';
              }
            }}
          />
          <Popover
            open={showAutocomplete}
            onOpenChange={open => {
              if (!open) setShowAutocomplete(false);
            }}
          >
            <PopoverAnchor asChild>
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
            </PopoverAnchor>
            <PopoverContent
              className="w-[var(--radix-popover-trigger-width)] min-w-[min(300px,calc(100vw-2rem))] p-0"
              side="top"
              align="start"
              sideOffset={4}
              onOpenAutoFocus={e => e.preventDefault()}
            >
              <UICommand
                shouldFilter={false}
                value={filteredCommands[selectedIndex]?.trigger ?? ''}
              >
                <CommandList ref={commandListRef} className="max-h-64 overflow-auto">
                  <CommandEmpty>No matching commands</CommandEmpty>
                  {filteredCommands.map((cmd, index) => (
                    <CommandItem
                      key={cmd.trigger}
                      value={cmd.trigger}
                      onSelect={() => handleSelectCommand(cmd, false)}
                      className="flex cursor-pointer flex-col items-start gap-1 px-3 py-2"
                      onMouseEnter={() => setSelectedIndex(index)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium text-blue-400">
                          /{cmd.trigger}
                        </span>
                        <span className="text-muted-foreground text-sm">{cmd.label}</span>
                      </div>
                      <span className="text-muted-foreground text-xs">{cmd.description}</span>
                    </CommandItem>
                  ))}
                </CommandList>
              </UICommand>
            </PopoverContent>
          </Popover>
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
          {attachmentUpload.attachments.length > 0 && (
            <div className="px-4 pb-1">
              <AttachmentPreviewStrip
                attachments={attachmentUpload.attachments}
                onRemove={attachmentUpload.removeAttachment}
              />
            </div>
          )}
          <div className="flex min-w-0 items-center gap-2 px-3 py-1.5">
            {/* Mobile: single trigger that opens Mode + Model + Variant */}
            <MobileToolbarPopover
              mode={mode}
              onModeChange={setMode}
              model={displayModel}
              modelOptions={modelOptions}
              onModelChange={handleModelChange}
              isLoadingModels={!modelsData}
              variant={displayVariant}
              availableVariants={displayVariants}
              onVariantChange={handleVariantChange}
              disabled={isPreparing}
              modelPickerDisabled={hasAgentModelOverride}
              modelPickerTooltip={
                hasAgentModelOverride ? `Locked by agent "${selectedCustomAgent?.name}"` : undefined
              }
              variantPickerDisabled={hasAgentModelOverride}
              variantPickerTooltip={
                hasAgentModelOverride ? `Locked by agent "${selectedCustomAgent?.name}"` : undefined
              }
              className="md:hidden"
              customModeOptions={customModeOptions}
            />
            {/* Desktop: individual pickers */}
            <div className="hidden md:contents">
              <ModeCombobox<AgentMode>
                value={mode}
                onValueChange={setMode}
                options={NEXT_MODE_OPTIONS}
                customOptions={customModeOptions}
                variant="compact"
                disabled={isPreparing}
                className="min-w-0"
              />
              {hasAgentModelOverride ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="text-muted-foreground flex h-9 min-w-0 items-center rounded-md border border-dashed px-2 text-xs">
                      <span className={cn('truncate', !displayModelOption && 'font-mono')}>
                        {displayModelLabel}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    Model is locked by agent &ldquo;{selectedCustomAgent?.name}&rdquo;
                  </TooltipContent>
                </Tooltip>
              ) : (
                <ModelCombobox
                  models={modelOptions}
                  value={model}
                  onValueChange={handleModelChange}
                  isLoading={!modelsData}
                  variant="compact"
                  disabled={isPreparing}
                  className="min-w-0"
                />
              )}
              {hasAgentModelOverride
                ? displayVariant && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="text-muted-foreground flex h-9 min-w-0 items-center gap-1.5 rounded-md border border-dashed px-2 text-xs">
                          <Brain className="h-3.5 w-3.5 shrink-0 opacity-70" />
                          <span className="truncate">{thinkingEffortLabel(displayVariant)}</span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        Locked by agent &ldquo;{selectedCustomAgent?.name}&rdquo;
                      </TooltipContent>
                    </Tooltip>
                  )
                : availableVariants.length > 0 && (
                    <VariantCombobox
                      variants={availableVariants}
                      value={variant}
                      onValueChange={handleVariantChange}
                      disabled={isPreparing}
                      className="min-w-0"
                    />
                  )}
            </div>

            {slashCommands.length > 0 && (
              <div className="hidden xl:block">
                <BrowseCommandsDialog />
              </div>
            )}

            <div className="flex-1" />

            {isPreparing && <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />}
            <UIButton
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={isPreparing}
              className="relative h-8 w-8 rounded-lg before:absolute before:-inset-1.5"
              title="Attach files"
              aria-label="Attach files"
            >
              <Paperclip className="h-4 w-4" />
            </UIButton>
            {showRepositoryRequiredMessage && (
              <p
                id="new-session-repository-required"
                className="flex shrink-0 items-center gap-1 text-xs text-amber-400"
                role="alert"
              >
                <AlertCircle className="h-3 w-3 shrink-0" />
                Select a repository
              </p>
            )}
            <UIButton
              type="button"
              variant="primary"
              size="icon"
              onClick={() => void handleStartSession()}
              disabled={!isFormValid || isPreparing || attachmentUpload.hasUploadingAttachments}
              className="relative h-8 w-8 rounded-lg before:absolute before:-inset-1.5"
              aria-describedby={
                showRepositoryRequiredMessage ? 'new-session-repository-required' : undefined
              }
              aria-label="Start session"
            >
              <Send className="h-4 w-4" />
            </UIButton>
          </div>
        </div>

        {/* Repo + Settings row (outside prompt box) */}
        <div className="flex items-center justify-between gap-3">
          {/* Repo — bottom left */}
          <Popover open={repoPopoverOpen} onOpenChange={setRepoPopoverOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  'text-muted-foreground hover:text-foreground inline-flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-sm',
                  selectedRepo && 'text-foreground'
                )}
                disabled={isPreparing}
              >
                <FolderGit2 className="h-3.5 w-3.5" />
                <span className="max-w-[min(16rem,50vw)] truncate">
                  {selectedRepo || 'Repository'}
                </span>
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
                <div className="text-muted-foreground space-y-2 p-4 text-center text-sm">
                  <p>No repositories found</p>
                  {organizationId && bitbucketRepoData?.status === 'temporarily_unavailable' && (
                    <p>The Bitbucket repository cache is temporarily unavailable.</p>
                  )}
                  {organizationId &&
                    bitbucketIntegrationHref &&
                    bitbucketRepoData?.status &&
                    bitbucketRepoData.status !== 'available' &&
                    bitbucketRepoData.status !== 'temporarily_unavailable' && (
                      <Link
                        href={bitbucketIntegrationHref}
                        className="text-link hover:text-link-hover underline underline-offset-4"
                      >
                        {bitbucketRepoData.status === 'reconnect_required' ||
                        bitbucketRepoData.status === 'insufficient_permissions'
                          ? 'Replace the Bitbucket token'
                          : bitbucketRepoData.status === 'invalid_request'
                            ? 'Review the Bitbucket connection'
                            : 'Connect Bitbucket'}
                      </Link>
                    )}
                  <UIButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void refreshRepositories()}
                    disabled={isRefreshingRepos}
                    className="mx-auto"
                  >
                    <RefreshCw className={cn('size-3.5', isRefreshingRepos && 'animate-spin')} />
                    {isRefreshingRepos ? 'Refreshing repositories...' : 'Refresh repositories'}
                  </UIButton>
                </div>
              ) : (
                <UICommand>
                  <div className="flex items-center border-b pr-2 [&_[cmdk-input-wrapper]]:flex-1 [&_[cmdk-input-wrapper]]:border-b-0">
                    <CommandInput placeholder="Search repositories..." />
                    <button
                      type="button"
                      onClick={() => void refreshRepositories()}
                      disabled={isRefreshingRepos}
                      className="text-muted-foreground hover:text-foreground shrink-0 rounded-sm p-1 disabled:opacity-50"
                      aria-label="Refresh repositories"
                      title="Refresh repositories"
                    >
                      <RefreshCw
                        className={cn('h-3.5 w-3.5', isRefreshingRepos && 'animate-spin')}
                      />
                    </button>
                  </div>
                  {(bitbucketRepoData?.status === 'reconnect_required' ||
                    bitbucketRepoData?.status === 'insufficient_permissions') &&
                    bitbucketIntegrationHref && (
                      <div className="border-b px-3 py-2 text-xs">
                        <Link
                          href={bitbucketIntegrationHref}
                          className="text-link hover:text-link-hover underline underline-offset-4"
                        >
                          Replace the Bitbucket token to list repositories
                        </Link>
                      </div>
                    )}
                  <CommandEmpty>No repositories match your search</CommandEmpty>
                  <CommandList className="max-h-64 overflow-auto">
                    {recentRepos.length > 0 && (
                      <CommandGroup heading="Recently used">
                        {recentRepos.map(repo => (
                          <RepoCommandItem
                            key={`recent-${repo.id}`}
                            repo={repo}
                            isSelected={
                              repo.fullName === selectedRepo && repo.platform === selectedPlatform
                            }
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
                                isSelected={
                                  repo.fullName === selectedRepo &&
                                  repo.platform === selectedPlatform
                                }
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
                                isSelected={
                                  repo.fullName === selectedRepo &&
                                  repo.platform === selectedPlatform
                                }
                                onSelect={handleRepoPillSelect}
                              />
                            ))}
                          </CommandGroup>
                        )}
                        {bitbucketRepos.length > 0 && (
                          <CommandGroup heading="Bitbucket">
                            {bitbucketRepos.map(repo => (
                              <RepoCommandItem
                                key={repo.id}
                                repo={repo}
                                isSelected={
                                  repo.fullName === selectedRepo &&
                                  repo.platform === selectedPlatform
                                }
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
                                isSelected={
                                  repo.fullName === selectedRepo &&
                                  repo.platform === selectedPlatform
                                }
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
                            isSelected={
                              repo.fullName === selectedRepo && repo.platform === selectedPlatform
                            }
                            onSelect={handleRepoPillSelect}
                          />
                        ))}
                      </CommandGroup>
                    )}
                  </CommandList>
                </UICommand>
              )}
            </PopoverContent>
          </Popover>

          <div className="flex shrink-0 items-center gap-2">
            {effectiveDevcontainer && (
              <span className="text-muted-foreground inline-flex shrink-0 items-center rounded-md border border-border/50 bg-muted/30 px-2 py-1 text-xs">
                Dev container on
              </span>
            )}
            <ProfilePickerPopover
              organizationId={organizationId}
              selectedOverrideProfileId={selectedProfileId}
              onOverrideProfileSelect={setSelectedProfileId}
              repoFullName={selectedRepo || undefined}
              platform={profileBindingPlatform}
              devcontainerToggle={
                isDevcontainerAvailable
                  ? {
                      checked: effectiveDevcontainer,
                      disabled: isPreparing,
                      onCheckedChange: handleDevcontainerChange,
                    }
                  : undefined
              }
            />
          </div>
        </div>

        {githubIdentityHint && (
          <ContextualTip {...githubIdentityHint} onDismiss={handleDismissGitHubIdentityHint} />
        )}
      </div>
    </div>
  );
}

function ContextualTip({ body, linkLabel, href, onDismiss }: ContextualTipProps) {
  return (
    <div className="group/tip flex max-w-full justify-center text-center" role="status">
      <div className="text-muted-foreground inline-flex max-w-full items-start justify-center gap-1 text-xs">
        <span aria-hidden="true" className="invisible mr-1 shrink-0 px-1">
          Dismiss
        </span>
        <span className="text-foreground font-medium">Tip:</span>
        <span aria-hidden="true" className="text-border">
          &middot;
        </span>
        <span className="min-w-0">
          {body}{' '}
          <Link
            href={href}
            className="text-blue-400 hover:text-blue-300 hover:underline focus-visible:underline"
          >
            {linkLabel}
          </Link>
        </span>
        <button
          type="button"
          className="text-muted-foreground/70 hover:text-foreground focus-visible:text-foreground focus-visible:ring-ring pointer-events-none -my-4 ml-1 shrink-0 cursor-pointer rounded-sm px-1 py-4 underline decoration-border underline-offset-4 opacity-0 transition-opacity group-focus-within/tip:pointer-events-auto group-focus-within/tip:opacity-100 group-hover/tip:pointer-events-auto group-hover/tip:opacity-100 focus-visible:ring-1 focus-visible:outline-none [@media(any-pointer:coarse)]:pointer-events-auto [@media(any-pointer:coarse)]:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
          onClick={onDismiss}
        >
          Dismiss
        </button>
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
  onSelect: (repo: RepositoryOption) => void;
}) {
  return (
    <CommandItem
      value={repo.fullName}
      onSelect={() => onSelect(repo)}
      className="flex items-center gap-2"
    >
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
