'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Save,
  Clock,
  AlertTriangle,
  AlertCircle,
  Info,
  Settings,
  Loader2,
  RefreshCw,
  Bot,
  ScanSearch,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import {
  RepositoryMultiSelect,
  type Repository,
} from '@/components/code-reviews/RepositoryMultiSelect';
import { ModelCombobox } from '@/components/shared/ModelCombobox';
import { useOrganizationModels } from '@/components/cloud-agent/hooks/useOrganizationModels';
import {
  DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
  DEFAULT_SECURITY_AGENT_TRIAGE_MODEL,
} from '@/lib/security-agent/core/constants';

type SlaConfig = {
  critical: number;
  high: number;
  medium: number;
  low: number;
};

type AnalysisMode = 'auto' | 'shallow' | 'deep';

type AutoDismissConfidenceThreshold = 'high' | 'medium' | 'low';

type AutoAnalysisMinSeverity = 'critical' | 'high' | 'medium' | 'all';

type RepositoryData = {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
};

type SecurityConfigFormProps = {
  organizationId?: string;
  enabled: boolean;
  slaConfig: SlaConfig;
  repositorySelectionMode: 'all' | 'selected';
  selectedRepositoryIds: number[];
  modelSlug?: string;
  triageModelSlug?: string;
  analysisModelSlug?: string;
  analysisMode: AnalysisMode;
  autoDismissEnabled: boolean;
  autoDismissConfidenceThreshold: AutoDismissConfidenceThreshold;
  autoAnalysisEnabled: boolean;
  autoAnalysisMinSeverity: AutoAnalysisMinSeverity;
  autoAnalysisIncludeExisting: boolean;
  repositories: RepositoryData[];
  repositoriesSyncedAt?: string | null;
  isLoadingRepositories?: boolean;
  onSave: (
    config: SlaConfig & {
      repositorySelectionMode: 'all' | 'selected';
      selectedRepositoryIds: number[];
      triageModelSlug: string;
      analysisModelSlug: string;
      modelSlug?: string;
      analysisMode: AnalysisMode;
      autoDismissEnabled: boolean;
      autoDismissConfidenceThreshold: AutoDismissConfidenceThreshold;
      autoAnalysisEnabled: boolean;
      autoAnalysisMinSeverity: AutoAnalysisMinSeverity;
      autoAnalysisIncludeExisting: boolean;
    }
  ) => void;
  onToggleEnabled: (
    enabled: boolean,
    repositorySelection: {
      repositorySelectionMode: 'all' | 'selected';
      selectedRepositoryIds: number[];
    }
  ) => void;
  onRefreshRepositories?: () => void;
  onHasChangesChange?: (hasChanges: boolean) => void;
  isSaving: boolean;
  isToggling: boolean;
  isRefreshingRepositories?: boolean;
};

const DEFAULT_SLA_CONFIG: SlaConfig = {
  critical: 15,
  high: 30,
  medium: 45,
  low: 90,
};

const ANALYSIS_MODE_OPTIONS = [
  {
    value: 'auto' as const,
    label: 'Auto',
    description:
      'Triage runs first; sandbox analysis runs only if triage determines it is needed (default)',
  },
  {
    value: 'shallow' as const,
    label: 'Shallow (triage only)',
    description:
      'Only the quick triage step runs. No sandbox analysis is performed, saving time and credits',
  },
  {
    value: 'deep' as const,
    label: 'Deep (always sandbox)',
    description:
      'Always runs full sandbox analysis for every finding, providing the most thorough results',
  },
];

const CONFIDENCE_THRESHOLD_OPTIONS = [
  {
    value: 'high' as const,
    label: 'High confidence only',
    description: 'Only auto-dismiss when the AI is highly confident the finding is not exploitable',
  },
  {
    value: 'medium' as const,
    label: 'Medium or higher',
    description: 'Auto-dismiss when the AI has medium or high confidence',
  },
  {
    value: 'low' as const,
    label: 'Any confidence',
    description: 'Auto-dismiss all findings the AI recommends dismissing (use with caution)',
  },
];

