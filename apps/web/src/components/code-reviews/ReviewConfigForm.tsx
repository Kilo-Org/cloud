'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import {
  Settings,
  Save,
  RefreshCw,
  Webhook,
  AlertCircle,
  CheckCircle2,
  Copy,
  Check,
  ChevronDown,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useTRPC } from '@/lib/trpc/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import {
  REVIEW_FOCUS_AREAS,
  REVIEW_STYLES as REVIEW_STYLE_VALUES,
  type ReviewFocusArea,
  type ReviewStyle,
} from '@kilocode/app-shared/code-review';

import { useRefreshRepositories } from '@/hooks/useRefreshRepositories';
import { useOrganizationModels } from '@/components/cloud-agent/hooks/useOrganizationModels';
import { CouncilSpecialistPicker } from './CouncilSpecialistPicker';
import {
  buildCouncilSpecialists,
  councilSelectionsFromConfig,
  countEnabledSelections,
  defaultCouncilSelections,
  type CouncilSpecialistSelection,
} from '@/lib/code-reviews/core/council-selection';
import {
  COUNCIL_AGGREGATION_STRATEGIES,
  DEFAULT_COUNCIL_AGGREGATION_STRATEGY,
  type CouncilAggregationStrategy,
} from '@kilocode/db/schema-types';
import {
  COUNCIL_MIN_SPECIALISTS,
  formatAggregationStrategy,
} from '@kilocode/worker-utils/code-review-council';
import { ModelCombobox } from '@/components/shared/ModelCombobox';
import { cn } from '@/lib/utils';
import { RepositoryMultiSelect } from './RepositoryMultiSelect';
import {
  RepositoryModelOverrides,
  type RepositoryModelOverrideValue,
} from './RepositoryModelOverrides';
import { CodeReviewActionRequiredAlert } from './CodeReviewActionRequiredAlert';
import { PRIMARY_DEFAULT_MODEL } from '@/lib/ai-gateway/models';
import {
  getAvailableThinkingEfforts,
  thinkingEffortLabel,
} from '@/lib/code-reviews/core/model-variants';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type Platform = 'github' | 'gitlab';

export type GitLabStatusData = {
  connected: boolean;
  integration?: {
    isValid: boolean;
    webhookSecret?: string;
    instanceUrl?: string;
  };
};

export type ReviewConfigFormProps = {
  organizationId?: string;
  platform?: Platform;
  gitlabStatusData?: GitLabStatusData;
  /** Same gate as the manual council UI: local dev, or an entitled org behind the rollout flag. */
  councilUiEnabled?: boolean;
};

// Labels/descriptions stay web-local; the ids/values themselves are derived
// from the shared arrays (@kilocode/app-shared/code-review) so they can't
// drift from the db schema's review_style/gate_threshold enums or mobile's
// copy. Order matches the original literal arrays exactly.
const FOCUS_AREA_COPY: Record<ReviewFocusArea, { label: string; description: string }> = {
  security: { label: 'Security vulnerabilities', description: 'SQL injection, XSS, etc.' },
  performance: { label: 'Performance issues', description: 'N+1 queries, inefficient loops' },
  bugs: { label: 'Bug detection', description: 'Logic errors, edge cases' },
  style: { label: 'Code style', description: 'Formatting, naming conventions' },
  testing: { label: 'Test coverage', description: 'Missing or inadequate tests' },
  documentation: { label: 'Documentation', description: 'Missing comments, unclear APIs' },
};

export const FOCUS_AREAS = REVIEW_FOCUS_AREAS.map(id => ({ id, ...FOCUS_AREA_COPY[id] }));

const REVIEW_STYLE_COPY: Record<ReviewStyle, { label: string; description: string }> = {
  strict: {
    label: 'Strict',
    description: 'Flag all potential issues, prioritize quality and security',
  },
  balanced: {
    label: 'Balanced',
    description: 'Focus on confidence, balance thoroughness with practicality',
  },
  lenient: {
    label: 'Lenient',
    description: 'Only critical bugs and security issues, be encouraging',
  },
  roast: {
    label: 'Roast',
    description:
      'Brutally honest, technically accurate feedback wrapped in sharp, witty commentary',
  },
};

export const REVIEW_STYLES = REVIEW_STYLE_VALUES.map(value => ({
  value,
  ...REVIEW_STYLE_COPY[value],
}));

