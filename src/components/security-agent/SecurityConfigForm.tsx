'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import {
  SECURITY_AGENT_MODELS,
  DEFAULT_SECURITY_AGENT_MODEL,
} from '@/lib/security-agent/core/constants';

type SlaConfig = {
  critical: number;
  high: number;
  medium: number;
  low: number;
};

type AnalysisMode = 'auto' | 'shallow' | 'deep';

type AutoDismissConfidenceThreshold = 'high' | 'medium' | 'low';

type RepositoryData = {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
};

type SecurityConfigFormProps = {
  enabled: boolean;
  slaConfig: SlaConfig;
  repositorySelectionMode: 'all' | 'selected';
  selectedRepositoryIds: number[];
  modelSlug: string;
  analysisMode: AnalysisMode;
  autoDismissEnabled: boolean;
  autoDismissConfidenceThreshold: AutoDismissConfidenceThreshold;
  repositories: RepositoryData[];
  repositoriesSyncedAt?: string | null;
  isLoadingRepositories?: boolean;
  onSave: (
    config: SlaConfig & {
      repositorySelectionMode: 'all' | 'selected';
      selectedRepositoryIds: number[];
      modelSlug: string;
      analysisMode: AnalysisMode;
      autoDismissEnabled: boolean;
      autoDismissConfidenceThreshold: AutoDismissConfidenceThreshold;
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
  enabled,
  slaConfig,
  repositorySelectionMode: initialSelectionMode,
  selectedRepositoryIds: initialSelectedIds,
  modelSlug: initialModelSlug,
  analysisMode: initialAnalysisMode,
  autoDismissEnabled: initialAutoDismissEnabled,
  autoDismissConfidenceThreshold: initialAutoDismissThreshold,
  repositories,
  repositoriesSyncedAt,
  isLoadingRepositories,
  onSave,
  onToggleEnabled,
  onRefreshRepositories,
  isSaving,
  isToggling,
  isRefreshingRepositories,
}: SecurityConfigFormProps) {
  const [localConfig, setLocalConfig] = useState<SlaConfig>(slaConfig);
  const [repositorySelectionMode, setRepositorySelectionMode] = useState<'all' | 'selected'>(
    initialSelectionMode
  );
  const [selectedRepositoryIds, setSelectedRepositoryIds] = useState<number[]>(initialSelectedIds);
  const [selectedModel, setSelectedModel] = useState<string>(
    initialModelSlug || DEFAULT_SECURITY_AGENT_MODEL
  );
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>(initialAnalysisMode);
  const [autoDismissEnabled, setAutoDismissEnabled] = useState(initialAutoDismissEnabled);
  const [autoDismissConfidenceThreshold, setAutoDismissConfidenceThreshold] =
    useState<AutoDismissConfidenceThreshold>(initialAutoDismissThreshold);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    setLocalConfig(slaConfig);
    setRepositorySelectionMode(initialSelectionMode);
    setSelectedRepositoryIds(initialSelectedIds);
    setSelectedModel(initialModelSlug || DEFAULT_SECURITY_AGENT_MODEL);
    setAnalysisMode(initialAnalysisMode);
    setAutoDismissEnabled(initialAutoDismissEnabled);
    setAutoDismissConfidenceThreshold(initialAutoDismissThreshold);
    setHasChanges(false);
  }, [
    slaConfig,
    initialSelectionMode,
    initialSelectedIds,
    initialModelSlug,
    initialAnalysisMode,
    initialAutoDismissEnabled,
    initialAutoDismissThreshold,
  ]);

  const checkForChanges = useCallback(
    (
      newConfig: SlaConfig,
      newMode: 'all' | 'selected',
      newSelectedIds: number[],
      newModel: string,
      newAnalysisMode: AnalysisMode,
      newAutoDismissEnabled: boolean,
      newAutoDismissThreshold: AutoDismissConfidenceThreshold
    ) => {
      const configChanged =
        newConfig.critical !== slaConfig.critical ||
        newConfig.high !== slaConfig.high ||
        newConfig.medium !== slaConfig.medium ||
        newConfig.low !== slaConfig.low;

      const modeChanged = newMode !== initialSelectionMode;
      const idsChanged =
        JSON.stringify(newSelectedIds.sort()) !== JSON.stringify(initialSelectedIds.sort());
      const modelChanged = newModel !== (initialModelSlug || DEFAULT_SECURITY_AGENT_MODEL);
      const analysisModeChanged = newAnalysisMode !== initialAnalysisMode;
      const autoDismissEnabledChanged = newAutoDismissEnabled !== initialAutoDismissEnabled;
      const autoDismissThresholdChanged = newAutoDismissThreshold !== initialAutoDismissThreshold;

      setHasChanges(
        configChanged ||
          modeChanged ||
          idsChanged ||
          modelChanged ||
          analysisModeChanged ||
          autoDismissEnabledChanged ||
          autoDismissThresholdChanged
      );
    },
    [
      slaConfig,
      initialSelectionMode,
      initialSelectedIds,
      initialModelSlug,
      initialAnalysisMode,
      initialAutoDismissEnabled,
      initialAutoDismissThreshold,
    ]
  );

  const handleChange = (key: keyof SlaConfig, value: string) => {
    const numValue = parseInt(value, 10);
    if (isNaN(numValue) || numValue < 1) return;

    const newConfig = { ...localConfig, [key]: numValue };
    setLocalConfig(newConfig);
    checkForChanges(
      newConfig,
      repositorySelectionMode,
      selectedRepositoryIds,
      selectedModel,
      analysisMode,
      autoDismissEnabled,
      autoDismissConfidenceThreshold
    );
  };

  const handleSelectionModeChange = (mode: 'all' | 'selected') => {
    setRepositorySelectionMode(mode);
    checkForChanges(
      localConfig,
      mode,
      selectedRepositoryIds,
      selectedModel,
      analysisMode,
      autoDismissEnabled,
      autoDismissConfidenceThreshold
    );
  };

  const handleSelectedIdsChange = (ids: number[]) => {
    setSelectedRepositoryIds(ids);
    checkForChanges(
      localConfig,
      repositorySelectionMode,
      ids,
      selectedModel,
      analysisMode,
      autoDismissEnabled,
      autoDismissConfidenceThreshold
    );
  };

  const handleModelChange = (model: string) => {
    setSelectedModel(model);
    checkForChanges(
      localConfig,
      repositorySelectionMode,
      selectedRepositoryIds,
      model,
      analysisMode,
      autoDismissEnabled,
      autoDismissConfidenceThreshold
    );
  };

  const handleAnalysisModeChange = (mode: AnalysisMode) => {
    setAnalysisMode(mode);
    checkForChanges(
      localConfig,
      repositorySelectionMode,
      selectedRepositoryIds,
      selectedModel,
      mode,
      autoDismissEnabled,
      autoDismissConfidenceThreshold
    );
  };

  const handleAutoDismissEnabledChange = (newEnabled: boolean) => {
    setAutoDismissEnabled(newEnabled);
    checkForChanges(
      localConfig,
      repositorySelectionMode,
      selectedRepositoryIds,
      selectedModel,
      analysisMode,
      newEnabled,
      autoDismissConfidenceThreshold
    );
  };

  const handleAutoDismissThresholdChange = (threshold: AutoDismissConfidenceThreshold) => {
    setAutoDismissConfidenceThreshold(threshold);
    checkForChanges(
      localConfig,
      repositorySelectionMode,
      selectedRepositoryIds,
      selectedModel,
      analysisMode,
      autoDismissEnabled,
      threshold
    );
  };

  const handleSave = () => {
    onSave({
      ...localConfig,
      repositorySelectionMode,
      selectedRepositoryIds,
      modelSlug: selectedModel,
      analysisMode,
      autoDismissEnabled,
      autoDismissConfidenceThreshold,
    });
  };

  const handleReset = () => {
    setLocalConfig(DEFAULT_SLA_CONFIG);
    checkForChanges(
      DEFAULT_SLA_CONFIG,
      repositorySelectionMode,
      selectedRepositoryIds,
      selectedModel,
      analysisMode,
      autoDismissEnabled,
      autoDismissConfidenceThreshold
    );
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
                <CardTitle className="text-lg font-bold">AI Model</CardTitle>
                <p className="text-muted-foreground text-xs">
                  Choose the AI model to use for security analysis
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <Label htmlFor="model-select">Analysis Model</Label>
              <Select value={selectedModel} onValueChange={handleModelChange}>
                <SelectTrigger id="model-select" className="w-full">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {SECURITY_AGENT_MODELS.map(model => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                This model will be used when analyzing security findings
              </p>
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
          <CardContent className="space-y-3">
            <RadioGroup
              value={analysisMode}
              onValueChange={value => handleAnalysisModeChange(value as AnalysisMode)}
              className="space-y-3"
            >
              {ANALYSIS_MODE_OPTIONS.map(option => (
                <div key={option.value} className="flex items-start space-x-3">
                  <RadioGroupItem value={option.value} id={`analysis-mode-${option.value}`} />
                  <div className="space-y-1">
                    <Label
                      htmlFor={`analysis-mode-${option.value}`}
                      className="cursor-pointer font-normal"
                    >
                      {option.label}
                    </Label>
                    <p className="text-muted-foreground text-xs">{option.description}</p>
                  </div>
                </div>
              ))}
            </RadioGroup>
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
                  className="space-y-3"
                >
                  {CONFIDENCE_THRESHOLD_OPTIONS.map(option => (
                    <div key={option.value} className="flex items-start space-x-3">
                      <RadioGroupItem value={option.value} id={`threshold-${option.value}`} />
                      <div className="space-y-1">
                        <Label
                          htmlFor={`threshold-${option.value}`}
                          className="cursor-pointer font-normal"
                        >
                          {option.label}
                        </Label>
                        <p className="text-muted-foreground text-xs">{option.description}</p>
                      </div>
                    </div>
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
            {SEVERITY_INFO.map(({ key, label, description, icon: Icon, color }) => (
              <div key={key} className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Icon className={`mt-0.5 h-5 w-5 ${color}`} />
                  <div>
                    <Label htmlFor={`sla-${key}`} className="font-medium">
                      {label}
                    </Label>
                    <p className="text-muted-foreground text-sm">{description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
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