const AUTO_ANALYSIS_MIN_SEVERITY_OPTIONS = [
  {
    value: 'critical' as const,
    label: 'Critical only',
    description: 'Only auto-analyse findings with critical severity',
  },
  {
    value: 'high' as const,
    label: 'High and above',
    description: 'Auto-analyse findings with high or critical severity',
  },
  {
    value: 'medium' as const,
    label: 'Medium and above',
    description: 'Auto-analyse findings with medium, high, or critical severity',
  },
  {
    value: 'all' as const,
    label: 'All severities',
    description: 'Auto-analyse all findings regardless of severity',
  },
];

const SEVERITY_INFO = [
  {
    key: 'critical' as const,
    label: 'Critical',
    description: 'Vulnerabilities that can be exploited remotely with no authentication',
    icon: AlertTriangle,
    color: 'text-red-500',
  },
  {
    key: 'high' as const,
    label: 'High',
    description: 'Vulnerabilities that could lead to significant data exposure',
    icon: AlertCircle,
    color: 'text-orange-500',
  },
  {
    key: 'medium' as const,
    label: 'Medium',
    description: 'Vulnerabilities with limited impact or requiring specific conditions',
    icon: Info,
    color: 'text-yellow-500',
  },
  {
    key: 'low' as const,
    label: 'Low',
    description: 'Minor vulnerabilities with minimal security impact',
    icon: Info,
    color: 'text-blue-500',
  },
];