export function ReviewConfigForm({
  organizationId,
  platform = 'github',
  gitlabStatusData,
  councilUiEnabled = false,
}: ReviewConfigFormProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isGitLab = platform === 'gitlab';
  const platformLabel = isGitLab ? 'GitLab' : 'GitHub';
  const prLabel = isGitLab ? 'merge requests' : 'pull requests';
  const reviewMdGuideHref = organizationId
    ? `/organizations/${organizationId}/code-reviews/review-md`
    : '/code-reviews/review-md';

  // Fetch current config
  const organizationConfigQuery = useQuery({
    ...trpc.organizations.reviewAgent.getReviewConfig.queryOptions({
      organizationId: organizationId ?? '',
      platform,
    }),
    enabled: Boolean(organizationId),
  });
  const personalConfigQuery = useQuery({
    ...trpc.personalReviewAgent.getReviewConfig.queryOptions({ platform }),
    enabled: !organizationId,
  });
  const {
    data: configData,
    isLoading,
    refetch,
  } = organizationId ? organizationConfigQuery : personalConfigQuery;

  // Fetch repositories based on platform (cached by default)
  const {
    data: repositoriesData,
    isLoading: isLoadingRepositories,
    error: repositoriesError,
  } = useQuery(
    organizationId
      ? isGitLab
        ? trpc.organizations.reviewAgent.listGitLabRepositories.queryOptions({
            organizationId,
            forceRefresh: false,
          })
        : trpc.organizations.reviewAgent.listGitHubRepositories.queryOptions({
            organizationId,
            forceRefresh: false,
          })
      : isGitLab
        ? trpc.personalReviewAgent.listGitLabRepositories.queryOptions({
            forceRefresh: false,
          })
        : trpc.personalReviewAgent.listGitHubRepositories.queryOptions({
            forceRefresh: false,
          })
  );

  // Refresh repositories hook
  const { refresh: refreshRepositories, isRefreshing: isRefreshingRepos } = useRefreshRepositories({
    getRefreshQueryOptions: useCallback(
      () =>
        organizationId
          ? isGitLab
            ? trpc.organizations.reviewAgent.listGitLabRepositories.queryOptions({
                organizationId,
                forceRefresh: true,
              })
            : trpc.organizations.reviewAgent.listGitHubRepositories.queryOptions({
                organizationId,
                forceRefresh: true,
              })
          : isGitLab
            ? trpc.personalReviewAgent.listGitLabRepositories.queryOptions({
                forceRefresh: true,
              })
            : trpc.personalReviewAgent.listGitHubRepositories.queryOptions({
                forceRefresh: true,
              }),
      [organizationId, trpc, isGitLab]
    ),
    getCacheQueryKey: useCallback(
      () =>
        organizationId
          ? isGitLab
            ? trpc.organizations.reviewAgent.listGitLabRepositories.queryKey({
                organizationId,
                forceRefresh: false,
              })
            : trpc.organizations.reviewAgent.listGitHubRepositories.queryKey({
                organizationId,
                forceRefresh: false,
              })
          : isGitLab
            ? trpc.personalReviewAgent.listGitLabRepositories.queryKey({
                forceRefresh: false,
              })
            : trpc.personalReviewAgent.listGitHubRepositories.queryKey({
                forceRefresh: false,
              }),
      [organizationId, trpc, isGitLab]
    ),
  });

  // Fetch available models
  const { modelOptions, isLoadingModels } = useOrganizationModels(organizationId);

  // Local state
  const [isEnabled, setIsEnabled] = useState(false);
  const [reviewStyle, setReviewStyle] = useState<'strict' | 'balanced' | 'lenient' | 'roast'>(
    'balanced'
  );
  const [focusAreas, setFocusAreas] = useState<string[]>([]);
  const [customInstructions, setCustomInstructions] = useState('');
  const [selectedModel, setSelectedModel] = useState(PRIMARY_DEFAULT_MODEL);
  const [thinkingEffort, setThinkingEffort] = useState<string | null>(null);
  const [gateThreshold, setGateThreshold] = useState<'off' | 'all' | 'warning' | 'critical'>('off');
  const [repositorySelectionMode, setRepositorySelectionMode] = useState<'all' | 'selected'>('all');
  const [selectedRepositoryIds, setSelectedRepositoryIds] = useState<number[]>([]);
  // Per-repository model overrides keyed by repository id.
  const [repositoryModelOverrides, setRepositoryModelOverrides] = useState<
    Map<number, RepositoryModelOverrideValue>
  >(new Map());
  // Org-level council config (shared by every council-enabled repo) + per-repo opt-in set.
  // Council is "on" when at least one repo opts in — there is no separate global toggle.
  const [councilAggregation, setCouncilAggregation] = useState<CouncilAggregationStrategy>(
    DEFAULT_COUNCIL_AGGREGATION_STRATEGY
  );
  const [councilSelections, setCouncilSelections] = useState<
    Record<string, CouncilSpecialistSelection>
  >(() => defaultCouncilSelections());
  const [councilEnabledRepositoryIds, setCouncilEnabledRepositoryIds] = useState<Set<number>>(
    new Set()
  );
  const [useReviewMd, setUseReviewMd] = useState(true);
  // GitLab-specific: auto-configure webhooks
  const [autoConfigureWebhooks, setAutoConfigureWebhooks] = useState(true);
  // Webhook sync result from last save
  const [webhookSyncResult, setWebhookSyncResult] = useState<{
    created: number;
    updated: number;
    deleted: number;
    errors: Array<{ projectId: number; error: string; operation: string }>;
  } | null>(null);
  // Manual webhook configuration state
  const [showManualWebhookSetup, setShowManualWebhookSetup] = useState(false);
  const [copiedWebhookUrl, setCopiedWebhookUrl] = useState(false);
  const [copiedWebhookSecret, setCopiedWebhookSecret] = useState(false);
  const [regeneratedSecret, setRegeneratedSecret] = useState<string | null>(null);

  // Get webhook URL for GitLab
  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/webhooks/gitlab`
      : '/api/webhooks/gitlab';

  // Available thinking effort variants for the selected model
  const availableVariants = useMemo(
    () => getAvailableThinkingEfforts(selectedModel),
    [selectedModel]
  );

  const selectableRepositories = useMemo(() => {
    const cachedRepositories = (repositoriesData?.repositories ?? []).map(repo => ({
      id: repo.id,
      name: repo.name,
      full_name: repo.fullName,
      private: repo.private,
    }));
    const cachedRepositoryIds = new Set(cachedRepositories.map(repo => repo.id));
    const legacyRepositories = (configData?.manuallyAddedRepositories ?? []).filter(
      repo => !cachedRepositoryIds.has(repo.id)
    );

    return [...cachedRepositories, ...legacyRepositories];
  }, [configData?.manuallyAddedRepositories, repositoriesData?.repositories]);

  // Reset thinking effort when the model changes and the current selection is invalid
  useEffect(() => {
    if (thinkingEffort && !availableVariants.includes(thinkingEffort)) {
      setThinkingEffort(null);
    }
  }, [availableVariants, thinkingEffort]);

  // Mutation for regenerating webhook secret
  const regenerateSecretMutation = useMutation(
    trpc.gitlab.regenerateWebhookSecret.mutationOptions({
      onSuccess: data => {
        setRegeneratedSecret(data.webhookSecret);
        toast.success('Webhook secret regenerated successfully');
        // Invalidate the GitLab status query to refresh the data
        void queryClient.invalidateQueries({
          queryKey: trpc.personalReviewAgent.getGitLabStatus.queryKey(),
        });
      },
      onError: error => {
        toast.error('Failed to regenerate webhook secret', {
          description: error.message,
        });
      },
    })
  );

  const handleRegenerateSecret = () => {
    setRegeneratedSecret(null); // Clear any previously shown secret
    regenerateSecretMutation.mutate({});
  };

  const handleCopyWebhookUrl = async () => {
    await navigator.clipboard.writeText(webhookUrl);
    setCopiedWebhookUrl(true);
    toast.success('Webhook URL copied to clipboard');
    setTimeout(() => setCopiedWebhookUrl(false), 2000);
  };

  const handleCopyWebhookSecret = async () => {
    const secret = gitlabStatusData?.integration?.webhookSecret;
    if (secret) {
      await navigator.clipboard.writeText(secret);
      setCopiedWebhookSecret(true);
      toast.success('Webhook secret copied to clipboard');
      setTimeout(() => setCopiedWebhookSecret(false), 2000);
    }
  };

  const handleCopyRegeneratedSecret = async () => {
    if (regeneratedSecret) {
      await navigator.clipboard.writeText(regeneratedSecret);
      setCopiedWebhookSecret(true);
      toast.success('New webhook secret copied to clipboard');
      setTimeout(() => setCopiedWebhookSecret(false), 2000);
    }
  };

  // Update local state when config loads
  useEffect(() => {
    if (configData) {
      setIsEnabled(configData.isEnabled);
      setReviewStyle(configData.reviewStyle);
      setFocusAreas(configData.focusAreas);
      setCustomInstructions(configData.customInstructions || '');
      setSelectedModel(configData.modelSlug);
      setThinkingEffort(configData.thinkingEffort ?? null);
      setGateThreshold(configData.gateThreshold ?? 'off');
      // For GitLab, default to 'selected' mode since 'all' is not supported
      const repoMode = configData.repositorySelectionMode || 'all';
      setRepositorySelectionMode(isGitLab ? 'selected' : repoMode);
      setSelectedRepositoryIds(
        configData.selectedRepositoryIds.filter(
          (repositoryId): repositoryId is number => typeof repositoryId === 'number'
        )
      );
      const overridesMap = new Map<number, RepositoryModelOverrideValue>();
      for (const override of configData.repositoryModelOverrides ?? []) {
        if (typeof override.repositoryId === 'number') {
          overridesMap.set(override.repositoryId, {
            repoFullName: override.repoFullName,
            modelSlug: override.modelSlug,
            thinkingEffort: override.thinkingEffort ?? null,
          });
        }
      }
      setRepositoryModelOverrides(overridesMap);
      const loadedCouncil = configData.council ?? null;
      setCouncilAggregation(
        loadedCouncil?.aggregation_strategy ?? DEFAULT_COUNCIL_AGGREGATION_STRATEGY
      );
      setCouncilSelections(
        loadedCouncil ? councilSelectionsFromConfig(loadedCouncil) : defaultCouncilSelections()
      );
      setCouncilEnabledRepositoryIds(
        new Set(
          (configData.councilEnabledRepositoryIds ?? []).filter(
            (repositoryId): repositoryId is number => typeof repositoryId === 'number'
          )
        )
      );
      setUseReviewMd(!(configData.disableReviewMd ?? false));
    }
  }, [configData, isGitLab]);

  const handleRepositoryModelOverrideSet = useCallback(
    (repositoryId: number, value: RepositoryModelOverrideValue) => {
      setRepositoryModelOverrides(prev => new Map(prev).set(repositoryId, value));
    },
    []
  );

  const handleRepositoryModelOverrideRemove = useCallback((repositoryId: number) => {
    setRepositoryModelOverrides(prev => {
      const next = new Map(prev);
      next.delete(repositoryId);
      return next;
    });
  }, []);

  // Organization mutations
  const orgToggleMutation = useMutation(
    trpc.organizations.reviewAgent.toggleReviewAgent.mutationOptions({
      onSuccess: async data => {
        toast.success(data.isEnabled ? 'Code Reviewer enabled' : 'Code Reviewer disabled');
        setIsEnabled(data.isEnabled);
        await refetch();
      },
      onError: error => {
        toast.error('Failed to toggle Code Reviewer', {
          description: error.message,
        });
      },
    })
  );

  const orgSaveMutation = useMutation(
    trpc.organizations.reviewAgent.saveReviewConfig.mutationOptions({
      onSuccess: async data => {
        // Handle webhook sync result for GitLab
        if (data.webhookSync) {
          setWebhookSyncResult(data.webhookSync);
          const { created, updated, deleted, errors } = data.webhookSync;
          if (errors.length > 0) {
            toast.warning('Configuration saved with webhook errors', {
              description: `${errors.length} webhook(s) failed to configure`,
            });
          } else if (created > 0 || updated > 0 || deleted > 0) {
            toast.success('Configuration saved', {
              description: `Webhooks: ${created} created, ${updated} updated, ${deleted} removed`,
            });
          } else {
            toast.success('Review configuration saved');
          }
        } else {
          toast.success('Review configuration saved');
        }
        await refetch();
      },
      onError: error => {
        toast.error('Failed to save configuration', {
          description: error.message,
        });
      },
    })
  );

  // Personal mutations
  const personalToggleMutation = useMutation(
    trpc.personalReviewAgent.toggleReviewAgent.mutationOptions({
      onSuccess: async data => {
        toast.success(data.isEnabled ? 'Code Reviewer enabled' : 'Code Reviewer disabled');
        setIsEnabled(data.isEnabled);
        await refetch();
      },
      onError: error => {
        toast.error('Failed to toggle Code Reviewer', {
          description: error.message,
        });
      },
    })
  );

  const personalSaveMutation = useMutation(
    trpc.personalReviewAgent.saveReviewConfig.mutationOptions({
      onSuccess: async data => {
        // Handle webhook sync result for GitLab
        if (data.webhookSync) {
          setWebhookSyncResult(data.webhookSync);
          const { created, updated, deleted, errors } = data.webhookSync;
          if (errors.length > 0) {
            toast.warning('Configuration saved with webhook errors', {
              description: `${errors.length} webhook(s) failed to configure`,
            });
          } else if (created > 0 || updated > 0 || deleted > 0) {
            toast.success('Configuration saved', {
              description: `Webhooks: ${created} created, ${updated} updated, ${deleted} removed`,
            });
          } else {
            toast.success('Review configuration saved');
          }
        } else {
          toast.success('Review configuration saved');
        }
        await refetch();
      },
      onError: error => {
        toast.error('Failed to save configuration', {
          description: error.message,
        });
      },
    })
  );

  const handleToggle = (checked: boolean) => {
    if (organizationId) {
      orgToggleMutation.mutate({
        organizationId,
        platform,
        isEnabled: checked,
      });
    } else {
      personalToggleMutation.mutate({
        platform,
        isEnabled: checked,
      });
    }
  };

  // Master "Simple vs Advanced" switch: Advanced reveals per-repository overrides (repo selection,
  // per-repo model/effort, per-repo council). GitLab has no "all" mode, so it is always Advanced.
  const perRepoOverridesEnabled = isGitLab || repositorySelectionMode === 'selected';
  const handlePerRepoOverridesToggle = (enabled: boolean) => {
    setRepositorySelectionMode(enabled ? 'selected' : 'all');
  };

  // Council is on when 1+ *currently selected* repos opt in; the shared specialist picker then
  // applies to all of them. A council opt-in only counts while its repository is still selected:
  // removing a repo from the Repositories list stops rendering its council toggle, so without this
  // intersection a stale id would keep the picker open, block save on the minimum-specialist check,
  // and persist to council_enabled_repository_ids (silently re-activating council if the repo were
  // re-added). Deriving from the live selection instead of mutating the set means re-selecting the
  // repo within the same edit restores its prior opt-in.
  const councilEnabledSelectedRepositoryIds = selectedRepositoryIds.filter(id =>
    councilEnabledRepositoryIds.has(id)
  );
  const councilEnabled = councilEnabledSelectedRepositoryIds.length > 0;
  const councilEnabledCount = countEnabledSelections(councilSelections);
  const councilBelowMin = councilEnabled && councilEnabledCount < COUNCIL_MIN_SPECIALISTS;
  // Only repositories the user actually selected can be configured per-repo (model + council),
  // so the per-repo pickers never offer a repo that isn't being reviewed.
  const selectedRepositories = selectableRepositories.filter(repo =>
    selectedRepositoryIds.includes(repo.id)
  );

  const handleCouncilRepoToggle = (repositoryId: number, enabled: boolean) => {
    setCouncilEnabledRepositoryIds(prev => {
      const next = new Set(prev);
      if (enabled) next.add(repositoryId);
      else next.delete(repositoryId);
      return next;
    });
  };

  const handleSave = () => {
    // Clear previous webhook sync result
    setWebhookSyncResult(null);

    // Preserve selected legacy live-search entries until their persisted contract is migrated.
    const selectedRepositoryIdSet = new Set(selectedRepositoryIds);
    const manuallyAddedRepositories = (configData?.manuallyAddedRepositories ?? []).filter(repo =>
      selectedRepositoryIdSet.has(repo.id)
    );

    // Overrides are independent of the trigger selection mode — they apply whether
    // reviews run on all or selected repositories. Sent only when the per-repository
    // section is toggled on; toggling it off clears the overrides on save.
    const repositoryModelOverridesPayload = perRepoOverridesEnabled
      ? Array.from(repositoryModelOverrides.entries()).map(([repositoryId, value]) => ({
          repositoryId,
          repoFullName: value.repoFullName,
          modelSlug: value.modelSlug,
          thinkingEffort: value.thinkingEffort,
        }))
      : [];

    // Council lives entirely inside Advanced Settings, so turning Advanced off clears it on save
    // (same as per-repo model overrides), matching the "every repository uses the global settings"
    // copy. Only guard/persist council when the section is actually shown (Advanced + entitled).
    const councilActiveForSave = perRepoOverridesEnabled && councilUiEnabled && councilEnabled;
    if (councilActiveForSave && councilBelowMin) {
      toast.error('Council needs more specialists', {
        description: `Select at least ${COUNCIL_MIN_SPECIALISTS} council specialists.`,
      });
      return;
    }
    const councilPayload = councilActiveForSave
      ? {
          enabled: true,
          aggregation_strategy: councilAggregation,
          specialists: buildCouncilSpecialists(councilSelections),
        }
      : null;
    // Gate on `councilActiveForSave` (not just `perRepoOverridesEnabled`) so `council` and its
    // per-repo opt-ins are always written or cleared as a unit. Otherwise, if council becomes
    // UI-unavailable (entitlement lapses or the flag is turned off) while Advanced stays on, an
    // unrelated save would persist `council: null` alongside a non-empty opt-in list, leaving
    // orphaned ids that would silently re-activate council if it were later re-enabled. When
    // active, still persist only opt-ins for repos that are currently selected.
    const councilEnabledRepositoryIdsPayload = councilActiveForSave
      ? councilEnabledSelectedRepositoryIds
      : [];

    if (organizationId) {
      orgSaveMutation.mutate({
        organizationId,
        platform,
        reviewStyle,
        focusAreas,
        customInstructions: customInstructions.trim() || undefined,
        modelSlug: selectedModel,
        thinkingEffort,
        gateThreshold,
        repositorySelectionMode,
        selectedRepositoryIds,
        manuallyAddedRepositories,
        repositoryModelOverrides: repositoryModelOverridesPayload,
        council: councilPayload,
        councilEnabledRepositoryIds: councilEnabledRepositoryIdsPayload,
        disableReviewMd: !useReviewMd,
        // GitLab-specific: auto-configure webhooks
        autoConfigureWebhooks: isGitLab ? autoConfigureWebhooks : undefined,
      });
    } else {
      personalSaveMutation.mutate({
        platform,
        reviewStyle,
        focusAreas,
        customInstructions: customInstructions.trim() || undefined,
        modelSlug: selectedModel,
        thinkingEffort,
        gateThreshold,
        repositorySelectionMode,
        selectedRepositoryIds,
        manuallyAddedRepositories,
        repositoryModelOverrides: repositoryModelOverridesPayload,
        disableReviewMd: !useReviewMd,
        // GitLab-specific: auto-configure webhooks
        autoConfigureWebhooks: isGitLab ? autoConfigureWebhooks : undefined,
      });
    }
  };

  const handleFocusAreaToggle = (areaId: string) => {
    setFocusAreas(prev =>
      prev.includes(areaId) ? prev.filter(id => id !== areaId) : [...prev, areaId]
    );
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Review Configuration
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-4">
            <div className="bg-muted h-20 rounded" />
            <div className="bg-muted h-32 rounded" />
            <div className="bg-muted h-20 rounded" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="mb-4">
        <CardTitle className="flex items-center gap-2">
          <Settings className="h-5 w-5" />
          Review Configuration
        </CardTitle>
        <CardDescription>
          Customize how Code Reviewer analyzes your {prLabel} and the AI model
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-8">
          {configData?.actionRequired && (
            <CodeReviewActionRequiredAlert
              actionRequired={configData.actionRequired}
              organizationId={organizationId}
              compact
            />
          )}

          {/* Enable/Disable Toggle */}
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="enable-agent" className="text-base font-semibold">
                Enable AI Code Review
              </Label>
              <p className="text-muted-foreground text-sm">
                Automatically review {prLabel} when they are opened or updated
              </p>
            </div>
            <Switch
              id="enable-agent"
              checked={isEnabled}
              onCheckedChange={handleToggle}
              disabled={orgToggleMutation.isPending || personalToggleMutation.isPending}
            />
          </div>

          {/* Configuration Fields */}
          <div className={cn('space-y-8', !isEnabled && 'pointer-events-none opacity-50')}>
            {/* Global Settings — defaults inherited by every repository unless overridden below. */}
            <div className="space-y-1">
              <h3 className="text-base font-semibold">Global Settings</h3>
              <p className="text-muted-foreground text-sm">
                Defaults applied to every repository unless overridden per repository below.
              </p>
            </div>

            {/* Default AI Model Selection */}
            <ModelCombobox
              label="Default AI Model"
              models={modelOptions}
              value={selectedModel}
              onValueChange={setSelectedModel}
              isLoading={isLoadingModels}
              helperText="Applies to all repositories unless overridden below"
            />

            {/* Thinking Effort — only shown when the model supports variants */}
            {availableVariants.length > 0 && (
              <div className="space-y-2">
                <Label>Thinking Effort</Label>
                <Select
                  value={thinkingEffort ?? '__default__'}
                  onValueChange={v => setThinkingEffort(v === '__default__' ? null : v)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">Default</SelectItem>
                    {availableVariants.map(variant => (
                      <SelectItem key={variant} value={variant}>
                        {thinkingEffortLabel(variant)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-sm">
                  Configure the model&apos;s reasoning intensity
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label>PR Gate Threshold</Label>
              <Select
                value={gateThreshold}
                onValueChange={v => setGateThreshold(v as 'off' | 'all' | 'warning' | 'critical')}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="all">All findings</SelectItem>
                  <SelectItem value="warning">Warnings and above</SelectItem>
                  <SelectItem value="critical">Critical issues only</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-sm">
                Controls when the PR status check reports a failure based on review findings
              </p>
            </div>

            {/* Review Style */}
            <div className="space-y-3">
              <Label>Review Style</Label>
              <RadioGroup
                value={reviewStyle}
                onValueChange={value =>
                  setReviewStyle(value as 'strict' | 'balanced' | 'lenient' | 'roast')
                }
              >
                {REVIEW_STYLES.map(style => (
                  <div key={style.value} className="flex items-start space-y-0 space-x-3">
                    <RadioGroupItem value={style.value} id={style.value} />
                    <div className="flex-1 space-y-1">
                      <Label htmlFor={style.value} className="font-medium">
                        {style.label}
                      </Label>
                      <p className="text-muted-foreground text-sm">{style.description}</p>
                    </div>
                  </div>
                ))}
              </RadioGroup>
            </div>

            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label htmlFor="use-review-md" className="text-base font-semibold">
                  Use REVIEW.md
                </Label>
                <p className="text-muted-foreground text-sm">
                  Load REVIEW.md from the base branch when present and use it for
                  repository-specific review guidance.
                </p>
                <Link
                  href={reviewMdGuideHref}
                  className="inline-flex text-sm text-blue-400 hover:text-blue-300"
                >
                  Learn about REVIEW.md
                </Link>
              </div>
              <Switch
                id="use-review-md"
                checked={useReviewMd}
                onCheckedChange={setUseReviewMd}
                disabled={orgSaveMutation.isPending || personalSaveMutation.isPending || !isEnabled}
              />
            </div>

            {/* Focus Areas (global) */}
            <div className="space-y-3">
              <Label>Focus Areas</Label>
              <p className="text-muted-foreground mb-3 text-sm">
                Select specific areas for the agent to pay special attention to
              </p>
              <div className="space-y-3">
                {FOCUS_AREAS.map(area => (
                  <div key={area.id} className="flex items-start space-x-3">
                    <Checkbox
                      id={area.id}
                      checked={focusAreas.includes(area.id)}
                      onCheckedChange={() => handleFocusAreaToggle(area.id)}
                    />
                    <div className="grid gap-1.5 leading-none">
                      <Label
                        htmlFor={area.id}
                        className="cursor-pointer leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                      >
                        {area.label}
                      </Label>
                      <p className="text-muted-foreground text-sm">{area.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Custom Instructions (global) */}
            <div className="space-y-3">
              <Label htmlFor="custom-instructions">Custom Instructions (Optional)</Label>
              <Textarea
                id="custom-instructions"
                placeholder="e.g., 'Always check for TypeScript strict mode compliance' or 'Focus on React best practices'"
                value={customInstructions}
                onChange={e => setCustomInstructions(e.target.value)}
                rows={4}
                className="resize-none"
              />
              <p className="text-muted-foreground text-sm">
                Add specific guidelines for your team's code review standards
              </p>
            </div>

            {/* Advanced Settings — one card holding the switch and, when on, the per-repository
                settings. GitLab has no "all" mode, so it is always Advanced (switch hidden). */}
            <div className="space-y-6 rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="advanced-settings" className="text-base font-semibold">
                    Advanced Settings
                  </Label>
                  <p className="text-muted-foreground text-sm">
                    Choose specific repositories and override the global defaults for each (model,
                    thinking effort, and council review). Off means every repository uses the global
                    settings above.
                  </p>
                </div>
                {!isGitLab && (
                  <Switch
                    id="advanced-settings"
                    checked={perRepoOverridesEnabled}
                    onCheckedChange={handlePerRepoOverridesToggle}
                    disabled={!isEnabled}
                  />
                )}
              </div>

              {/* Repository Selection (Advanced) — which repositories to review + configure. */}
              {perRepoOverridesEnabled && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Repositories</Label>
                      <p className="text-muted-foreground text-sm">
                        Choose which repositories to review and configure below. Others are not
                        reviewed.
                      </p>
                    </div>
                    {repositoriesData?.integrationInstalled && (
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground text-xs">
                          Last synced:{' '}
                          {repositoriesData.syncedAt
                            ? formatDistanceToNow(new Date(repositoriesData.syncedAt), {
                                addSuffix: true,
                              })
                            : 'Never'}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={refreshRepositories}
                          disabled={isRefreshingRepos || isLoadingRepositories}
                        >
                          <RefreshCw
                            className={cn('h-4 w-4', isRefreshingRepos && 'animate-spin')}
                          />
                        </Button>
                      </div>
                    )}
                  </div>

                  {isLoadingRepositories ? (
                    <div className="rounded-md border border-gray-600 bg-gray-800/50 p-3">
                      <p className="text-sm text-gray-400">Loading repositories...</p>
                    </div>
                  ) : repositoriesError ? (
                    <div className="rounded-md border border-red-500/50 bg-red-500/10 p-3">
                      <p className="text-sm text-red-200">
                        Failed to load repositories. Please try refreshing the page.
                      </p>
                    </div>
                  ) : !repositoriesData?.integrationInstalled ? (
                    <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3">
                      <p className="text-sm text-yellow-200">
                        {repositoriesData?.errorMessage ||
                          `${platformLabel} integration is not connected. Please connect ${platformLabel} in the Integrations page to configure repository selection.`}
                      </p>
                    </div>
                  ) : selectableRepositories.length === 0 ? (
                    <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3">
                      <p className="text-sm text-yellow-200">
                        No repositories found. Please ensure the {platformLabel}{' '}
                        {isGitLab ? 'integration' : 'App'} has access to your repositories.
                      </p>
                    </div>
                  ) : (
                    <RepositoryMultiSelect
                      repositories={selectableRepositories}
                      selectedIds={selectedRepositoryIds}
                      onSelectionChange={setSelectedRepositoryIds}
                    />
                  )}
                </div>
              )}

              {/* Per-repository model overrides — independent of the trigger selection
                mode above; applies whether reviews run on all or selected repos. */}
              {perRepoOverridesEnabled &&
                repositoriesData?.integrationInstalled &&
                selectedRepositories.length > 0 && (
                  <div className="space-y-4">
                    <div className="space-y-0.5">
                      <Label className="text-base font-semibold">Per-repository model</Label>
                      <p className="text-muted-foreground text-sm">
                        Optionally run specific repositories&apos; reviews on a different model or
                        effort than the global default.
                      </p>
                    </div>
                    <RepositoryModelOverrides
                      availableRepositories={selectedRepositories}
                      models={modelOptions}
                      isLoadingModels={isLoadingModels}
                      overrides={repositoryModelOverrides}
                      defaultModelSlug={selectedModel}
                      onSet={handleRepositoryModelOverrideSet}
                      onRemove={handleRepositoryModelOverrideRemove}
                      disabled={!isEnabled}
                    />

                    {/* Per-repository council opt-in + the shared specialist config it applies. */}
                    {councilUiEnabled &&
                      perRepoOverridesEnabled &&
                      selectedRepositories.length > 0 && (
                        <div className="space-y-4 rounded-lg border p-4">
                          <div className="space-y-0.5">
                            <Label className="text-base font-semibold">Council review</Label>
                            <p className="text-muted-foreground text-sm">
                              Choose which repositories run the council review (multiple
                              specialists, combined into one decision) on every pull request. Others
                              use the standard single reviewer.
                            </p>
                          </div>
                          <div className="divide-y rounded-md border">
                            {selectedRepositories.map(repo => (
                              <div
                                key={repo.id}
                                className="flex items-center justify-between gap-3 p-3"
                              >
                                <span className="truncate text-sm" title={repo.full_name}>
                                  {repo.full_name}
                                </span>
                                <Switch
                                  checked={councilEnabledRepositoryIds.has(repo.id)}
                                  onCheckedChange={checked =>
                                    handleCouncilRepoToggle(repo.id, checked)
                                  }
                                  disabled={!isEnabled || orgSaveMutation.isPending}
                                  aria-label={`Enable council review for ${repo.full_name}`}
                                />
                              </div>
                            ))}
                          </div>

                          {/* Shared specialists + governance — applied to every council-enabled repo. */}
                          {councilEnabled && (
                            <div className="space-y-4 border-t pt-4">
                              <p className="text-sm font-medium">
                                Specialists (applied to all council-enabled repositories)
                              </p>
                              <CouncilSpecialistPicker
                                selections={councilSelections}
                                onChange={setCouncilSelections}
                                modelOptions={modelOptions}
                                isLoadingModels={isLoadingModels}
                                disabled={orgSaveMutation.isPending}
                                defaultModelSlug={selectedModel}
                              />
                              <div className="space-y-2">
                                <Label htmlFor="council-aggregation">Governance decision</Label>
                                <Select
                                  value={councilAggregation}
                                  onValueChange={value =>
                                    setCouncilAggregation(value as CouncilAggregationStrategy)
                                  }
                                  disabled={orgSaveMutation.isPending}
                                >
                                  <SelectTrigger id="council-aggregation" className="w-full">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {COUNCIL_AGGREGATION_STRATEGIES.map(strategy => (
                                      <SelectItem key={strategy} value={strategy}>
                                        {formatAggregationStrategy(strategy)}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <p
                                  className={
                                    councilBelowMin
                                      ? 'text-destructive text-sm'
                                      : 'text-muted-foreground text-sm'
                                  }
                                >
                                  Select {COUNCIL_MIN_SPECIALISTS}–4 specialists.{' '}
                                  {councilEnabledCount} selected.
                                </p>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                  </div>
                )}
            </div>

            {/* GitLab Webhook Configuration */}
            {isGitLab &&
              repositorySelectionMode === 'selected' &&
              repositoriesData?.integrationInstalled && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Webhook className="text-muted-foreground h-4 w-4" />
                    <Label>Webhook Configuration</Label>
                  </div>
                  <div className="flex items-start space-x-3">
                    <Checkbox
                      id="auto-configure-webhooks"
                      checked={autoConfigureWebhooks}
                      onCheckedChange={checked => setAutoConfigureWebhooks(checked === true)}
                    />
                    <div className="grid gap-1.5 leading-none">
                      <Label
                        htmlFor="auto-configure-webhooks"
                        className="cursor-pointer leading-none font-medium"
                      >
                        Automatically configure webhooks
                      </Label>
                      <p className="text-muted-foreground text-sm">
                        Webhooks will be created when repositories are added and removed when they
                        are deselected.
                      </p>
                    </div>
                  </div>

                  {/* Webhook Sync Result */}
                  {webhookSyncResult && (
                    <div className="mt-3">
                      {webhookSyncResult.errors.length > 0 ? (
                        <Alert variant="destructive">
                          <AlertCircle className="h-4 w-4" />
                          <AlertTitle>Webhook Configuration Errors</AlertTitle>
                          <AlertDescription>
                            <p className="mb-2">
                              Some webhooks could not be configured. You may need to configure them
                              manually.
                            </p>
                            <ul className="list-disc pl-4 text-sm">
                              {webhookSyncResult.errors.map((err, idx) => (
                                <li key={idx}>
                                  Project {err.projectId}: {err.error}
                                </li>
                              ))}
                            </ul>
                          </AlertDescription>
                        </Alert>
                      ) : (
                        (webhookSyncResult.created > 0 ||
                          webhookSyncResult.updated > 0 ||
                          webhookSyncResult.deleted > 0) && (
                          <Alert>
                            <CheckCircle2 className="h-4 w-4" />
                            <AlertTitle>Webhooks Configured</AlertTitle>
                            <AlertDescription>
                              {webhookSyncResult.created > 0 && (
                                <span className="mr-3">{webhookSyncResult.created} created</span>
                              )}
                              {webhookSyncResult.updated > 0 && (
                                <span className="mr-3">{webhookSyncResult.updated} updated</span>
                              )}
                              {webhookSyncResult.deleted > 0 && (
                                <span>{webhookSyncResult.deleted} removed</span>
                              )}
                            </AlertDescription>
                          </Alert>
                        )
                      )}
                    </div>
                  )}

                  {/* Manual Webhook Setup - Expandable Section */}
                  <div className="mt-4">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowManualWebhookSetup(!showManualWebhookSetup)}
                      className="text-muted-foreground hover:text-foreground flex h-auto items-center gap-2 p-0 text-sm"
                    >
                      <ChevronDown
                        className={cn(
                          'h-4 w-4 transition-transform',
                          showManualWebhookSetup && 'rotate-180'
                        )}
                      />
                      {showManualWebhookSetup ? 'Hide' : 'Show'} manual webhook setup instructions
                    </Button>

                    {showManualWebhookSetup && (
                      <div className="mt-4 space-y-4 rounded-lg border p-4">
                        <p className="text-muted-foreground text-sm">
                          If automatic webhook configuration fails or you prefer to configure
                          webhooks manually, use the following details:
                        </p>

                        {/* Webhook URL */}
                        <div className="space-y-2">
                          <label className="text-sm font-medium">Webhook URL</label>
                          <div className="flex items-center gap-2">
                            <code className="bg-muted flex-1 rounded px-3 py-2 font-mono text-sm break-all">
                              {webhookUrl}
                            </code>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={handleCopyWebhookUrl}
                              className="shrink-0"
                            >
                              {copiedWebhookUrl ? (
                                <Check className="h-4 w-4 text-green-500" />
                              ) : (
                                <Copy className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </div>

                        {/* Secret Token */}
                        <div className="space-y-2">
                          <label className="text-sm font-medium">Secret Token</label>
                          {regeneratedSecret ? (
                            <>
                              <div className="flex items-center gap-2">
                                <code className="bg-muted flex-1 rounded px-3 py-2 font-mono text-sm break-all">
                                  {regeneratedSecret}
                                </code>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={handleCopyRegeneratedSecret}
                                  className="shrink-0"
                                >
                                  {copiedWebhookSecret ? (
                                    <Check className="h-4 w-4 text-green-500" />
                                  ) : (
                                    <Copy className="h-4 w-4" />
                                  )}
                                </Button>
                              </div>
                              <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-2">
                                <p className="text-xs text-yellow-200">
                                  <strong>Important:</strong> Copy this secret now! It won't be
                                  shown again. Update your GitLab webhook settings with this new
                                  secret.
                                </p>
                              </div>
                            </>
                          ) : gitlabStatusData?.integration?.webhookSecret ? (
                            <>
                              <div className="flex items-center gap-2">
                                <code className="bg-muted flex-1 rounded px-3 py-2 font-mono text-sm">
                                  ••••••••••••••••
                                </code>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={handleCopyWebhookSecret}
                                  className="shrink-0"
                                >
                                  {copiedWebhookSecret ? (
                                    <Check className="h-4 w-4 text-green-500" />
                                  ) : (
                                    <Copy className="h-4 w-4" />
                                  )}
                                </Button>
                              </div>
                              <p className="text-muted-foreground text-xs">
                                Use this secret token in your GitLab webhook configuration for
                                security.
                              </p>
                            </>
                          ) : (
                            <p className="text-muted-foreground text-sm">
                              No webhook secret configured. Click regenerate to create one.
                            </p>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleRegenerateSecret}
                            disabled={regenerateSecretMutation.isPending}
                            className="mt-2"
                          >
                            <RefreshCw
                              className={cn(
                                'mr-2 h-4 w-4',
                                regenerateSecretMutation.isPending && 'animate-spin'
                              )}
                            />
                            {regenerateSecretMutation.isPending
                              ? 'Regenerating...'
                              : 'Regenerate Secret'}
                          </Button>
                        </div>

                        {/* Setup Instructions */}
                        <div className="rounded-md border border-blue-500/30 bg-blue-500/10 p-3">
                          <p className="text-sm text-blue-200">
                            <strong>Setup Instructions:</strong>
                          </p>
                          <ol className="mt-2 list-inside list-decimal space-y-1 text-sm text-blue-200/80">
                            <li>Go to your GitLab project → Settings → Webhooks</li>
                            <li>Paste the Webhook URL above</li>
                            <li>Add the Secret Token for security</li>
                            <li>Select "Merge request events" as the trigger</li>
                            <li>Click "Add webhook"</li>
                          </ol>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

            {/* Save Button */}
            <div className="flex justify-end pt-2">
              <Button
                onClick={handleSave}
                disabled={orgSaveMutation.isPending || personalSaveMutation.isPending || !isEnabled}
              >
                <Save className="mr-2 h-4 w-4" />
                {orgSaveMutation.isPending || personalSaveMutation.isPending
                  ? 'Saving...'
                  : 'Save Configuration'}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