export function SecurityConfigForm({
  organizationId,
  enabled,
  slaConfig,
  repositorySelectionMode: initialSelectionMode,
  selectedRepositoryIds: initialSelectedIds,
  modelSlug: initialModelSlug,
  triageModelSlug: initialTriageModelSlug,
  analysisModelSlug: initialAnalysisModelSlug,
  analysisMode: initialAnalysisMode,
  autoDismissEnabled: initialAutoDismissEnabled,
  autoDismissConfidenceThreshold: initialAutoDismissThreshold,
  autoAnalysisEnabled: initialAutoAnalysisEnabled,
  autoAnalysisMinSeverity: initialAutoAnalysisMinSeverity,
  autoAnalysisIncludeExisting: initialAutoAnalysisIncludeExisting,
  repositories,
  repositoriesSyncedAt,
  isLoadingRepositories,
  onSave,
  onToggleEnabled,
  onRefreshRepositories,
  onHasChangesChange,
  isSaving,
  isToggling,
  isRefreshingRepositories,
}: SecurityConfigFormProps) {
  const { modelOptions, isLoadingModels } = useOrganizationModels(organizationId);

  const initialTriageModel =
    initialTriageModelSlug || initialModelSlug || DEFAULT_SECURITY_AGENT_TRIAGE_MODEL;
  const initialAnalysisModel =
    initialAnalysisModelSlug || initialModelSlug || DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL;

  const [localConfig, setLocalConfig] = useState<SlaConfig>(slaConfig);
  const [repositorySelectionMode, setRepositorySelectionMode] = useState<'all' | 'selected'>(
    initialSelectionMode
  );
  const [selectedRepositoryIds, setSelectedRepositoryIds] = useState<number[]>(initialSelectedIds);
  const [selectedTriageModel, setSelectedTriageModel] = useState<string>(initialTriageModel);
  const [selectedAnalysisModel, setSelectedAnalysisModel] = useState<string>(initialAnalysisModel);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>(initialAnalysisMode);
  const [autoDismissEnabled, setAutoDismissEnabled] = useState(initialAutoDismissEnabled);
  const [autoDismissConfidenceThreshold, setAutoDismissConfidenceThreshold] =
    useState<AutoDismissConfidenceThreshold>(initialAutoDismissThreshold);
  const [autoAnalysisEnabled, setAutoAnalysisEnabled] = useState(initialAutoAnalysisEnabled);
  const [autoAnalysisMinSeverity, setAutoAnalysisMinSeverity] = useState<AutoAnalysisMinSeverity>(
    initialAutoAnalysisMinSeverity
  );
  const [autoAnalysisIncludeExisting, setAutoAnalysisIncludeExisting] = useState(
    initialAutoAnalysisIncludeExisting
  );
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    onHasChangesChange?.(hasChanges);
  }, [hasChanges, onHasChangesChange]);

  useEffect(() => {
    setLocalConfig(slaConfig);
    setRepositorySelectionMode(initialSelectionMode);
    setSelectedRepositoryIds(initialSelectedIds);
    setSelectedTriageModel(initialTriageModel);
    setSelectedAnalysisModel(initialAnalysisModel);
    setAnalysisMode(initialAnalysisMode);
    setAutoDismissEnabled(initialAutoDismissEnabled);
    setAutoDismissConfidenceThreshold(initialAutoDismissThreshold);
    setAutoAnalysisEnabled(initialAutoAnalysisEnabled);
    setAutoAnalysisMinSeverity(initialAutoAnalysisMinSeverity);
    setAutoAnalysisIncludeExisting(initialAutoAnalysisIncludeExisting);
    setHasChanges(false);
  }, [
    slaConfig,
    initialSelectionMode,
    initialSelectedIds,
    initialTriageModel,
    initialAnalysisModel,
    initialAnalysisMode,
    initialAutoDismissEnabled,
    initialAutoDismissThreshold,
    initialAutoAnalysisEnabled,
    initialAutoAnalysisMinSeverity,
    initialAutoAnalysisIncludeExisting,
  ]);

  type FormState = {
    config: SlaConfig;
    repositorySelectionMode: 'all' | 'selected';
    selectedRepositoryIds: number[];
    triageModel: string;
    analysisModel: string;
    analysisMode: AnalysisMode;
    autoDismissEnabled: boolean;
    autoDismissConfidenceThreshold: AutoDismissConfidenceThreshold;
    autoAnalysisEnabled: boolean;
    autoAnalysisMinSeverity: AutoAnalysisMinSeverity;
    autoAnalysisIncludeExisting: boolean;
  };

  const currentFormState = (): FormState => ({
    config: localConfig,
    repositorySelectionMode,
    selectedRepositoryIds,
    triageModel: selectedTriageModel,
    analysisModel: selectedAnalysisModel,
    analysisMode,
    autoDismissEnabled,
    autoDismissConfidenceThreshold,
    autoAnalysisEnabled,
    autoAnalysisMinSeverity,
    autoAnalysisIncludeExisting,
  });

  const checkForChanges = useCallback(
    (s: FormState) => {
      const changed =
        s.config.critical !== slaConfig.critical ||
        s.config.high !== slaConfig.high ||
        s.config.medium !== slaConfig.medium ||
        s.config.low !== slaConfig.low ||
        s.repositorySelectionMode !== initialSelectionMode ||
        JSON.stringify([...s.selectedRepositoryIds].sort()) !==
          JSON.stringify([...initialSelectedIds].sort()) ||
        s.triageModel !== initialTriageModel ||
        s.analysisModel !== initialAnalysisModel ||
        s.analysisMode !== initialAnalysisMode ||
        s.autoDismissEnabled !== initialAutoDismissEnabled ||
        s.autoDismissConfidenceThreshold !== initialAutoDismissThreshold ||
        s.autoAnalysisEnabled !== initialAutoAnalysisEnabled ||
        s.autoAnalysisMinSeverity !== initialAutoAnalysisMinSeverity ||
        s.autoAnalysisIncludeExisting !== initialAutoAnalysisIncludeExisting;

      setHasChanges(changed);
    },
    [
      slaConfig,
      initialSelectionMode,
      initialSelectedIds,
      initialTriageModel,
      initialAnalysisModel,
      initialAnalysisMode,
      initialAutoDismissEnabled,
      initialAutoDismissThreshold,
      initialAutoAnalysisEnabled,
      initialAutoAnalysisMinSeverity,
      initialAutoAnalysisIncludeExisting,
    ]
  );

  const handleChange = (key: keyof SlaConfig, value: string) => {
    const numValue = parseInt(value, 10);
    if (isNaN(numValue) || numValue < 1) return;

    const newConfig = { ...localConfig, [key]: numValue };
    setLocalConfig(newConfig);
    checkForChanges({ ...currentFormState(), config: newConfig });
  };

  const handleSelectionModeChange = (mode: 'all' | 'selected') => {
    setRepositorySelectionMode(mode);
    checkForChanges({ ...currentFormState(), repositorySelectionMode: mode });
  };

  const handleSelectedIdsChange = (ids: number[]) => {
    setSelectedRepositoryIds(ids);
    checkForChanges({ ...currentFormState(), selectedRepositoryIds: ids });
  };

  const handleTriageModelChange = (model: string) => {
    setSelectedTriageModel(model);
    checkForChanges({ ...currentFormState(), triageModel: model });
  };

  const handleAnalysisModelChange = (model: string) => {
    setSelectedAnalysisModel(model);
    checkForChanges({ ...currentFormState(), analysisModel: model });
  };

  const handleAnalysisModeChange = (mode: AnalysisMode) => {
    setAnalysisMode(mode);
    checkForChanges({ ...currentFormState(), analysisMode: mode });
  };

  const handleAutoDismissEnabledChange = (newEnabled: boolean) => {
    setAutoDismissEnabled(newEnabled);
    checkForChanges({ ...currentFormState(), autoDismissEnabled: newEnabled });
  };

  const handleAutoDismissThresholdChange = (threshold: AutoDismissConfidenceThreshold) => {
    setAutoDismissConfidenceThreshold(threshold);
    checkForChanges({ ...currentFormState(), autoDismissConfidenceThreshold: threshold });
  };

  const handleAutoAnalysisEnabledChange = (newEnabled: boolean) => {
    setAutoAnalysisEnabled(newEnabled);
    checkForChanges({ ...currentFormState(), autoAnalysisEnabled: newEnabled });
  };

  const handleAutoAnalysisMinSeverityChange = (severity: AutoAnalysisMinSeverity) => {
    setAutoAnalysisMinSeverity(severity);
    checkForChanges({ ...currentFormState(), autoAnalysisMinSeverity: severity });
  };

  const handleAutoAnalysisIncludeExistingChange = (newIncludeExisting: boolean) => {
    setAutoAnalysisIncludeExisting(newIncludeExisting);
    checkForChanges({ ...currentFormState(), autoAnalysisIncludeExisting: newIncludeExisting });
  };

  const handleSave = () => {
    onSave({
      ...localConfig,
      repositorySelectionMode,
      selectedRepositoryIds,
      triageModelSlug: selectedTriageModel,
      analysisModelSlug: selectedAnalysisModel,
      modelSlug: selectedAnalysisModel,
      analysisMode,
      autoDismissEnabled,
      autoDismissConfidenceThreshold,
      autoAnalysisEnabled,
      autoAnalysisMinSeverity,
      autoAnalysisIncludeExisting,
    });
  };

  const handleReset = () => {
    setLocalConfig(DEFAULT_SLA_CONFIG);
    checkForChanges({ ...currentFormState(), config: DEFAULT_SLA_CONFIG });
  };

  // Map repositories to the format expected by RepositoryMultiSelect
  const mappedRepositories: Repository[] = repositories.map(repo => ({
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
  }));

  // Calculate the number of repositories that will be monitored
  const monitoredRepoCount =
    repositorySelectionMode === 'all' ? repositories.length : selectedRepositoryIds.length;

  return (
    <div className="space-y-6">
      {/* Repository Selection Card - shown first so users know what they're enabling */}
      <Card className="w-full">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/20">
                <Settings className="h-5 w-5 text-purple-400" />
              </div>
              <div>
                <CardTitle className="text-lg font-bold">Repository Selection</CardTitle>
                <p className="text-muted-foreground text-xs">
                  Choose which repositories should be monitored for security alerts
                </p>
              </div>
            </div>
            {onRefreshRepositories && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">
                  Last synced:{' '}
                  {repositoriesSyncedAt
                    ? formatDistanceToNow(new Date(repositoriesSyncedAt), {
                        addSuffix: true,
                      })
                    : 'Never'}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRefreshRepositories}
                  disabled={isRefreshingRepositories || isLoadingRepositories}
                >
                  <RefreshCw
                    className={cn('h-4 w-4', isRefreshingRepositories && 'animate-spin')}
                  />
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoadingRepositories ? (
            <div className="rounded-md border border-gray-600 bg-gray-800/50 p-3">
              <p className="text-sm text-gray-400">Loading repositories...</p>
            </div>
          ) : repositories.length === 0 ? (
            <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3">
              <p className="text-sm text-yellow-200">
                No repositories found. Please ensure the GitHub App has access to your repositories.
              </p>
            </div>
          ) : (
            <>
              <RadioGroup
                value={repositorySelectionMode}
                onValueChange={value => handleSelectionModeChange(value as 'all' | 'selected')}
                className="space-y-3"
              >
                <div className="flex items-center space-x-3">
                  <RadioGroupItem value="all" id="all-repos" />
                  <Label htmlFor="all-repos" className="cursor-pointer font-normal">
                    All repositories ({repositories.length})
                  </Label>
                </div>
                <div className="flex items-start space-x-3">
                  <RadioGroupItem value="selected" id="selected-repos" className="mt-1" />
                  <Label htmlFor="selected-repos" className="cursor-pointer font-normal">
                    Selected repositories
                  </Label>
                </div>
              </RadioGroup>

              {repositorySelectionMode === 'selected' && (
                <div className="mt-4">
                  <RepositoryMultiSelect
                    repositories={mappedRepositories}
                    selectedIds={selectedRepositoryIds}
                    onSelectionChange={handleSelectedIdsChange}
                  />
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Enable/Disable Card - now shows which repos will be monitored */}
      <Card className="w-full">
        <CardHeader className="pb-3">
          <div className="flex items-center space-x-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/20">
              <Settings className="h-5 w-5 text-green-400" />
            </div>
            <div>
              <CardTitle className="text-lg font-bold">Security Agent</CardTitle>
              <p className="text-muted-foreground text-xs">
                Enable automatic syncing of Dependabot alerts and SLA tracking
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900/50 p-4">
            <div className="space-y-1">
              <Label htmlFor="enabled" className="font-medium">
                Enable Security Agent
              </Label>
              <p className="text-muted-foreground text-sm">
                {monitoredRepoCount > 0
                  ? `Dependabot alerts will be synced every 6 hours for ${monitoredRepoCount} ${monitoredRepoCount === 1 ? 'repository' : 'repositories'}`
                  : 'Select repositories above to enable Security Agent'}
              </p>
            </div>
            <Switch
              id="enabled"
              checked={enabled}
              onCheckedChange={newEnabled =>
                onToggleEnabled(newEnabled, {
                  repositorySelectionMode,
                  selectedRepositoryIds,
                })
              }
              disabled={isToggling || monitoredRepoCount === 0}
            />
          </div>
        </CardContent>
      </Card>

      {/* AI Model Selection Card - only show when enabled */}
      {enabled && (
        <Card className="w-full">
          <CardHeader className="pb-3">
            <div className="flex items-center space-x-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-500/20">
                <Bot className="h-5 w-5 text-cyan-400" />
              </div>
              <div>
                <CardTitle className="text-lg font-bold">AI Models</CardTitle>
                <p className="text-muted-foreground text-xs">
                  Configure dedicated models for quick triage and deep analysis
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="flex flex-col justify-between rounded-lg border border-gray-800 bg-gray-900/50 p-4">
                <ModelCombobox
                  label="Triage Model"
                  models={modelOptions}
                  value={selectedTriageModel}
                  onValueChange={handleTriageModelChange}
                  isLoading={isLoadingModels}
                  helperText="Used for initial triage and exploitability recommendation"
                />
              </div>

              <div className="flex flex-col justify-between rounded-lg border border-gray-800 bg-gray-900/50 p-4">
                <ModelCombobox
                  label="Analysis Model"
                  models={modelOptions}
                  value={selectedAnalysisModel}
                  onValueChange={handleAnalysisModelChange}
                  isLoading={isLoadingModels}
                  helperText="Used for sandbox/codebase analysis and final extraction"
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Analysis Mode Card - only show when enabled */}
      {enabled && (
        <Card className="w-full">
          <CardHeader className="pb-3">
            <div className="flex items-center space-x-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-500/20">
                <ScanSearch className="h-5 w-5 text-indigo-400" />
              </div>
              <div>
                <CardTitle className="text-lg font-bold">Analysis Mode</CardTitle>
                <p className="text-muted-foreground text-xs">
                  Control the depth of vulnerability analysis
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <RadioGroup
              value={analysisMode}
              onValueChange={value => handleAnalysisModeChange(value as AnalysisMode)}
              className="grid grid-cols-1 gap-3 md:grid-cols-3"
            >
              {ANALYSIS_MODE_OPTIONS.map(option => (
                <Label
                  key={option.value}
                  htmlFor={`analysis-mode-${option.value}`}
                  className={cn(
                    'flex cursor-pointer items-start space-x-3 rounded-lg border p-4 transition-colors',
                    analysisMode === option.value
                      ? 'border-indigo-500 bg-indigo-500/10'
                      : 'border-gray-800 bg-gray-900/50 hover:border-gray-700'
                  )}
                >
                  <RadioGroupItem
                    value={option.value}
                    id={`analysis-mode-${option.value}`}
                    className="mt-0.5"
                  />
                  <div className="space-y-1">
                    <span className="font-medium">{option.label}</span>
                    <p className="text-muted-foreground text-xs">{option.description}</p>
                  </div>
                </Label>
              ))}
            </RadioGroup>
          </CardContent>
        </Card>
      )}

      {/* Auto-Analysis Configuration Card - only show when enabled */}
      {enabled && (
        <Card className="w-full">
          <CardHeader className="pb-3">
            <div className="flex items-center space-x-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-500/20">
                <ScanSearch className="h-5 w-5 text-teal-400" />
              </div>
              <div>
                <CardTitle className="text-lg font-bold">Auto-Analysis</CardTitle>
                <p className="text-muted-foreground text-xs">
                  Automatically analyse new findings as they are synced
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900/50 p-4">
              <div className="space-y-1">
                <Label htmlFor="auto-analysis-enabled" className="font-medium">
                  Enable Auto-Analysis
                </Label>
                <p className="text-muted-foreground text-sm">
                  When enabled, new findings will be automatically triaged and analysed based on the
                  analysis mode configured above
                </p>
              </div>
              <Switch
                id="auto-analysis-enabled"
                checked={autoAnalysisEnabled}
                onCheckedChange={handleAutoAnalysisEnabledChange}
              />
            </div>

            {autoAnalysisEnabled && (
              <div className="space-y-3">
                <Label>Minimum Severity</Label>
                <RadioGroup
                  value={autoAnalysisMinSeverity}
                  onValueChange={value =>
                    handleAutoAnalysisMinSeverityChange(value as AutoAnalysisMinSeverity)
                  }
                  className="grid grid-cols-1 gap-3 md:grid-cols-4"
                >
                  {AUTO_ANALYSIS_MIN_SEVERITY_OPTIONS.map(option => (
                    <Label
                      key={option.value}
                      htmlFor={`auto-analysis-severity-${option.value}`}
                      className={cn(
                        'flex cursor-pointer items-start space-x-3 rounded-lg border p-4 transition-colors',
                        autoAnalysisMinSeverity === option.value
                          ? 'border-teal-500 bg-teal-500/10'
                          : 'border-gray-800 bg-gray-900/50 hover:border-gray-700'
                      )}
                    >
                      <RadioGroupItem
                        value={option.value}
                        id={`auto-analysis-severity-${option.value}`}
                        className="mt-0.5"
                      />
                      <div className="space-y-1">
                        <span className="font-medium">{option.label}</span>
                        <p className="text-muted-foreground text-xs">{option.description}</p>
                      </div>
                    </Label>
                  ))}
                </RadioGroup>
              </div>
            )}

            {autoAnalysisEnabled && (
              <div className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900/50 p-4">
                <div className="space-y-1">
                  <Label htmlFor="auto-analysis-include-existing" className="font-medium">
                    Include Existing Findings
                  </Label>
                  <p className="text-muted-foreground text-sm">
                    Also analyse findings that were synced before auto-analysis was enabled. This
                    may use additional credits if there are many existing findings.
                  </p>
                </div>
                <Switch
                  id="auto-analysis-include-existing"
                  checked={autoAnalysisIncludeExisting}
                  onCheckedChange={handleAutoAnalysisIncludeExistingChange}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Auto-Dismiss Configuration Card - only show when enabled */}
      {enabled && (
        <Card className="w-full">
          <CardHeader className="pb-3">
            <div className="flex items-center space-x-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/20">
                <AlertTriangle className="h-5 w-5 text-amber-400" />
              </div>
              <div>
                <CardTitle className="text-lg font-bold">Auto-Dismiss</CardTitle>
                <p className="text-muted-foreground text-xs">
                  Automatically dismiss findings that the AI determines are not exploitable
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900/50 p-4">
              <div className="space-y-1">
                <Label htmlFor="auto-dismiss-enabled" className="font-medium">
                  Enable Auto-Dismiss
                </Label>
                <p className="text-muted-foreground text-sm">
                  When enabled, findings recommended for dismissal by the AI will be automatically
                  dismissed
                </p>
              </div>
              <Switch
                id="auto-dismiss-enabled"
                checked={autoDismissEnabled}
                onCheckedChange={handleAutoDismissEnabledChange}
              />
            </div>

            {autoDismissEnabled && (
              <div className="space-y-3">
                <Label>Confidence Threshold</Label>
                <RadioGroup
                  value={autoDismissConfidenceThreshold}
                  onValueChange={value =>
                    handleAutoDismissThresholdChange(value as AutoDismissConfidenceThreshold)
                  }
                  className="grid grid-cols-1 gap-3 md:grid-cols-3"
                >
                  {CONFIDENCE_THRESHOLD_OPTIONS.map(option => (
                    <Label
                      key={option.value}
                      htmlFor={`threshold-${option.value}`}
                      className={cn(
                        'flex cursor-pointer items-start space-x-3 rounded-lg border p-4 transition-colors',
                        autoDismissConfidenceThreshold === option.value
                          ? 'border-amber-500 bg-amber-500/10'
                          : 'border-gray-800 bg-gray-900/50 hover:border-gray-700'
                      )}
                    >
                      <RadioGroupItem
                        value={option.value}
                        id={`threshold-${option.value}`}
                        className="mt-0.5"
                      />
                      <div className="space-y-1">
                        <span className="font-medium">{option.label}</span>
                        <p className="text-muted-foreground text-xs">{option.description}</p>
                      </div>
                    </Label>
                  ))}
                </RadioGroup>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* SLA Configuration Card - only show when enabled */}
      {enabled && (
        <Card className="w-full">
          <CardHeader className="pb-3">
            <div className="flex items-center space-x-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/20">
                <Clock className="h-5 w-5 text-blue-400" />
              </div>
              <div>
                <CardTitle className="text-lg font-bold">SLA Configuration</CardTitle>
                <p className="text-muted-foreground text-xs">
                  Set the number of days to remediate vulnerabilities by severity level
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              {SEVERITY_INFO.map(({ key, label, description, icon: Icon, color }) => (
                <div
                  key={key}
                  className="flex flex-col justify-between rounded-lg border border-gray-800 bg-gray-900/50 p-4"
                >
                  <div className="flex items-start gap-3">
                    <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${color}`} />
                    <div>
                      <Label htmlFor={`sla-${key}`} className="font-medium">
                        {label}
                      </Label>
                      <p className="text-muted-foreground text-xs">{description}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2 pl-8">
                    <Input
                      id={`sla-${key}`}
                      type="number"
                      min={1}
                      max={365}
                      value={localConfig[key]}
                      onChange={e => handleChange(key, e.target.value)}
                      className="w-20 text-center"
                      disabled={!enabled}
                    />
                    <span className="text-muted-foreground text-sm">days</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-between border-t border-gray-800 pt-4">
              <Button variant="outline" onClick={handleReset} disabled={!enabled || isSaving}>
                Reset to Defaults
              </Button>
              <Button onClick={handleSave} disabled={!enabled || !hasChanges || isSaving}>
                {isSaving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                {isSaving ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export type { SlaConfig };
